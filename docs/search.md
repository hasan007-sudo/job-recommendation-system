# How search works

Search resolves a free-text input `{ companyText, roleText, skillNames, experienceYears }` to a ranked list of **job cards** (`JobCard[]`). Each card is one real scraped job; its interview rounds are parsed at read time from the job's `focusRoundPattern`.

There are two independent candidate matchers — one for **role text** (title) and one for **company text** — and then a single SQL query that filters to the intersection and scores every surviving job.

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
        │ Single ranking SQL over "Job" JOIN "Company":  │
        │   WHERE job ∈ titleIds (if any)                │
        │     AND company ∈ companyIds (if any)          │
        │   score = 2·title + 1.5·company + 1·skills     │
        │           + 0.5·experience                     │
        │   ORDER BY score DESC, createdAt ASC LIMIT 30  │
        └───────────────────────────────────────────────┘
                        ▼
        filter score > 0 → parseRounds() → JobCard[]
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

> The vector tier has **no similarity floor of its own** — it always returns the 200 nearest. Distant matches survive here with a low score, but they only matter if the final `totalScore` clears `> 0`, and exact/trigram hits (higher score via `keepMax`) float above them in ranking.

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

## Final ranking query

One `$queryRaw` over `Job JOIN Company` filters to the intersection of the matched ids and scores each surviving row:

```sql
SELECT j.id, j."jobTitle", c.name AS "companyName",
       j."experienceMinYears", j."experienceMaxYears", j."focusRoundPattern",
  ( 2.0  * COALESCE(<title score for this job from titleIds/titleScores>, 0)
  + 1.5  * CASE WHEN cardinality($companyIds) > 0
                 AND j."companyId" = ANY($companyIds) THEN 1.0 ELSE 0.0 END
  + 1.0  * <count of input skills found in j."requiredSkills">
  + 0.5  * CASE WHEN $experienceYears BETWEEN COALESCE(j."experienceMinYears",0)
                                          AND COALESCE(j."experienceMaxYears",99)
                THEN 1.0 ELSE 0.0 END
  ) AS "totalScore"
FROM "Job" j JOIN "Company" c ON c.id = j."companyId"
WHERE (cardinality($titleIds)   = 0 OR j.id        = ANY($titleIds))
  AND (cardinality($companyIds) = 0 OR j."companyId" = ANY($companyIds))
ORDER BY "totalScore" DESC, j."createdAt" ASC
LIMIT 30;
```

### Weights
```ts
const WEIGHTS = { title: 2.0, company: 1.5, skill: 1.0, experience: 0.5 };
```

- **Title** weighted highest — the role is the strongest signal, and its score is itself graded (1.0 exact down to a low vector similarity).
- **Company** match is a flat `1.5` bonus when the job's company is in `companyIds`. This term is why a **company-only** search returns results at all: without it those jobs would score `0` and be dropped by the `> 0` filter below.
- **Skill** term counts how many input skills appear in the job's `requiredSkills`. Each side is normalized (lowercased, non-alphanumerics stripped) and matched as a substring against the job's `,`/`;`/`|`-split skill tokens, so `"node.js"` matches `"NodeJS"`.
- **Experience** adds `0.5` when the typed years fall inside the job's `[min, max]` band (null input → 0).

### Filter and shape
```ts
rows.filter((row) => Number(row.totalScore) > 0).map(... parseRounds ...)
```
Rows that matched a filter but scored nothing are dropped, then `focusRoundPattern` is parsed into rounds and `experienceMinYears` is mapped to a display `seniority` via `deriveSeniority` (`≤2 entry`, `≤6 mid`, else `senior`).

### What the filters mean
The `cardinality($ids) = 0` checks make each filter optional, but the two are **AND-ed** — so company + role narrows to jobs matching *both*.

| Input | Filters applied | Result |
|---|---|---|
| `Accenture` | company only | all Accenture jobs (+1.5 each) ranked by recency |
| `SDE` | title only | exact/trigram/vector title matches, scored by title similarity |
| `Accenture` + `SDE` | company **and** title | Accenture jobs that also match the title |
| `[React, Node.js]` | skills only | jobs whose `requiredSkills` contain those skills |
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
