# Embeddings, cosine similarity & ranking — Q&A

A deep-dive into how vector embeddings and trigram matching power the title/company
**filters**, and why the match score is **skill coverage only** in
[`lib/search.ts`](../lib/search.ts). Companion to [`docs/search.md`](./search.md),
which covers the end-to-end flow.

> **Note:** title, company, and experience are *filters* (which jobs qualify);
> the displayed badge % is purely `matched skills / job's required-skill count`.
> There is no longer a weighted-sum ranking — the old `WEIGHTS` constant was
> removed. Several answers below explain why each signal sits where it does.

---

## Q1. How are embeddings stored — what fields, and what's the retrieval logic?

**Storage** — a single column on the `Job` row (no separate embeddings table,
no per-field vectors):

```prisma
// prisma/schema.prisma
// 384-dim vector from Xenova/all-MiniLM-L6-v2 over a composite of
// title + roleType + summary + skills.
embedding  Unsupported("vector(384)")?
```

- pgvector `vector(384)` column, nullable.
- Computed **once at import time** ([`prisma/import-jobs.ts`](../prisma/import-jobs.ts))
  over one concatenated string:
  ```
  "${jobTitle}. ${roleType}. ${roleSummary}. Skills: ${requiredSkills}"
  ```
  The whole posting is squashed into **one** vector — the title is not embedded
  separately from the skills; it's all baked together.
- Model: `Xenova/all-MiniLM-L6-v2` — 384-dim, mean-pooled, L2-normalized,
  runs in-process via WASM ([`lib/embeddings.ts`](../lib/embeddings.ts)).
- Indexed by `job_embedding_hnsw` (HNSW, `vector_cosine_ops`) for fast ANN lookup.
- `Company` has **no** embedding.

**Retrieval** — only the **title path** touches vectors
([`lib/search.ts`](../lib/search.ts)). The score is *not* stored; cosine distance
is computed live in SQL against each job's stored vector:

```sql
SELECT id, (1 - (embedding <=> $vec::vector)) AS score
FROM "Job" WHERE embedding IS NOT NULL
ORDER BY embedding <=> $vec::vector LIMIT 200
```

`<=>` is pgvector's cosine *distance* (0 = identical, 2 = opposite).
`1 - distance` flips it into a *similarity* in roughly `[0,1]` for normalized
vectors. Query vectors are LRU-cached (max 500). The vector tier has **no
similarity floor** — it always returns the 200 nearest. Those scores only decide
title-filter *membership*; the surviving rows are then ordered by skill coverage
(and, when skills are present, rows with zero coverage are dropped).

---

## Q2. Do we need trigram search? Can't embeddings handle everything?

**Yes — keep trigram.** Embeddings alone are not sufficient for this data:

1. **Company matching has no embedding at all.** `matchCompanyIds` is pure
   exact → trigram. There's no company vector to fall back on. Remove trigram and
   company search breaks entirely — you'd have to build a whole company-embedding
   pipeline to replace something that already works in ~1ms.

2. **Embeddings are bad at exactly what trigram is good at.** MiniLM is trained
   for *semantic* similarity, not lexical matching:

   | Query | Trigram | Embedding |
   |---|---|---|
   | `"engneer"` (typo) | catches it (shared 3-grams) | may drift semantically |
   | `"front"` → `Frontend Engineer` | partial match works | weak — fragment isn't a concept |
   | `"SDE"` → `Software Engineer` | **misses** (no shared grams) | **this is what vector is for** |
   | `"Google"` exact company | instant index hit | overkill / no vector exists |

   They are complementary by design. Trigram misses `SDE`↔`Software Engineer`
   (no shared 3-grams) — that's what the vector tier is for. Removing either
   creates a blind spot.

3. **Cost.** Trigram is a GIN index lookup (~3ms, no model). Routing everything
   through embeddings means paying 30–60ms cold for queries that exact/trigram
   answer for free.

This is the textbook **hybrid-search** pattern: cheap lexical tiers for
exact/typo/company, vector tier for semantic gaps.

---

## Q3. There used to be a `WEIGHTS` ranking layer — where did it go?

**Removed in favour of a two-layer model: filters + a single coverage score.**

The old code fused four signals into one number:

```ts
// removed
const WEIGHTS = { title: 2.0, company: 1.5, skill: 1.0, experience: 0.5 };
// totalScore = 2·title + 1.5·company + 1·skillCount + 0.5·experience
```

Two problems drove the rewrite:

1. **Incoherent units.** Title/company/experience were `[0,1]`, but the skill
   term was an unbounded *count* — 8 matched skills contributed `8.0`, swamping
   the `2.0` title weight. The weights only meant something if every term shared
   a scale, and skills didn't.
2. **Two scores disagreed.** A *separate* embedding cosine (`computeMatchScores`,
   since deleted) produced the badge %, and the UI re-sorted by it — so the
   weighted-sum ranking was thrown away and the displayed order didn't match the
   search relevance.

The replacement splits the two jobs cleanly:

- **Filters decide membership** — title (`titleIds`), company (`companyIds`), and
  the experience band are `WHERE`-clause filters. A job either qualifies or it
  doesn't; there's no partial credit to weight.
- **One score, one meaning** — the badge is `matched / required` skill coverage,
  a `[0,1]` fraction. Same number ranks the list *and* shows on the card, so they
  can't disagree.

The embedding still matters — it just feeds the **title filter** (deciding which
jobs are title matches), not a score. See Q6 for the worked example.

---

## Q4. What if neither company nor role is given in the query?

