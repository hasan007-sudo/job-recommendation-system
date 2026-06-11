# How search works

Search resolves an input `{ companyText, roleText, skills[], experienceYears, projectTexts?, sort? }` to a ranked list of **job cards** (`JobCard[]`). Each card is one real scraped job; its interview rounds are parsed at read time from the job's `focusRoundPattern`.

The model has three parts:

1. **Candidate set (a union of four bounded paths).** Company, role (title), skills, and projects (via job capabilities) each *bring jobs in*. A job qualifies if it matches **any** of them. Experience is the one hard filter. Every path is bounded — no path can dump the table.
2. **Match % (a fixed 65/35 blend).** `matchScore = 0.65 × requiredSkillScore + 0.35 × projectEvidenceScore`. Preference (company/role) never changes the %.
3. **Sort.** `default` ("Best match") tiers results **company → role → personalized** with a company cap and a role reservation; `score` ("Match score") ranks purely by matchScore.

```
{ companyText, roleText, skills[{name, gloss}], experienceYears, projectTexts[], sort }
        │
        │  STEP A — resolve covered skills (catalog-sized, independent of job count)
        ▼
┌────────────────────────────────────────────────────────────────────┐
│ resolveCoveredSkillIds: Skill rows WHERE                            │
│   token = candidate token (exact normalized)                        │
│   OR max cosine(Skill.embedding, embed(gloss) per skill) ≥ 0.30     │
└────────────────────────────────────────────────────────────────────┘
        │
        │  STEP B — four retrieval paths, in parallel, all bounded
        ├──────────────────┬──────────────────┬──────────────────┬──────────────────┐
        ▼                  ▼                  ▼                  ▼                  │
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐│
│ matchTitleIds    │ │ matchCompanyIds  │ │ matchSkillJobIds │ │matchProjectJobIds││
│ exact ∪ trigram  │ │ exact → trigram  │ │ ≥1 covered skill │ │ ANN top-50 over  ││
│ ∪ vector ANN     │ │ (first confident)│ │ top 1,000 by     │ │ JobCapability    ││
│ → ≤20 per tier   │ │ → ≤5 company ids │ │ coverage ratio   │ │ per project vec  ││
└──────────────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
        │                  │                  │                  │
        └────────┬─────────┴──────────────────┴──────────────────┘
                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Guard: all four paths empty → []                              │
   └──────────────────────────────────────────────────────────────┘
                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ STEP C — one SQL over the union (CTE pipeline):               │
   │   WHERE experience-band (hard filter) AND (∈ any path)        │
   │   requiredSkillScore = covered JobSkill ids / required × 100  │
   │                        (set membership — no per-job vectors)  │
   │   projectEvidence    = AVG over the job's capabilities of     │
   │                        MAX cosine(capability, project vecs)   │
   │                        rescaled through window 0.10–0.35      │
   │   matchScore = round(0.65·skills + 0.35·projects)             │
   │   tier = 0 company · 1 role · 2 personalized                  │
   │   ── default: tier 0 capped at 10 · tier 1 reserves           │
   │      min(10, available) · rest backfills by matchScore        │
   │   ── score:   pure top-N by matchScore                        │
   │   LIMIT 30  (MAX_RESULTS)                                     │
   └──────────────────────────────────────────────────────────────┘
                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ JS: thin map row → JobCard, parseRounds (no re-sort)          │
   └──────────────────────────────────────────────────────────────┘
                 ▼
            JobCard[]
```

All matchers and scoring live in [`lib/search.ts`](../lib/search.ts).
`scoreJobMatch(jobId, input)` reuses the same covered-skill resolution and the
same scoring SQL fragments scoped to one job — the job detail page's badge and
the search list can never disagree.

---

## Data model

```prisma
model Company { id, name @unique, jobs Job[] }

model Job {
  id, companyId
  jobTitle, requiredSkills?, roleSummary?, roleType?, keyResponsibilities?, roundTechnical?, ...
  focusRoundPattern
  experienceMinYears?, experienceMaxYears?
  embedding vector(512)?      // ROLE retrieval only: title + roleType + roleSummary
  skills        JobSkill[]
  capabilities  JobCapability[]
}

model Skill {                 // deduped catalog: one row per distinct token
  token @unique               // normalized; '+'/'#' kept so C / C++ / C# stay distinct
  label, gloss                // gloss = LLM one-liner; THE embedding input
  embedding vector(512)?
}

model JobSkill { jobId, skillId }          // thin join, no vector

model JobCapability {                       // one responsibility statement per row
  jobId, text
  embedding vector(512)?                    // from keyResponsibilities ∪ roleSummary ∪ roundTechnical
}
```

