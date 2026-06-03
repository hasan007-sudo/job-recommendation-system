# How search works

Search resolves an input `{ companyText, roleText, skillNames, experienceYears, projectText?, sort? }` to a ranked list of **job cards** (`JobCard[]`). Each card is one real scraped job; its interview rounds are parsed at read time from the job's `focusRoundPattern`.

The model has three parts:

1. **Candidate set (a union).** Role (title), company, skills, and project keywords each *bring jobs in*. A job qualifies if it matches **any** of them. Experience is the one hard filter — out-of-band jobs are excluded.
2. **Match % (an equal blend).** Each job is scored on up to two sub-scores — **skills%** and **projects%** — averaged into one headline %. Experience is *not* scored.
3. **Sort.** `default` ("Best match") puts role/company matches on top, then ranks by match %. `score` ("Match score") ignores the tier and ranks purely by match %.

```
{ companyText, roleText, skillNames, experienceYears, projectText, sort }
        │
        ├──────────────────┬──────────────────┬─────────────────────┐
        ▼                  ▼                   │                     │
┌──────────────────┐ ┌──────────────────┐     │ skillNames          │ projectText
│ matchTitle(role) │ │ matchCompanyIds  │     │ experienceYears     │ (embedded once
│ exact ∪ trigram  │ │ exact → trigram  │     │ passed into ranking │  for the
│ ∪ vector (keep   │ │ (first confident)│     │                     │  semantic fallback)
│ max) → ≤20/tier  │ │ → ≤5 company ids │     │                     │
└──────────────────┘ └──────────────────┘     │                     │
        │                  │                   │                     │
        └────────┬─────────┴───────────────────┴─────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ Guard: no titles AND no companies AND no skills → []    │
   └────────────────────────────────────────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ Single SQL over "Job" JOIN "Company":                   │
   │   WHERE experience-band (hard filter)                   │
   │     AND ( job ∈ titleIds                                │
   │       OR  company ∈ companyIds                          │
   │       OR  skill coverage > 0                            │
   │       OR  project-keyword hits > 0 )      ← UNION       │
   │   SELECT raw: coverage, projMatched, projSim,           │
   │               roleOrCompanyMatched                      │
   │   LIMIT 200  (RAW_CANDIDATE_CAP)                        │
   └────────────────────────────────────────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ In JS (per row):                                        │
   │   skillsPct   = coverage·100                            │
   │   projectsPct = projMatched/required ·100               │
   │                 ↳ else simToPercent(projSim)            │
   │   score       = mean(non-null [skillsPct, projectsPct]) │
   │ Sort by mode → slice(30) (RESULT_LIMIT) → parseRounds   │
   └────────────────────────────────────────────────────────┘
                 ▼
            JobCard[]
```

All matchers live in [`lib/search.ts`](../lib/search.ts).

---

## Data model

```prisma
model Company { id, name @unique, jobs Job[] }

model Job {
  id, companyId
  jobTitle, requiredSkills?, roleSummary?, roleType?, ...
  focusRoundPattern   // "Opening/Screening + Technical/Role Skills + Final/Culture Fit"
  experienceMinYears?, experienceMaxYears?
  embedding vector(384)?   // composite title+roleType+summary+skills, queried via $queryRaw
}
```

Rounds are **not stored as rows**. `focusRoundPattern` is a `+`-separated string; [`parseRounds()`](../lib/rounds.ts) splits it into an ordered list at read time against a closed 7-segment vocabulary (unknown segments fall back to `Other`). `roundCount` on a card is just that list's length.

---

## Layer 1: normalize

```ts
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s+#./-]/g, "");
}
```

- Lowercases, trims, strips punctuation that isn't meaningful in tech names. We keep `+`, `#`, `.`, `/`, `-` so `C++`, `C#`, `Next.js`, `CI/CD` survive.
- The normalized string feeds the exact lookup and the embedder. The trigram operator gets the **raw** text because `pg_trgm` is case-insensitive anyway.

---

## Title matching — `matchTitle(roleText)`

Runs **all three tiers and keeps the max score per job id** (`keepMax`). A generic query like `"Software Engineer"` should surface both the exact title and related real titles, so we union the tiers rather than stopping at the first hit. Each tier is capped at `TITLE_CANDIDATES = 20`.