It depends on whether **skills** are given, because of the guard
([`lib/search.ts`](../lib/search.ts)):

```ts
if (titleMatches.length === 0 && companyIds.length === 0 && skills.length === 0)
  return [];
```

**Case A — skills present, no role/company** (e.g. `[React, Node.js]`, exp=3):

- `titleIds = []`, `companyIds = []`, `skills = [react, node.js]`
- Guard passes (skills non-empty).
- The title/company filters become no-ops via the `cardinality = 0 OR ...`
  short-circuit; the experience filter still applies (exp=3 → only jobs whose
  band includes 3):

  ```sql
  WHERE (cardinality($titleIds)   = 0 OR ...)   -- 0 → TRUE, filter disabled
    AND (cardinality($companyIds) = 0 OR ...)   -- 0 → TRUE, filter disabled
    AND ($experienceYears IS NULL OR 3 BETWEEN min AND max)  -- still filters
  ```

  Each surviving row gets `coverage = matched / required`. Because skills are
  present, the `coverage > 0` gate drops every job sharing none of the typed
  skills. What survives: experience-fitting jobs containing ≥1 typed skill,
  ranked by coverage, `LIMIT 30`.

**Case B — role/company only, no skills** (e.g. `Accenture`): guard passes on the
company match. Jobs are filtered but `coverage` is `NULL`, so the `> 0` gate is
**skipped** and every filtered job is returned with `score: null` (badge `—`),
ordered by recency.

**Case C — nothing typed at all** (no role, no company, no skills): guard returns
`[]`. The system refuses to dump the whole table.

```
            role?  company?  skills?
A (skills)    no      no       yes   → exp-filtered jobs sharing ≥1 skill, by coverage
B (no skill)  yes/—   yes/—    no    → filtered jobs, badge "—", by recency
C (empty)     no      no       no    → []  (guard)
```

So skills alone can carry a search (they're both score and implicit filter), and
role/company alone still return results — just without a coverage badge.

---

## Q5. Why are title, company, and experience *filters* and not scored signals?

Because they're **intent the user is certain about**, not evidence to weigh:

- **Title** — if you typed "SDE," you want engineering roles. A title match is a
  qualification, not a "nice to have." The vector/trigram grading still matters,
  but only to decide *membership* in the result set, not to rank within it.
- **Company** — a near-exact proper noun. "Google" means you want Google, full
  stop. There's nothing to weigh — either the job is at a matched company or it
  isn't.
- **Experience** — a hard constraint on suitability. A 3-year candidate shouldn't
  see a 10-year role at all. Previously this was a soft `0.5` nudge that let
  out-of-band jobs through; now it genuinely excludes them.

**Skill coverage is the one thing left to *score*** because it's a matter of
degree — you can match 2 of a job's 7 required skills, or 7 of 7. That fraction
(`matched / required`) is exactly what a percentage badge should express, and
it's the only signal where "how much" is a meaningful question.

---

## Q6. How does the embedding interact with the coverage score? (worked example)

**Key insight:** the embedding no longer enters the score at all. It decides
**which jobs pass the title filter** (`titleIds`); the badge is then computed from
skill coverage on the survivors. Two stages, no fusion.

### Query: `roleText="SDE"`, no company, `skills=["React","AWS"]`, `experience=3`

**Step 1 — `matchTitle("SDE")` selects the title-filter members.**

| Tier | Result for "SDE" |
|---|---|
| exact (`=`) | no job titled exactly "sde" → nothing |
| trigram (`%`) | "SDE" shares no 3-grams with "Software Engineer" → **miss** |
| **vector** | `embed("SDE")` → nearest jobs returned with cosine sim |

Say the vector tier returns these (with `keepMax` scores):

```
Job A "Software Engineer"        sim 0.62
Job B "Sr. Software Developer"   sim 0.55
Job C "Sales Development Rep"    sim 0.48   ← semantic false-ish positive
```

All three land in `titleIds`. **Their cosine scores are now discarded** — they
did their job (membership) and don't affect ranking.

**Step 2 — filter, then score the survivors by coverage.**

The `WHERE` keeps jobs in `titleIds` **and** in the experience band. Suppose
Job C's band is `[0,1]` — it's filtered out (3 ∉ [0,1]), so the semantic-noise
"Sales Development" hit is gone *before* scoring, not down-weighted.

For the survivors, `coverage = matched / required`:

```
Job A  requiredSkills: React, AWS, Docker, SQL, Go, k8s, Terraform (7)
       matched {React, AWS} = 2  →  coverage 2/7 = 0.29  →  badge 29%

Job B  requiredSkills: React, AWS, Node (3)
       matched {React, AWS} = 2  →  coverage 2/3 = 0.67  →  badge 67%
```

**Ranking:** B (67%) > A (29%). Job B wins because you cover more of *its*
requirements — even though Job A had the higher title cosine. Title relevance
got you into the list; **coverage decides the order and the %**.

```
embedding cosine sim ─┐
exact (1.0) ──────────┤ max → titleScore ──► passes title FILTER (membership only)
trigram (sim) ────────┘                          │
                                                  ▼  (+ company & experience filters)
                          surviving jobs ─► coverage = matched/required ─► badge %
                                                                          └► ORDER BY DESC
```

The embedding is a **gate**, not a term. Once a job is in the result set, the
only thing that ranks it and labels it is how much of its skill list you cover.

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers (filters), coverage-scoring SQL |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU cache + `toPgVectorLiteral` |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Job.embedding vector(384)` column |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Composite job embeddings at import time |
| [`docs/search.md`](./search.md) | End-to-end search flow |
