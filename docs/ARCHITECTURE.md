# Embeddings, cosine similarity & ranking — Q&A

A deep-dive into how vector embeddings and trigram matching power the title/company
**precedence tier** and the project **semantic fallback**, and how the match % is
an **equal blend** of skills% and projects% in [`lib/search.ts`](../lib/search.ts).
Companion to [`docs/search.md`](./search.md), which covers the end-to-end flow.

> **Model in one line:** role, company, skills, and project keywords form a
> **union** candidate set (a job qualifies if it matches *any*); experience is the
> one **hard filter**; the displayed badge % is the **equal mean** of `skills%`
> and `projects%`; and the **sort** decides whether role/company matches get
> precedence (`default`) or pure match % wins (`score`). There is no weighted-sum
> ranking — the old `WEIGHTS` constant is gone (see Q3).

---

## Q1. How are embeddings stored — what fields, and what's the retrieval logic?

**Storage** — a single column on the `Job` row (no separate embeddings table,
no per-field vectors):

```prisma
// prisma/schema.prisma — 384-dim vector from Xenova/all-MiniLM-L6-v2
// over a composite of title + roleType + summary + skills.
embedding  Unsupported("vector(384)")?
```

- pgvector `vector(384)` column, nullable.
- Computed **once at import time** ([`prisma/import-jobs.ts`](../prisma/import-jobs.ts))
  over one concatenated string:
  ```
  "${jobTitle}. ${roleType}. ${roleSummary}. Skills: ${requiredSkills}"
  ```
  The whole posting is squashed into **one** vector — title and skills baked together.
- Model: `Xenova/all-MiniLM-L6-v2` — 384-dim, mean-pooled, L2-normalized,
  runs in-process via WASM ([`lib/embeddings.ts`](../lib/embeddings.ts)).
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
2. **Project semantic fallback** — `embed(projectText)` vs each candidate's job
   vector, surfaced as `projSim = 1 - (embedding <=> $projVec)`. Used only when a
   job's required skills have **no** keyword overlap with the project text (Q6).

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

2. **Embeddings are bad at exactly what trigram is good at.** MiniLM is trained
   for *semantic* similarity, not lexical matching:

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
skillsPct   = round( coverage × 100 )                  // job skills you cover
projectsPct = round( projMatched / required × 100 )    // job skills your projects show
              ↳ else rescale(projSim cosine)           // semantic fallback (Q6)
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
     OR cov.matched > 0  OR cov."projMatched" > 0 )
```

```
            role?  company?  skills?  → result
A (skills)    no      no       yes    → in-band jobs sharing ≥1 skill (or project hit), by blend
B (role/co)   yes     yes      no     → role/company jobs (+ any skill/project hits), badge "—" where unscored
C (combined)  yes     no       yes    → title matches ∪ skill matches, in one ranked list
D (empty)     no      no       no     → []  (guard)
```

The **key change from the old model:** role and company are no longer an `AND`
filter. In case C, typing a role *also* surfaces skill-matched non-role jobs —
they appear **below** the role/company tier under the default sort (Q5), instead
of being excluded. Skills alone can still carry a search, and role/company alone
still return results (badge `—` when nothing is scored).

---

## Q5. Why are role and company a *precedence tier* (not a hard filter), and why is experience the opposite?

**Role and company are strong-but-soft intent.** If you typed "SDE" you clearly
prefer engineering roles — but you may still want a great skill match at a
slightly different title rather than seeing *nothing else*. So role/company
matches are tracked with a `roleOrCompanyMatched` flag and floated to the **top**
of the default sort, while non-matching skill/project hits remain available below.
The user picks the trade-off with the sort toggle:

- **`default` (Best match):** `roleOrCompanyMatched DESC, score DESC` — role/company
  on top, then by blended %.
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
   projectsPct = no keyword overlap → rescale(projSim 0.55) → 73
   score = mean(67,73) = 70     roleOrCompanyMatched = false
```

**Step 3 — sort.**

```
default (Best match):  A (role tier, 29%)  ▸  B (70%)     ← role precedence wins
score   (Match score): B (70%)  ▸  A (29%)                ← pure blend wins
```

Under `default`, Job A leads despite a lower %, because role precedence is the
explicit intent; switch to `score` and Job B — the stronger overall match — takes
the top. `default` also guarantees each tier up to `TIER_FLOOR = 15` of the 30
slots (then backfills by score), so skill-based jobs always get a share; `score`
is a pure top-30 by %. Either way the SQL `LIMIT 30` (`RESULT_LIMIT`) is exact
because the blend is the `ORDER BY` key.

```
role tier  ─► roleOrCompanyMatched flag ─┐
                                          ├─ default: tier first, then score
skillsPct ─┐                              │  score:   score only
projectsPct ┴─ mean ─► blended score ─────┘
   (keyword overlap, else project↔job cosine)
```

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers, union ranking SQL, blend + sort |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU cache + `toPgVectorLiteral` |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Job.embedding vector(384)` column |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Composite job embeddings at import time |
| [`docs/search.md`](./search.md) | End-to-end search flow |
</content>