**Tier 1 — exact** (`score = 1.0`):
```sql
SELECT id, 1.0 AS score FROM "Job" WHERE lower("jobTitle") = $norm LIMIT 20
```

**Tier 2 — trigram** (`score = similarity`, floor `TITLE_TRIGRAM_MIN = 0.3`):
```sql
SELECT id, similarity("jobTitle", $text) AS score FROM "Job"
WHERE "jobTitle" % $text AND similarity("jobTitle", $text) >= 0.3
ORDER BY score DESC LIMIT 20
```

**Tier 3 — vector** (`score = 1 - cosine distance`, top 20 nearest):
```sql
SELECT id, (1 - (embedding <=> $vec::vector)) AS score FROM "Job"
WHERE embedding IS NOT NULL ORDER BY embedding <=> $vec::vector LIMIT 20
```

> The vector tier has **no similarity floor of its own** — it always returns the 20 nearest. The tier scores only decide which jobs enter the **role tier** (`titleIds`); they don't rank the final list (the blended match % does). Empty `roleText` → `[]`.

### How trigrams work
```
"Google"  → {"  G"," Go","Goo","oog","ogl","gle","le "}
"googl"   → {"  g"," go","goo","oog","ogl","gl "}
shared {"goo","oog","ogl"} → similarity ≈ 0.5
```
The GIN trigram index (`job_title_trgm`) makes `WHERE "jobTitle" % $text` an index lookup (~3ms) instead of a seq scan. Catches typos (`"engneer"`), variants, and partials (`"front"` → `Frontend Engineer`). Misses strings with no shared 3-grams (`"SDE"` ↔ `"Software Engineer"`) — that's what the vector tier is for.

### The embedding model
[`lib/embeddings.ts`](../lib/embeddings.ts) uses `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`:
- 384-dim, mean-pooled, L2-normalized
- ~25 MB, runs in-process via WASM, no API key, no network at query time
- Query embeddings are wrapped in an LRU cache (`max: 500`) keyed on the lowercased text, so a repeated role/project string is embedded once then served from memory.

Job embeddings are computed at import time over a **composite** of the posting, not the title alone (see [`prisma/import-jobs.ts`](../prisma/import-jobs.ts)):
```ts
`${job_title}. ${role_type}. ${role_summary}. Skills: ${required_skills}`
```

---

## Company matching — `matchCompanyIds(companyText)`

Company names are typed near-exact (proper nouns), so this matcher is a simple **exact → trigram waterfall with no vector tier**, returning at most **5** company ids:

```ts
// Tier 1: exact — return immediately if found
SELECT id FROM "Company" WHERE lower(name) = $norm LIMIT 5;

// Tier 2: trigram — accept only if top score clears the floor
SELECT id, similarity(name, $text) AS score FROM "Company"
WHERE name % $text ORDER BY score DESC LIMIT 5;
// keep only if score[0] >= COMPANY_TRIGRAM_MIN (0.4)
```

`COMPANY_TRIGRAM_MIN = 0.4` is strict because company names are short and false positives are costly. A miss returns `[]`.

---

## The empty-result guard

```ts
if (titleMatches.length === 0 && companyIds.length === 0 && skills.length === 0) return [];
```

If nothing was typed (or nothing matched), search returns an empty list instead of dumping the whole `Job` table. At least one of title / company / skills must produce a constraint.

---

## Final query — union candidate set + raw sub-score columns

One `$queryRaw` over `Job JOIN Company`. The experience band is a hard filter; everything else is **OR-ed into a union**. Sub-scores come back raw and are blended in JS.

