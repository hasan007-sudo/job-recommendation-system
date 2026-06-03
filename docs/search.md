# How search works

Search resolves a free-text input `{ companyText, roleText, skillNames, experienceYears }` to a ranked list of **job cards** (`JobCard[]`). Each card is one real scraped job; its interview rounds are parsed at read time from the job's `focusRoundPattern`.

Search is a **two-layer model**: title, company, and experience act as **filters** (which jobs qualify), and the match score is **skill coverage only** — `matched skills / job's required-skill count`. There are two independent candidate matchers — one for **role text** (title) and one for **company text** — and then a single SQL query that filters to the intersection and scores every surviving job by skill coverage.

```
{ companyText, roleText, skillNames, experienceYears }
        │
        ├───────────────────────────┬───────────────────────────┐
        ▼                           ▼                           │
┌──────────────────────┐   ┌──────────────────────┐            │
│ matchTitle(roleText) │   │ matchCompanyIds(...) │            │ skillNames,
│  exact ∪ trigram ∪   │   │  exact → trigram     │            │ experienceYears
│  vector (keep max)   │   │  (first confident)   │            │ passed straight
│  → up to 200 job ids │   │  → up to 5 company   │            │ into ranking
│    + per-job score   │   │    ids               │            │
└──────────────────────┘   └──────────────────────┘            │
        │                           │                           │
        └───────────────┬───────────┴───────────────────────────┘
                        ▼
        ┌───────────────────────────────────────────────┐
        │ Guard: no titles AND no companies AND          │
        │ no skills → return []  (don't dump the table)  │
        └───────────────────────────────────────────────┘
                        ▼
        ┌───────────────────────────────────────────────┐
        │ Single SQL over "Job" JOIN "Company":          │
        │   FILTER  job ∈ titleIds (if any)              │
        │      AND  company ∈ companyIds (if any)        │
        │      AND  experienceYears ∈ [min,max] (if set) │
        │   SCORE   coverage = matched / required skills │
        │   ORDER BY coverage DESC NULLS LAST,           │
        │            createdAt ASC LIMIT 30              │
        └───────────────────────────────────────────────┘
                        ▼
        skills given? drop coverage=0 : keep all (score null)
                → parseRounds() → JobCard[]
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

Unlike a first-wins waterfall, the title matcher runs **all three tiers and keeps the max score per job id** (`keepMax`). A generic query like `"Software Engineer"` should surface both the exact title and related real titles, so we union the tiers rather than stopping at the first hit.

```ts
const byId = new Map<string, number>();           // job id → best score so far
const keepMax = (rows) => { /* byId.set(id, max(prev, score)) */ };
```

**Tier 1 — exact** (`score = 1.0`):
```sql
SELECT id, 1.0 AS score FROM "Job" WHERE lower("jobTitle") = $norm LIMIT 200
```

**Tier 2 — trigram** (`score = similarity`, floor `TITLE_TRIGRAM_MIN = 0.3`):
```sql
SELECT id, similarity("jobTitle", $text) AS score FROM "Job"
WHERE "jobTitle" % $text AND similarity("jobTitle", $text) >= 0.3
ORDER BY score DESC LIMIT 200
```

**Tier 3 — vector** (`score = 1 - cosine distance`, top 200 nearest):
```sql
SELECT id, (1 - (embedding <=> $vec::vector)) AS score FROM "Job"
WHERE embedding IS NOT NULL ORDER BY embedding <=> $vec::vector LIMIT 200
```

> The vector tier has **no similarity floor of its own** — it always returns the 200 nearest. These scores only determine which jobs enter the **title filter** (`titleIds`); they don't rank the final list. Ranking is by skill coverage, so a distant title match that happens to qualify is ordered by how many of its skills you cover, not by its title similarity.

Returns up to `TITLE_CANDIDATES = 200` `{ id, score }` pairs. Empty `roleText` → `[]`.

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
- Query embeddings are wrapped in an LRU cache (`max: 500`) keyed on the lowercased text, so `"Software Engineer"` is embedded once then served from memory.

Job embeddings are computed at import time over a **composite** of the posting, not the title alone (see [`prisma/import-jobs.ts`](../prisma/import-jobs.ts)):
```ts
`${job_title}. ${role_type}. ${role_summary}. Skills: ${required_skills}`
```

---

## Company matching — `matchCompanyIds(companyText)`

Company names are typed near-exact (proper nouns), so this matcher is a simple **exact → trigram waterfall with no vector tier**, returning at most 5 company ids:

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

## Final query — filter, then score by coverage

One `$queryRaw` over `Job JOIN Company` filters to the intersection of the matched ids (plus the experience band) and scores each surviving row by **skill coverage only**:

```sql
SELECT j.id, j."jobTitle", c.name AS "companyName",
       j."experienceMinYears", j."experienceMaxYears", j."focusRoundPattern",
  CASE WHEN $hasSkills THEN
    (<count of input skills found in j."requiredSkills">)::float
    / NULLIF(<count of non-empty tokens in j."requiredSkills">, 0)
  ELSE NULL END AS "coverage"