Why glosses and why the catalog is deduped: see
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Field-by-field import rules:
[`IMPORTING_JOBS.md`](./IMPORTING_JOBS.md). Rounds are still parsed at read
time from `focusRoundPattern` by [`parseRounds()`](../lib/rounds.ts).

---

## Step A — covered-skill resolution

The candidate's skills arrive as `{ name, gloss }` pairs (the resume parser
generates the gloss in the same LLM call that extracts the skill; manually
typed skills have no gloss). Coverage is resolved **once per search** against
the `Skill` catalog:

```sql
SELECT id FROM "Skill"
WHERE token = ANY($candidateTokens)                            -- exact normalized
   OR (embedding IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest($glossVecs) v
        WHERE (1 - (embedding <=> v::vector)) >= 0.30))        -- SEMANTIC_SKILL_MIN
```

- Exact matching always wins; semantic extends it, never replaces it.
- Skills without a gloss (manually typed chips, pre-gloss profiles, external
  API callers) get **catalog-fallback semantics**: if the token exists in the
  `Skill` catalog, that row's stored gloss embedding stands in as the query
  vector (a SQL self-join — zero extra LLM/Bedrock calls).
- Tokens the catalog has never seen trigger **gloss-on-miss**: one batched LLM
  call glosses them, they're embedded and upserted into the catalog *without*
  `JobSkill` links (link-less rows are invisible to scoring denominators — the
  catalog doubles as a global gloss cache). First request pays ~1–2s; every
  later request from any caller is a catalog hit. Guardrails: ≤20 new glosses
  per request, skill names ≤60 chars; on LLM failure those skills degrade to
  exact-only instead of failing the search.
- We never embed a bare skill name — bare-token embeddings are too noisy to
  trust (measured: `c++↔python` 0.26 vs `aws↔cloud computing` 0.23; glossed:
  noise ≤0.15, signal ≥0.33).
- Embedding/LLM work happens only when the search or match API is called
  (the "Update results" click / post-onboarding autosearch) — never per
  keystroke; chip autocomplete is purely client-side.
- This is catalog-sized work (~10³–10⁴ rows), independent of job count. After
  it, per-job scoring is **set membership** over the indexed `JobSkill` join —
  no per-job vector math for skills, which is what lets this scale to millions
  of jobs.

## Step B — four bounded retrieval paths

| Path | How | Bound |
|---|---|---|
| Company | exact name → trigram (≥0.4) | ≤5 companies |
| Role (title) | exact ∪ trigram (≥0.3) ∪ `Job.embedding` ANN | ≤20 per tier |
| Skills | jobs with ≥1 `JobSkill.skillId ∈ coveredSkillIds`, **ordered by coverage ratio** (`covered/required`, GROUP BY over the indexed join, experience filter applied first) | top 1,000 (`MAX_SKILL_CANDIDATES`) |
| Projects | HNSW ANN over `JobCapability.embedding` per project vector | top 50 per vector (`MAX_CAPABILITY_MATCHES`) |

The skill-path bound matters at scale: a common covered skill like `python`
could match tens of thousands of jobs. The coverage-ratio `ORDER BY` before the
`LIMIT` is intentional — without it the cap would keep arbitrary low-coverage
jobs. Do not "optimize" the aggregation away.

`Job.embedding` is now embedded from **title + roleType + roleSummary only**
(no skills suffix) and is used solely for the title ANN tier — never for the
displayed match %.

## Step C — scoring (all in SQL)

```
requiredSkillScore   = covered / required × 100        (set membership; 0 when the
                                                         candidate offers no skills)
capabilityEvidence   = per capability: MAX cosine vs project vectors,
                       rescaled through window 0.10 (floor) – 0.35 (ceiling)
projectEvidenceScore = AVG(capabilityEvidence) across the job's capabilities
                       (0 when the candidate has no projects)

matchScore = round( 0.65 × requiredSkillScore + 0.35 × projectEvidenceScore )
```

- Weights are fixed — skills carry the score, projects support it. Missing
  evidence scores 0, not null, so a projectless resume caps at 65. (Only when
  the candidate supplies *neither* skills nor projects is the score null —
  badge shows `—`.)