```sql
SELECT j.id, j."jobTitle", c.name AS "companyName",
       j."experienceMinYears", j."experienceMaxYears", j."focusRoundPattern",
  CASE WHEN $hasSkills THEN cov.matched ELSE NULL END                AS "matched",
  cov.required                                                       AS "required",
  CASE WHEN $hasSkills THEN cov.matched::float / NULLIF(cov.required,0)
       ELSE NULL END                                                 AS "coverage",
  cov."projMatched"                                                  AS "projMatched",
  CASE WHEN $hasProjVec AND j.embedding IS NOT NULL
       THEN (1 - (j.embedding <=> $projVec::vector))::float
       ELSE NULL END                                                 AS "projSim",
  ( job ∈ titleIds  OR  company ∈ companyIds )                       AS "roleOrCompanyMatched"
FROM "Job" j JOIN "Company" c ON c.id = j."companyId"
CROSS JOIN LATERAL (
  -- over j.requiredSkills split on , ; |
  --   matched     = job skill tokens covered by any input skill   (ILIKE substring)
  --   projMatched = job skill tokens found in the project text     (substring)
  --   required    = count of non-empty job skill tokens
) cov
WHERE ( $experienceYears::int IS NULL
        OR $experienceYears::int BETWEEN COALESCE(j."experienceMinYears",0)
                                     AND COALESCE(j."experienceMaxYears",99) )  -- hard filter
  AND ( (cardinality($titleIds)   > 0 AND j.id          = ANY($titleIds))
     OR (cardinality($companyIds) > 0 AND j."companyId" = ANY($companyIds))
     OR cov.matched     > 0
     OR cov."projMatched" > 0 )                                                 -- UNION
ORDER BY "roleOrCompanyMatched" DESC, cov.matched DESC, cov."projMatched" DESC, j."createdAt" ASC
LIMIT 200;  -- RAW_CANDIDATE_CAP
```

### Candidate set (which jobs qualify) — a union, not an AND
A job enters the set if it matches **any** signal:

- **Role** — `j.id ∈ titleIds` from `matchTitle` (exact ∪ trigram ∪ vector).
- **Company** — `j."companyId" ∈ companyIds` from `matchCompanyIds`.
- **Skills** — `coverage > 0`: the job shares ≥1 of the typed skills.
- **Projects** — `projMatched > 0`: ≥1 of the job's required skills appears in the resume's project text.

Typing a role therefore **also** surfaces skill-matched jobs that don't match the role — they just rank below the role/company tier under the default sort. **Experience is the only hard filter**: the typed years must fall inside the job's `[min, max]` band (null input → disabled; null job bounds → open-ended `0`/`99`). Experience is never scored or shown.

`roleOrCompanyMatched` records whether a job came in via the role/company tier; it drives the default sort.

---

## Scoring — the blended match %

Computed in JS from the raw columns ([`lib/search.ts`](../lib/search.ts)). The headline `score` is the **equal mean** of whichever sub-scores apply — no weights.

### Skills% (`skillsPct`)
```
coverage = (job skill tokens covered by an input skill) / (job's skill-token count)
skillsPct = round(coverage × 100)            // e.g. 5/7 → 71
```
Both sides are normalized (lowercased, non-alphanumerics stripped) and matched as a substring against the job's `,`/`;`/`|`-split tokens, so `"node.js"` matches `"NodeJS"`. No skills typed → `coverage` null → `skillsPct` null.

### Projects% (`projectsPct`) — hybrid, "if any"
Only scored when the resume has project text. Distinguishes skills you *list* from skills you've *built with*:

1. **Keyword overlap (primary):** `projMatched` = how many of the job's required skills appear in the project text. If `projMatched > 0` → `round(projMatched / required × 100)`.
2. **Semantic fallback:** when keyword overlap is 0, use `simToPercent(projSim)` where `projSim = 1 − cosine(projectEmbedding, job.embedding)`. The project text is embedded once per search.