FROM "Job" j JOIN "Company" c ON c.id = j."companyId"
WHERE (cardinality($titleIds)   = 0 OR j.id        = ANY($titleIds))
  AND (cardinality($companyIds) = 0 OR j."companyId" = ANY($companyIds))
  AND ($experienceYears::int IS NULL
       OR $experienceYears::int BETWEEN COALESCE(j."experienceMinYears",0)
                                    AND COALESCE(j."experienceMaxYears",99))
ORDER BY "coverage" DESC NULLS LAST, j."createdAt" ASC
LIMIT 30;
```

### Filters (which jobs qualify)
Three optional filters, all **AND-ed**. The `cardinality($ids) = 0` / `IS NULL` checks make each one a no-op when its input is absent:

- **Title** — `j.id ∈ titleIds` from `matchTitle` (exact ∪ trigram ∪ vector). The title score is used only to decide membership; it no longer feeds the badge.
- **Company** — `j."companyId" ∈ companyIds` from `matchCompanyIds`.
- **Experience** — the typed years must fall inside the job's `[min, max]` band. Null input → filter disabled; null job bounds → treated as open-ended (`0`/`99`). **This is a real filter now** — jobs outside the band are excluded, not merely down-weighted.

### Score = skill coverage (the badge %)
The only scored signal is skill overlap, expressed as a **fraction of the job's requirements you cover**:

```
coverage = (matched input skills) / (job's required-skill count)   → e.g. 5/7 = 0.71
score    = round(coverage × 100)                                   → 71  (the badge %)
```

Both sides are normalized (lowercased, non-alphanumerics stripped) and matched as a substring against the job's `,`/`;`/`|`-split skill tokens, so `"node.js"` matches `"NodeJS"`. A job that lists no skills → `required = 0` → `NULLIF` → `coverage` null.

When **no skills** are typed, `coverage` is `NULL` for every row and the badge renders `—`.

### Filter and shape
```ts
rows
  .filter((row) => !hasSkills || (row.coverage != null && row.coverage > 0))
  .map(... parseRounds ...)
```
- **Skills given:** a job must share at least one skill (`coverage > 0`) to appear — skills act as both the score *and* an implicit filter.
- **No skills:** the gate is skipped; every title/company/experience-filtered job is returned with `score: null`.

Then `focusRoundPattern` is parsed into rounds and `experienceMinYears` is mapped to a display `seniority` via `deriveSeniority` (`≤2 entry`, `≤6 mid`, else `senior`). `JobCard.score` is the `0–100` coverage badge, or `null` when no skills were queried.

### What the inputs mean

| Input | Behavior | Result |
|---|---|---|
| `Accenture` | company filter only, no skills | all Accenture jobs, badge `—`, ranked by recency |
| `SDE` | title filter only, no skills | title matches, badge `—`, ranked by recency |
| `Accenture` + `SDE` | company **and** title filter | Accenture jobs that also match the title, badge `—` |
| `[React, Node.js]` | skills only | jobs sharing ≥1 skill, badge = coverage %, ranked by coverage |
| `SDE` + `[React]` + `3 yrs` | title + experience filter, coverage score | engineering roles in the 3-yr band, ranked by React coverage |
| nothing | — | `[]` (guard) |

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

HNSW is the approximate-nearest-neighbour index for the vector tier (~10ms lookups). The generated `dedup_key` + unique index enforce one job per company/title at the DB level; the importer also dedups upstream, keeping the row with the richest round pattern.

---

## Latency budget (per request)

| Step | Cold | Warm |
|---|---|---|
| normalize | 0ms | 0ms |
| title exact + trigram (GIN) | ~3ms | ~3ms |
| query embedding | 30–60ms | **0ms** (LRU) |
| title HNSW cosine | ~10ms | ~10ms |
| company exact/trigram | ~1ms | ~1ms |
| ranking SQL | ~10ms | ~10ms |
| **Total** | **~80ms first** | **~25ms warmed** |

The query embedding is the single biggest cost; the LRU cache erases it for repeated queries.

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Title + company matchers and the final ranking SQL |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU query cache + `toPgVectorLiteral` |
| [`lib/rounds.ts`](../lib/rounds.ts) | `parseRounds()` — `focusRoundPattern` → ordered round list |
| [`lib/types.ts`](../lib/types.ts) | `JobCard`, `Seniority`, option types |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Company` / `Job` models + `vector(384)` embedding |
| [`prisma/db-init.sql`](../prisma/db-init.sql) | Extensions, GIN/HNSW indexes, dedup key |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Source import, dedup, composite job embeddings |
| [`app/api/search/route.ts`](../app/api/search/route.ts) | `POST /api/search` → `searchJobs` |
</content>
</invoke>
