# Embeddings, cosine similarity & ranking — Q&A

A deep-dive into how vector embeddings and trigram matching power the title/company
**precedence tier** and the project **semantic fallback**, and how the match % is
an **equal blend** of skills% and projects% in [`lib/search.ts`](../lib/search.ts).
Companion to [`docs/search.md`](./search.md), which covers the end-to-end flow.

> **Model in one line:** role, company, skills, and project keywords form a
> **union** candidate set (a job qualifies if it matches *any*); experience is the
> one **hard filter**; the displayed badge % is the **equal mean** of `skills%`
> and `projects%`; and the **sort** decides whether matches are tiered
> **company → role → skill** (`default`) or pure match % wins (`score`). There is
> no weighted-sum ranking — the old `WEIGHTS` constant is gone (see Q3).

---

## Q1. How are embeddings stored — what fields, and what's the retrieval logic?

**Storage** — a single column on the `Job` row (no separate embeddings table,
no per-field vectors):

```prisma
// prisma/schema.prisma — 512-dim vector from Bedrock Titan Text Embeddings V2
// over a composite of title + roleType + summary + skills.
embedding  Unsupported("vector(512)")?
```

- pgvector `vector(512)` column, nullable.
- Computed **once at import time** ([`prisma/import-jobs.ts`](../prisma/import-jobs.ts))
  over one concatenated string:
  ```
  "${jobTitle}. ${roleType}. ${roleSummary}. Skills: ${requiredSkills}"
  ```
  The whole posting is squashed into **one** vector — title and skills baked together.
- Model: `amazon.titan-embed-text-v2:0` — 512-dim, normalized, generated via the
  Bedrock API ([`lib/embeddings.ts`](../lib/embeddings.ts)). Bedrock only generates
  the vector; storage stays in Postgres.
- Indexed by `job_embedding_hnsw` (HNSW, `vector_cosine_ops`) for fast ANN lookup.
- `Company` has **no** embedding.

**Retrieval** — the job vector is used in **two** places, both computed live in
SQL (the cosine score is never stored):

1. **Title tier** — `embed(roleText)` vs each job vector, top 20 nearest. Decides
   role-tier *membership* (`titleIds`) only, so it selects **ids**; the cosine
   merely orders the `LIMIT` and is never returned or scored.
   ```sql
   SELECT id FROM "Job" WHERE embedding IS NOT NULL
   ORDER BY embedding <=> $vec::vector LIMIT 20
   ```
2. **Project scoring** — each project's LLM-extracted keyword string is embedded
   separately; `projSim = MAX cosine(job.embedding, projVecLits[i])` across all
   project vectors. Rescaled with `MIN_PROJECT_SIMILARITY = 0.40` to filter Titan noise.

`<=>` is pgvector's cosine *distance* (0 = identical, 2 = opposite); `1 - distance`
flips it to a similarity in roughly `[0,1]` for normalized vectors. Query vectors
(role and project) are LRU-cached (max 500). The title tier has **no similarity
floor** — it always returns the 20 nearest.

---

## Q2. Do we need trigram search? Can't embeddings handle everything?

**Yes — keep trigram.** Embeddings alone are not sufficient for this data:

1. **Company matching has no embedding at all.** `matchCompanyIds` is pure
   exact → trigram. There's no company vector to fall back on — remove trigram and
   company search breaks entirely.

2. **Embeddings are bad at exactly what trigram is good at.** The embedding model
   is trained for *semantic* similarity, not lexical matching:

   | Query | Trigram | Embedding |
   |---|---|---|
   | `"engneer"` (typo) | catches it (shared 3-grams) | may drift semantically |
   | `"front"` → `Frontend Engineer` | partial match works | weak — fragment isn't a concept |
   | `"SDE"` → `Software Engineer` | **misses** (no shared grams) | **this is what vector is for** |
   | `"Google"` exact company | instant index hit | overkill / no vector exists |

   They're complementary by design; removing either creates a blind spot.

