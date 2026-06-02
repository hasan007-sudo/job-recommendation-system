# Embeddings, cosine similarity & ranking — Q&A

A deep-dive into how vector embeddings, trigram matching, and the `WEIGHTS`
ranking layer fit together in [`lib/search.ts`](../lib/search.ts). Companion to
[`docs/search.md`](./search.md), which covers the end-to-end flow.

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
similarity floor** — it always returns the 200 nearest; low-quality matches get
filtered later by `totalScore > 0`.

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

## Q3. Do we need the `WEIGHTS` variable? Can't embeddings do the ranking?

**Yes — and embeddings can't replace it.** This is a category difference.

```ts
const WEIGHTS = { title: 2.0, company: 1.5, skill: 1.0, experience: 0.5 };
```

A cosine score answers **one** question: "how semantically close is this job's
text to the role query?" — a single number in `[0,1]`.

`WEIGHTS` fuses **four independent signals from different sources**:

- title relevance (which *includes* the vector score as one input)
- company match (a boolean — job's company ∈ matched ids)
- skill overlap (a count of matched skill tokens)
- experience-band fit (a boolean)

No embedding can express "the user typed Accenture AND 3 skills AND 5 years," or
decide "company match should count more than experience fit." That's a
**ranking/business decision**, and `WEIGHTS` is where it lives.

Concretely: the company term is a flat `1.5` bonus. It is *the only reason a
company-only search returns anything* — without it those jobs score 0 and get
dropped by the `> 0` filter. An embedding can't manufacture that signal because
there's no company vector and no role text in a company-only search.

So the embedding is *already inside* the title weight as a graded sub-score.
`WEIGHTS` sits a layer above, fusing it with three things embeddings
structurally cannot see.

> Caveat: the weight values are hand-set with **no eval behind them**. They
> encode a product opinion (role > company > skills > seniority), which is worth
> validating against real queries — but that's tuning, not removal.

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
- In the ranking SQL, both filters become no-ops via the `cardinality = 0 OR ...`
  short-circuit:

  ```sql
  WHERE (cardinality($titleIds)   = 0 OR ...)   -- 0 → TRUE, filter disabled
    AND (cardinality($companyIds) = 0 OR ...)   -- 0 → TRUE, filter disabled
  ```

  The `WHERE` now matches **every job**. Score per row =
  `2.0·0 + 1.5·0 + 1.0·(skill count) + 0.5·(exp fit)`. Then `totalScore > 0`
  drops every job with zero skill matches. What survives: jobs containing at
  least one typed skill, ranked by overlap count (+experience tiebreak),
  `LIMIT 30`.

**Case B — nothing typed at all** (no role, no company, no skills): guard returns
`[]`. The system refuses to dump the whole table.

```
            role?  company?  skills?
A (skills)    no      no       yes   → all jobs scored on skill+exp, kept if >0
B (empty)     no      no       no    → []  (guard)
```

So skills alone can carry a search; they're the third independent constraint.

---

## Q5. Why give a higher score to company and role specifically?

It's an **intent-strength ordering**, hand-set:

- **Title (2.0)** — the job *is* its title. A role matching your title is almost
  certainly what you want, more than a role that merely lists a skill you typed.
  Its multiplier is applied to a *graded* score (1.0 exact → ~0.3 vector), so a
  weak title match doesn't dominate — only a strong one does.
- **Company (1.5)** — a near-exact proper noun. If you typed "Google," you almost
  certainly only want Google. High, but below title because in a combined search
  the *role* is the finer-grained intent.
- **Skill (1.0)** — weaker evidence; a job listing 8 skills matches many queries
  incidentally. It's a count, so it can still add up.
- **Experience (0.5)** — weakest, a tiebreaker. Being in the right band is a
  "nice to have," not the reason you searched.

These encode a product opinion that embeddings cannot decide for you.

---

## Q6. How does the embedding score combine with the weight score? (worked example)

**Key insight:** the embedding score is *not* a separate term. It feeds **into**
the title score, which is the **max** across exact/trigram/vector tiers
(`keepMax` in [`lib/search.ts`](../lib/search.ts)). That max is then multiplied by
`WEIGHTS.title`.

### Query: `roleText="SDE"`, no company, `skills=["React"]`, `experience=3`

**Step 1 — `matchTitle("SDE")` builds per-job title scores:**

| Tier | Result for "SDE" |
|---|---|
| exact (`=`) | no job titled exactly "sde" → nothing |
| trigram (`%`) | "SDE" shares no 3-grams with "Software Engineer" → **miss** |
| **vector** | `embed("SDE")` → nearest jobs returned with cosine sim |

Say the vector tier returns:

```
Job A "Software Engineer"        sim 0.62
Job B "Sr. Software Developer"   sim 0.55
Job C "Sales Development Rep"    sim 0.48   ← semantic false-ish positive
```

`keepMax` → `titleScores = { A:0.62, B:0.55, C:0.48 }`. These ARE the embedding
scores; for this query the vector tier is the only one that fired.

**Step 2 — final ranking SQL scores each surviving job.**

For **Job A** (`requiredSkills` contains React, exp band [2,5]):

```
title term      = 2.0 × 0.62            = 1.24   ← embedding score enters HERE
company term    = 1.5 × 0 (none typed)  = 0.00
skill term      = 1.0 × 1 (React found) = 1.00
experience term = 0.5 × 1 (3 ∈ [2,5])   = 0.50
                                  total = 2.74
```

For **Job C** (Sales Dev Rep — no React, exp out of band):

```
title term      = 2.0 × 0.48 = 0.96
company         = 0
skill           = 1.0 × 0    = 0
experience      = 0.5 × 0    = 0
                       total = 0.96
```

**Ranking:** A (2.74) > B (…) > C (0.96). All have `totalScore > 0` so all
survive, but the React + experience match pushes the genuine engineering role
well above the semantic-noise "Sales Development" hit — even though C also came
from the embedding tier.

```
embedding cosine sim ─┐
exact (1.0) ──────────┤ max → titleScore ──×2.0──┐
trigram (sim) ────────┘                          ├─► totalScore ─► ORDER BY DESC
company bool ──────────────────────────────×1.5──┤
skill count ───────────────────────────────×1.0──┤
exp-band bool ─────────────────────────────×0.5──┘
```

The embedding produces **one input** (the title sub-score, when it's the
strongest tier), and `WEIGHTS` is the fusion layer that blends it with the three
signals the embedding never sees — company, skill overlap, and experience fit.

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers, `WEIGHTS`, final ranking SQL |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU cache + `toPgVectorLiteral` |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Job.embedding vector(384)` column |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Composite job embeddings at import time |
| [`docs/search.md`](./search.md) | End-to-end search flow |