No project text → `projectsPct` null (projectless candidates aren't penalized).

```ts
// rescales the typical resume↔JD cosine band (~0.15–0.7) across 0–100
function simToPercent(sim) { return round(clamp((sim - 0.15) / 0.55, 0, 1) * 100); }
```

### Blend
```
score = round( mean( non-null [skillsPct, projectsPct] ) )
```
Both null → `score` null → badge `—`. The card hover shows the `Skills%` / `Projects%` breakdown behind the headline.

---

## Sort modes

Sorting happens in JS after blending, then the list is sliced to `RESULT_LIMIT = 30`. The UI toggle (`Best match` / `Match score`) re-runs the search with the chosen mode.

- **`default` (Best match):** `roleOrCompanyMatched DESC`, then `score DESC` (nulls last). Role/company matches sit on top; within a tier, higher match % wins. A role-matched job outranks a higher-scoring non-role job.
- **`score` (Match score):** `score DESC` (nulls last), tier ignored. A higher-scoring non-role job can outrank a role-matched one.

> Worked example: a resume matches **JD-X** (role-name match, 5/10 skills) and **JD-Y** (no role match, 10/10 skills). `default` → JD-X above JD-Y (role tier wins). `score` → JD-Y above JD-X (higher blend).

After sorting, `focusRoundPattern` is parsed into rounds and `experienceMinYears` is mapped to a display `seniority` via `deriveSeniority` (`≤2 entry`, `≤6 mid`, else `senior`).

---

## Limits at a glance

| Stage | Limit | Constant |
|---|---|---|
| Title tier — exact / trigram / vector (each) | 20 | `TITLE_CANDIDATES` |
| Company tier — exact / trigram (each) | 5 | literal |
| Raw union candidates pulled | 200 | `RAW_CANDIDATE_CAP` |
| Final list returned / displayed | 30 | `RESULT_LIMIT` |

Skills and project keywords are **not** candidate-limited — they pull every qualifying job into the union (bounded by the 200 raw cap), which is then blended, sorted, and sliced to 30.

---

## What the inputs mean

| Input | Candidate set | Score | Order (default) |
|---|---|---|---|
| `Accenture` | Accenture jobs (company tier) | badge `—` (no skills) | role/company tier, then recency |
| `SDE` | title matches **∪** any skill/project matches | skills/projects where present | title matches first |
| `[React, Node.js]` | jobs sharing ≥1 skill | coverage % (+ projects if resume) | by blended % |
| `SDE` + `[React]` + `3 yrs` | title ∪ skill matches, band-filtered | React coverage (+ projects) | title matches first, then % |
| resume w/ projects | + jobs whose skills appear in projects | skills% **and** projects% blended | role/company first, then % |
| nothing | — | — | `[]` (guard) |

---

## Indexes ([`prisma/db-init.sql`](../prisma/db-init.sql))

```sql
CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;

CREATE INDEX job_title_trgm    ON "Job"     USING GIN ("jobTitle" gin_trgm_ops);
CREATE INDEX job_skills_trgm   ON "Job"     USING GIN ("requiredSkills" gin_trgm_ops);
CREATE INDEX company_name_trgm ON "Company" USING GIN (name gin_trgm_ops);
CREATE INDEX job_embedding_hnsw ON "Job"
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- DB-level dedup: one Job per (company, case-folded title)
ALTER TABLE "Job" ADD COLUMN dedup_key text
  GENERATED ALWAYS AS ("companyId" || '|' || lower(btrim("jobTitle"))) STORED;
CREATE UNIQUE INDEX job_dedup_key_uniq ON "Job" (dedup_key);
```

HNSW is the approximate-nearest-neighbour index for the vector tier and the project semantic fallback (~10ms lookups). The generated `dedup_key` + unique index enforce one job per company/title at the DB level; the importer also dedups upstream, keeping the row with the richest round pattern.

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers, union ranking SQL, blend + sort |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU query cache + `toPgVectorLiteral` |
| [`lib/rounds.ts`](../lib/rounds.ts) | `parseRounds()` — `focusRoundPattern` → ordered round list |
| [`lib/onboarding.ts`](../lib/onboarding.ts) | `deriveSearchInput` — profile → `SearchInput` (incl. `projectText`, `sort`) |
| [`lib/types.ts`](../lib/types.ts) | `JobCard` (`score`, `skillsPct`, `projectsPct`, `roleOrCompanyMatched`), option types |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Company` / `Job` models + `vector(384)` embedding |
| [`prisma/db-init.sql`](../prisma/db-init.sql) | Extensions, GIN/HNSW indexes, dedup key |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Source import, dedup, composite job embeddings |
| [`app/api/search/route.ts`](../app/api/search/route.ts) | `POST /api/search` → `searchJobs` |
| [`app/page.tsx`](../app/page.tsx) | Filters (role, company, experience, skills), sort toggle, card hover breakdown |
</content>
</invoke>