- Details, calibration data, and the project↔capability model:
  [`PROJECT_BASED_RETRIEVAL.md`](./PROJECT_BASED_RETRIEVAL.md).

## Tiers and slot selection (`default` sort)

`tier` records preference, never the %: `0` selected company, `1` requested
role, `2` personalized (skills/projects). A job takes its highest-priority
matching tier.

- **Tier 0 (company): hard cap 10** (`TIER0_CAP`) — a large company can't
  consume the whole list.
- **Tier 1 (role): reserve `min(10, available)`** (`TIER1_RESERVE`) — the first
  10 role jobs can never be displaced by Tier 2; role jobs beyond 10 compete in
  backfill by matchScore (neither capped at 10 nor unconditionally guaranteed 10).
- **Backfill**: remaining slots fill by matchScore from tier-1 extras and tier 2,
  up to `MAX_RESULTS = 30`.
- **Display**: tier ASC, then `matchScore DESC, createdAt ASC` within each tier.

`score` sort ignores tiers entirely: global top-30 by matchScore.

## Limits at a glance

| Stage | Limit | Constant |
|---|---|---|
| Title tier — exact / trigram / vector (each) | 20 | `MAX_TITLE_MATCHES_PER_TIER` |
| Company tier — exact / trigram (each) | 5 | literal |
| Skill path — candidates by coverage ratio | 1,000 | `MAX_SKILL_CANDIDATES` |
| Project path — capability ANN per project vector | 50 | `MAX_CAPABILITY_MATCHES` |
| Tier 0 (company) display cap | 10 | `TIER0_CAP` |
| Tier 1 (role) reserved slots | 10 | `TIER1_RESERVE` |
| Final list (and SQL `LIMIT`) | 30 | `MAX_RESULTS` |
| Semantic skill coverage floor | 0.30 | `SEMANTIC_SKILL_MIN` |
| Project-evidence window | 0.10–0.35 | `PROJECT_EVIDENCE_MIN/MAX` |
| Blend weights | 65/35 | `SKILL_WEIGHT` / `PROJECT_WEIGHT` |

## What the inputs mean

| Input | Candidate set | Score | Order (default) |
|---|---|---|---|
| `Accenture` | Accenture jobs (tier 0, ≤10) | badge `—` (nothing to score) | company first, then recency |
| `Data Science` | title matches ∪ nothing else | `—` | role tier |
| skills only | top-1,000 coverage-ranked jobs | 65% × coverage | by matchScore |
| parsed resume (skills + projects) | skills ∪ capability-ANN matches | full 65/35 blend | role reserve, then matchScore |
| company + resume | all four paths | full blend (company does NOT boost %) | company (≤10) → role (≥10) → rest |
| nothing | — | — | `[]` (guard) |

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Covered-skill resolution, four matchers, scoring SQL, tiers, `scoreJobMatch` |
| [`lib/glosses.ts`](../lib/glosses.ts) | `normalizeSkillToken`, batched LLM gloss generation |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | Bedrock Titan v2 embeddings + LRU cache + `toPgVectorLiteral` |
| [`lib/job-match-backfill.ts`](../lib/job-match-backfill.ts) | Populates/repairs `Skill`, `JobSkill`, `JobCapability` (resumable, self-healing) |
| [`lib/resume.ts`](../lib/resume.ts) | Parser: skills as `{name, gloss}` incl. soft skills, projects + keywords |
| [`lib/onboarding.ts`](../lib/onboarding.ts) | `deriveSearchInput` — profile → `SearchInput` (glossed skills, project texts) |
| [`lib/types.ts`](../lib/types.ts) | `JobCard` (`score`, `skillsPct`, `projectsPct`, …) |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `Company` / `Job` / `Skill` / `JobSkill` / `JobCapability` |
| [`app/api/search/route.ts`](../app/api/search/route.ts) | `POST /api/search` → `searchJobs` (accepts `skills` or legacy `skillNames`) |
| [`app/api/jobs/[jobId]/match/route.ts`](../app/api/jobs/%5BjobId%5D/match/route.ts) | `POST` → `scoreJobMatch` for the job detail badge |
| [`app/page.tsx`](../app/page.tsx) | Filters, sort toggle, "Required skills" / "Project evidence" breakdown |
