# How search works

Search resolves an input `{ companyText, roleText, skillNames, experienceYears, projectTexts?, sort? }` to a ranked list of **job cards** (`JobCard[]`). Each card is one real scraped job; its interview rounds are parsed at read time from the job's `focusRoundPattern`.

The model has three parts:

1. **Candidate set (a union).** Role (title), company, and skills each *bring jobs in*. A job qualifies if it matches **any** of them. Experience is the one hard filter — out-of-band jobs are excluded. Projects only **score** candidates; they do not add new ones.
2. **Match % (an equal blend).** Each job is scored on up to two sub-scores — **skills%** and **projects%** — averaged into one headline %. Experience is *not* scored.
3. **Sort.** `default` ("Best match") puts role/company matches on top, then ranks by match %. `score` ("Match score") ignores the tier and ranks purely by match %.

```
{ companyText, roleText, skillNames, experienceYears, projectTexts[], sort }
        │
        ├──────────────────┬──────────────────┬─────────────────────┐
        ▼                  ▼                   │                     │
┌──────────────────┐ ┌──────────────────┐     │ skillNames          │ projectTexts[]
│ matchTitleIds    │ │ matchCompanyIds  │     │ experienceYears     │ (each embedded
│ exact ∪ trigram  │ │ exact → trigram  │     │ passed into ranking │  separately;
│ ∪ vector (keep   │ │ (first confident)│     │                     │  MAX cosine
│ max) → ≤20/tier  │ │ → ≤5 company ids │     │                     │  scores only)
└──────────────────┘ └──────────────────┘     │                     │
        │                  │                   │                     │
        └────────┬─────────┴───────────────────┴─────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ Guard: no titles AND no companies AND no skills → []    │
   └────────────────────────────────────────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ Single SQL over "Job" JOIN "Company" (CTE pipeline):    │
   │   WHERE experience-band (hard filter)                   │
   │     AND ( job ∈ titleIds                                │
   │       OR  company ∈ companyIds                          │
   │       OR  skill coverage > 0 )             ← UNION       │
   │   skillsPct = coverage·100                              │
   │   projectsPct = MAX cosine(projVecLits[], job.embedding)│
   │               rescaled (PROJ_SIM_FLOOR=0.40 → 1.0)     │
   │   score = mean(non-null [skillsPct, projectsPct])       │
   │   rn_in_tier = ROW_NUMBER() per roleOrCompanyMatched    │
   │   ── default: floor 15/tier, backfill by score          │
   │   ── score:   pure top-N by score                       │
   │   LIMIT 30  (RESULT_LIMIT)                              │
   └────────────────────────────────────────────────────────┘
                 ▼
   ┌────────────────────────────────────────────────────────┐
   │ JS: thin map row → JobCard, parseRounds (no re-sort)    │
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
  embedding vector(512)?   // composite title+roleType+summary+skills, queried via $queryRaw
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

## Title matching — `matchTitleIds(roleText)`

Runs **all three tiers and unions their ids** into a `Set`. A generic query like `"Software Engineer"` should surface both the exact title and related real titles, so we union the tiers rather than stopping at the first hit. Each tier is capped at `TITLE_CANDIDATES = 20`. Title only decides **membership** (it never ranks the final list — the blended match % does), so each tier selects **ids only**; the per-tier similarity stays in `ORDER BY` purely to pick the top 20.

**Tier 1 — exact:**
```sql
SELECT id FROM "Job" WHERE lower("jobTitle") = $norm LIMIT 20
```

**Tier 2 — trigram** (floor `TITLE_TRIGRAM_MIN = 0.3`):
```sql
SELECT id FROM "Job"
WHERE "jobTitle" % $text AND similarity("jobTitle", $text) >= 0.3
ORDER BY similarity("jobTitle", $text) DESC LIMIT 20
```

**Tier 3 — vector** (top 20 nearest by cosine):
```sql
SELECT id FROM "Job"
WHERE embedding IS NOT NULL ORDER BY embedding <=> $vec::vector LIMIT 20
```

> The vector tier has **no similarity floor of its own** — it always returns the 20 nearest. Returns the unioned ids (`titleIds`); the similarity/cosine only orders each tier's `LIMIT`, it is never returned or scored. Empty `roleText` → `[]`.

### How trigrams work
```
"Google"  → {"  G"," Go","Goo","oog","ogl","gle","le "}
"googl"   → {"  g"," go","goo","oog","ogl","gl "}
shared {"goo","oog","ogl"} → similarity ≈ 0.5
```
The GIN trigram index (`job_title_trgm`) makes `WHERE "jobTitle" % $text` an index lookup (~3ms) instead of a seq scan. Catches typos (`"engneer"`), variants, and partials (`"front"` → `Frontend Engineer`). Misses strings with no shared 3-grams (`"SDE"` ↔ `"Software Engineer"`) — that's what the vector tier is for.

### The embedding model
[`lib/embeddings.ts`](../lib/embeddings.ts) uses `amazon.titan-embed-text-v2:0` via the AWS Bedrock API:
- 512-dim, normalized (cosine-ready unit vectors)
- Requires `AWS_REGION` env var; credentials resolve from the standard AWS chain
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

## Final query — union, blend, floor/backfill (one CTE pipeline)

One `$queryRaw` over `Job JOIN Company`. The experience band is a hard filter; everything else is **OR-ed into a union**. The sub-scores, the blend, the per-tier floor, and the final order/limit are **all in SQL** — so a 30-row `LIMIT` is a correct top-N by match % (the JS side is just a row→card mapper).

```sql
WITH raw AS (          -- union candidate set + raw counts/cosine + tier flag
  SELECT j.*, c.name,
    CASE WHEN $hasSkills THEN cov.matched ELSE NULL END               AS matched,
    cov.required,
    CASE WHEN $hasProjVecs AND j.embedding IS NOT NULL
         THEN (SELECT MAX((1 - (j.embedding <=> pv::vector))::float)
               FROM unnest($projVecLits::text[]) AS pv)
         ELSE NULL END                                                AS "projSim",
    ( job ∈ titleIds OR company ∈ companyIds )                        AS "roleOrCompanyMatched"
  FROM "Job" j JOIN "Company" c ON c.id = j."companyId"
  CROSS JOIN LATERAL ( -- over j.requiredSkills split on , ; |
    --   matched  = job skill tokens covered by any input skill  (ILIKE substring)
    --   required = count of non-empty job skill tokens
  ) cov
  WHERE ( $experienceYears IS NULL
          OR $experienceYears BETWEEN COALESCE(min,0) AND COALESCE(max,99) )  -- hard filter
    AND ( job ∈ titleIds OR company ∈ companyIds
       OR cov.matched > 0 )                                                    -- UNION
),
sub AS (    SELECT *, skillsPct, projectsPct FROM raw ),     -- see Scoring below
scored AS ( SELECT *, score = mean(non-null [skillsPct, projectsPct]) FROM sub ),
ranked AS ( SELECT *,
              ROW_NUMBER() OVER (PARTITION BY "roleOrCompanyMatched"
                                 ORDER BY score DESC NULLS LAST, "createdAt") AS rn_in_tier
            FROM scored ),