3. **Cost.** Trigram is a GIN index lookup (~3ms, no model). Routing everything
   through embeddings means paying 30–60ms cold for queries exact/trigram answer
   for free.

This is the textbook **hybrid-search** pattern: cheap lexical tiers for
exact/typo/company, vector tier for semantic gaps.

---

## Q3. There used to be a `WEIGHTS` ranking layer — where did it go, and how is the % computed now?

**Removed.** The old code fused four signals into one number:

```ts
// removed
const WEIGHTS = { title: 2.0, company: 1.5, skill: 1.0, experience: 0.5 };
// totalScore = 2·title + 1.5·company + 1·skillCount + 0.5·experience
```

It had incoherent units (title/company/experience were `[0,1]` but the skill term
was an unbounded *count* that swamped the rest) and a second, separate embedding
cosine drove the badge — so the ranking and the displayed % could disagree.

**Today the badge % is an equal, un-weighted blend of two `[0,100]` sub-scores,
computed in SQL (the `sub`/`scored` CTEs):**

```
skillsPct   = round( coverage × 100 )                         // job skills you cover
projectsPct = round( clamp((projSim - 0.40) / 0.60, 0, 1) × 100 )
              // projSim = MAX cosine(job.embedding, projVecLits[i])
score       = round( mean( non-null [skillsPct, projectsPct] ) )
```

- **Equal mean, no weights.** Both terms are on the same `[0,100]` scale, so a
  plain average is meaningful. A projectless resume scores on `skillsPct` alone
  (projects excluded, not zeroed).
- **One number, one meaning.** The same blended `score` ranks the list *and*
  labels the card; the hover shows the `Skills%` / `Projects%` split.
- **Computed in SQL, so the limit is correct.** Because `score` is the `ORDER BY`
  key, the query can `LIMIT 30` to a true top-N by match % — no oversized
  candidate pool. The JS side is just a row→card mapper.
- **Experience is not in the blend.** It stays a hard filter (Q5), so every
  returned job is already in-band — a hidden experience% would be a constant ~100%
  and tell you nothing.

So scoring is multi-criteria again, but by *equal blend of normalized sub-scores*,
not a weighted sum of mismatched units.

---

## Q4. What if neither company nor role is given? And how does the union change things?

The guard ([`lib/search.ts`](../lib/search.ts)) still gates the empty case:

```ts
if (titleMatches.length === 0 && companyIds.length === 0 && skills.length === 0)
  return [];
```

But once past the guard, the candidate set is a **union** — role, company, skills,
and project keywords each pull jobs in independently (experience filters them):

```sql
WHERE experience-band
  AND ( job ∈ titleIds  OR  company ∈ companyIds
     OR cov.matched > 0 )
```

```
            role?  company?  skills?  → result
A (skills)    no      no       yes    → in-band jobs sharing ≥1 skill, by blend
B (role/co)   yes     yes      no     → role/company jobs (+ any skill hits), badge "—" where unscored
C (combined)  yes     no       yes    → title matches ∪ skill matches, in one ranked list
D (empty)     no      no       no     → []  (guard)
```

The **key change from the old model:** role and company are no longer an `AND`
filter. In case C, typing a role *also* surfaces skill-matched non-role jobs —
they appear **below** the company and role tiers under the default sort (Q5),
instead of being excluded. Skills alone can still carry a search, and role/company
alone still return results (badge `—` when nothing is scored).

---

## Q5. Why are company and role *precedence tiers* (not a hard filter), and why is experience the opposite?

**Company and role are strong-but-soft intent.** If you typed "SDE" you clearly
prefer engineering roles — but you may still want a great skill match at a
slightly different title rather than seeing *nothing else*. And if you also typed a
**company**, you want to see *that company's* roles first — even ones that don't
match your skills at all. So each candidate gets a `tier`: **0 company-matched,
1 role-matched, 2 skill-only** (company wins over role, so a company's off-role
jobs surface above other companies' role matches). The card still exposes the
derived `roleOrCompanyMatched` (`tier < 2`). The user picks the trade-off with the
sort toggle:

- **`default` (Best match):** `tier ASC, score DESC` — company first (shown in full,
  even at 0% match), then role, then skill; each tier ordered by blended %. The role
  and skill tiers are each guaranteed up to `MIN_SLOTS_PER_TIER = 15` of the slots
  the company tier didn't take, then backfill by score.
- **`score` (Match score):** `score DESC` — pure match %, tier ignored.

**Experience is a genuine hard constraint.** A 3-year candidate shouldn't see a
10-year role at all, so the band is a `WHERE` filter — out-of-band jobs are
excluded outright, never scored, never shown. (It is deliberately *not* a
sub-score: with the filter in place every result is in-band, so an experience%
would be a constant.)

**Skills and projects are matters of degree** — you can cover 2 of 7 required
skills or 7 of 7 — so they're the scored signals, expressed as `[0,100]` fractions
and blended into the badge.

---

## Q6. Worked example — union, blend, and the two sort modes

### Query: `roleText="SDE"`, `skills=["React","AWS"]`, `experience=3`, resume has projects

**Step 1 — `matchTitleIds("SDE")` selects the role tier.** Exact and trigram miss
("SDE" shares no 3-grams with "Software Engineer"); the vector tier returns the
nearest titles → they land in `titleIds` (cosine scores then discarded). Skill and
project hits *also* enter the union, even at non-matching titles.

**Step 2 — experience filters, then each survivor is blended.**

```
Job A "Software Engineer" (role tier ✓, band [2,5] ✓)
   requiredSkills: React, AWS, Docker, SQL, Go, k8s, Terraform (7)
   skillsPct   = {React,AWS}=2 / 7  → 29
   projectsPct = projects mention React, Docker → 2/7 → 29
   score = mean(29,29) = 29     roleOrCompanyMatched = true

Job B "Frontend Developer" (NOT role tier, came in via skills, band [2,4] ✓)
   requiredSkills: React, AWS, Node (3)
   skillsPct   = {React,AWS}=2 / 3  → 67
   projectsPct = MAX cosine(projVecLits, job.embedding) = 0.62
               → clamp((0.62-0.40)/0.60, 0, 1) × 100 → 37
   score = mean(67,37) = 52     roleOrCompanyMatched = false
```

**Step 3 — sort.**

```
default (Best match):  A (role tier, 29%)  ▸  B (52%)     ← role precedence wins
score   (Match score): B (52%)  ▸  A (29%)                ← pure blend wins
```

Under `default`, Job A leads despite a lower %, because role precedence is the
explicit intent; switch to `score` and Job B — the stronger overall match — takes
the top. (Job B's `projectsPct` uses the MAX cosine of the project keyword vectors
against the job embedding, rescaled above `MIN_PROJECT_SIMILARITY = 0.40`.) This
query has no company, so its tiers are role (1) vs skill (2); add a company and its
jobs would form tier 0 above both. `default` guarantees the role and skill tiers up
to `MIN_SLOTS_PER_TIER = 15` of the 30 slots each (then backfills by score), so
skill-based jobs always get a share; `score` is a pure top-30 by %. Either way the
SQL `LIMIT 30` (`MAX_RESULTS`) is exact because the blend is the `ORDER BY` key.

```
tier (0 company / 1 role / 2 skill) ─┐
                                     ├─ default: tier asc, then score
skillsPct ─┐                         │  score:   score only
projectsPct ┴─ mean ─► blended score ┘
   (keyword overlap, else project↔job cosine)
```

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers, union ranking SQL, blend + sort |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | Bedrock Titan v2 embeddings + LRU cache + `toPgVectorLiteral` |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Job.embedding vector(512)` column |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Composite job embeddings at import time |
| [`docs/search.md`](./search.md) | End-to-end search flow |
</content>