pick AS (   SELECT * FROM ranked          -- SELECTION (which 30)
            ORDER BY CASE WHEN $sort='default' AND rn_in_tier <= 15 THEN 0 ELSE 1 END,
                     score DESC NULLS LAST, "createdAt"
            LIMIT 30 )                                                        -- RESULT_LIMIT
SELECT * FROM pick                         -- DISPLAY order
ORDER BY CASE WHEN $sort='default' AND "roleOrCompanyMatched" THEN 0 ELSE 1 END,
         score DESC NULLS LAST, "createdAt";
```

### Candidate set (which jobs qualify) — a union, not an AND
A job enters the set if it matches **any** signal:

- **Role** — `j.id ∈ titleIds` from `matchTitleIds` (exact ∪ trigram ∪ vector).
- **Company** — `j."companyId" ∈ companyIds` from `matchCompanyIds`.
- **Skills** — `matched > 0`: the job shares ≥1 of the typed skills.

Typing a role therefore **also** surfaces skill-matched jobs that don't match the role. **Experience is the only hard filter**: the typed years must fall inside the job's `[min, max]` band (null input → disabled; null job bounds → open-ended `0`/`99`). Experience is never scored or shown. `roleOrCompanyMatched` records whether a job came in via the role/company tier; it drives the default sort and the floor.

---

## Scoring — the blended match % (computed in SQL)

The headline `score` is the **equal mean** of whichever sub-scores apply — no weights ([`lib/search.ts`](../lib/search.ts), the `sub`/`scored` CTEs).

### Skills% (`skillsPct`)
```
coverage  = (job skill tokens covered by an input skill) / (job's skill-token count)
skillsPct = round(coverage × 100)            // e.g. 5/7 → 71
```
Both sides are normalized (lowercased, non-alphanumerics stripped) and matched as a substring against the job's `,`/`;`/`|`-split tokens, so `"node.js"` matches `"NodeJS"`. No skills typed → `skillsPct` null.

### Projects% (`projectsPct`) — semantic, per-project
Only scored when the resume has project keywords (extracted by LLM at parse time, see [`PROJECT_BASED_RETRIEVAL.md`](./PROJECT_BASED_RETRIEVAL.md)). Each project's keyword string is embedded separately via Bedrock Titan; `projSim` is the MAX cosine across all project vectors for that job:

```
projSim     = MAX cosine(job.embedding, projVecLits[i])   for i in projects
projectsPct = round( clamp( (projSim - 0.40) / 0.60, 0, 1 ) × 100 )
```

`PROJ_SIM_FLOOR = 0.40` filters Titan's background noise (~0.10–0.20 for unrelated texts). No project keywords → `projectsPct` null (projectless candidates aren't penalized).

### Blend
```
score = round( mean( non-null [skillsPct, projectsPct] ) )
```
Both null → `score` null → badge `—`. The card hover shows the `Skills%` / `Projects%` breakdown behind the headline.

---

## Sort modes — and the 15-floor / backfill

The blend is the SQL `ORDER BY` key, so each mode `LIMIT 30` correctly. The UI toggle (`Best match` / `Match score`) re-runs the search with the chosen mode.

- **`default` (Best match):** role/company matches on top, but each tier is **guaranteed up to `TIER_FLOOR = 15` slots**, then the list **backfills toward 30** by score.
  - *Selection* (`pick`): `rn_in_tier ≤ 15` of each tier is kept first, remaining slots filled by `score DESC`. So 40 role + 3 skill → 27 role + 3 skill (skill floor honored, role backfills); 3 role + 40 skill → 3 role + 27 skill.
  - *Display*: role/company tier first, then by `score`.
- **`score` (Match score):** pure `score DESC` top-30, tier ignored — a higher-scoring non-role job can top the list.

> Worked example: a resume matches **JD-X** (role-name match, 5/10 skills) and **JD-Y** (no role match, 10/10 skills). `default` → JD-X above JD-Y (role tier wins). `score` → JD-Y above JD-X (higher blend).

The thin JS mapper then parses `focusRoundPattern` into rounds and maps `experienceMinYears` to a display `seniority` via `deriveSeniority` (`≤2 entry`, `≤6 mid`, else `senior`) — no re-sorting (SQL already ordered + limited).

---

## Limits at a glance

| Stage | Limit | Constant |
|---|---|---|
| Title tier — exact / trigram / vector (each) | 20 | `TITLE_CANDIDATES` |
| Company tier — exact / trigram (each) | 5 | literal |
| Best-match floor — slots guaranteed per tier | 15 | `TIER_FLOOR` |
| Final list returned / displayed (and SQL `LIMIT`) | 30 | `RESULT_LIMIT` |

Retrieval equals display: the query computes the blend in SQL and `LIMIT 30`s directly — there is no oversized candidate pool. Under `default`, each tier (role/company vs skill/project) is guaranteed up to 15 of those 30, then the other backfills toward 30. Role backfill is in turn bounded by how many ids the title tiers yield (≤20 each).

---

## What the inputs mean

| Input | Candidate set | Score | Order (default) |
|---|---|---|---|
| `Accenture` | Accenture jobs (company tier) | badge `—` (no skills) | role/company tier, then recency |
| `SDE` | title matches **∪** any skill/project matches | skills/projects where present | title matches first |
| `[React, Node.js]` | jobs sharing ≥1 skill | coverage % (+ projects if resume) | by blended % |
| `SDE` + `[React]` + `3 yrs` | title ∪ skill matches, band-filtered | React coverage (+ projects) | title matches first, then % |
| resume w/ projects | (no extra candidates) | skills% **and** projects% blended | role/company first, then % |
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
| [`lib/embeddings.ts`](../lib/embeddings.ts) | Bedrock Titan v2 embeddings + LRU cache + `toPgVectorLiteral` |
| [`lib/rounds.ts`](../lib/rounds.ts) | `parseRounds()` — `focusRoundPattern` → ordered round list |
| [`lib/onboarding.ts`](../lib/onboarding.ts) | `deriveSearchInput` — profile → `SearchInput` (incl. `projectTexts`, `sort`) |
| [`lib/types.ts`](../lib/types.ts) | `JobCard` (`score`, `skillsPct`, `projectsPct`, `roleOrCompanyMatched`), option types |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Company` / `Job` models + `vector(512)` embedding |
| [`prisma/db-init.sql`](../prisma/db-init.sql) | Extensions, GIN/HNSW indexes, dedup key |
| [`prisma/import-jobs.ts`](../prisma/import-jobs.ts) | Source import, dedup, composite job embeddings |
| [`app/api/search/route.ts`](../app/api/search/route.ts) | `POST /api/search` → `searchJobs` |
| [`app/page.tsx`](../app/page.tsx) | Filters (role, company, experience, skills), sort toggle, card hover breakdown |
</content>
</invoke>
