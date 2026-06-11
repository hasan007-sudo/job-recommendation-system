# Importing jobs — required fields and embedding inputs

How to import jobs so that search, match scoring, and the per-table embeddings
are populated correctly. Every embedding input below is explicit: if a field
feeds a vector, it is named here. Read this before adding a new job source or
changing any field on import.

## Environment required at import time

| Variable | Used for |
|---|---|
| `ROUND_DB_URL` | Target Postgres (writes) |
| `SOURCE_DATABASE_URL` | Source `JobPostingsV2` table (only `prisma/import-jobs.ts`) |
| `AWS_REGION` + AWS credential chain | Bedrock Titan embeddings (all vectors) |
| `OPENROUTER_API_KEY` | Skill gloss generation (new `Skill` tokens only) |
| `LLM_MODEL` (optional) | Gloss model; defaults to `openai/gpt-4o-mini` |

> Glossing made `OPENROUTER_API_KEY` an import-time dependency. Without it,
> imports fail as soon as a never-seen skill token appears.

## Commands, in order

```bash
npm run db:import                                    # import + embed from JobPostingsV2 (dry-run first; add --confirm)
npx tsx prisma/seed-jd-files.ts --confirm            # seed the inlined local-JD jobs
npx tsx scripts/backfill-job-match-embeddings.ts     # populate/repair Skill, JobSkill, JobCapability for ALL jobs
npx tsx scripts/reembed-jobs.ts                      # only after changing the Job.embedding composite text
```

Both import scripts call `backfillJobMatchData()` themselves at the end, so a
normal import needs no separate backfill run. The standalone backfill script is
for repair and for jobs created outside the importers. It is resumable and
self-healing: a job is rebuilt unless its stored rows exactly match what the
current field values produce, and rows with interrupted embedding writes
(NULL vector) are repaired.

---

## Table-by-table: fields and embedding inputs

### `Company`

| Field | Required | Source / rule |
|---|---|---|
| `name` | **yes** | `company_name`, trimmed; unique. Rows without it are skipped. |

No embedding. Company search is exact name → trigram.

### `Job`

A source row is imported only if **both** `job_title` and `company_name` are
non-empty. Everything else degrades gracefully but costs scoring quality — see
the consequences column.

| Field | Required | Consequence when missing |
|---|---|---|
| `jobTitle` | **yes** | Row skipped entirely |
| `companyId` (via company name) | **yes** | Row skipped entirely |
| `sourceRowHash` | **yes** (importer derives a fallback) | Dedup key; rows without `row_hash` fall back to `company:title` and same-title duplicates collapse |
| `roleType` | recommended | Role embedding loses the role-category signal |
| `roleSummary` | **recommended strongly** | Role embedding loses domain context AND one capability is lost |
| `requiredSkills` | **required for scoring** | No `JobSkill` rows → `requiredSkillScore` has nothing to cover; job can never enter the skill retrieval path |
| `keyResponsibilities` | recommended | Fewer capabilities (project evidence relies on the union below) |
| `roundTechnical` | recommended | The strongest project-evidence capability for technical roles is lost |
| `roundScreening` / `roundBehavioural` / `roundCultureFit` | recommended | Interview-round display only (no embedding) |
| `focusRoundPattern` | **yes** | Fixed string `"Screening + Behavioural + Technical + Culture fit"`; round parsing breaks without it |
| `experienceMinYears` / `experienceMaxYears` | optional | NULL = open-ended (`0–99`) in the experience hard filter |
| `fullJobDescription`, `location`, `workMode`, salary, education… | optional | Display only |

**`Job.embedding` (vector 512) — role retrieval ONLY.** Input text:

```text
`${jobTitle}. ${roleType ?? ""}. ${roleSummary ?? ""}`
```

- Do **not** append skills to this text (the old composite did; it was removed —
  skills have their own per-token vectors).
- Used exclusively for the title-tier ANN ("SDE" → "Software Engineer") and
  never for the displayed match %.
- If you change this composite, change it in **all three places** (they must
  stay identical): `prisma/import-jobs.ts`, `prisma/seed-jd-files.ts`,
  `scripts/reembed-jobs.ts` — then run `scripts/reembed-jobs.ts` for all jobs.

### `Skill` (deduped catalog — auto-populated, never hand-inserted)

One row per **distinct normalized token** across all jobs. Created automatically
by the backfill when a token is first seen; existing tokens are never
re-glossed or re-embedded (DB-unique on `token` guarantees once-only).

| Field | Rule |
|---|---|
| `token` | `lower(name)` with everything except `[a-z0-9+#]` stripped — `+` and `#` are kept so `C`, `C++`, `C#` stay distinct |
| `label` | The display name as first seen (e.g. `"Machine learning"`) |
| `gloss` | LLM one-liner (8–15 words, acronyms expanded), generated in batches via OpenRouter |
| `embedding` | **`embed(gloss)` — NEVER `embed(token)`** |

Bare-token embeddings are not separable (measured: `aws↔cloud computing` 0.23
vs the unrelated `c++↔python` 0.26 — no usable threshold). Glossed embeddings
separate cleanly (signal 0.25–0.62, noise 0.00–0.15). If you ever bulk-insert
skills by hand, you must write a real gloss and embed the gloss, or semantic
matching silently degrades for those tokens.

### `JobSkill` (thin join — auto-populated)

Built by splitting `Job.requiredSkills` on the separators `,` `;` `|`,
trimming, and deduping by normalized token. No vector — match scoring is set
membership against the per-search covered-skill ids.

**Source-data rule:** `required_skills` must be a separator-delimited list of
individual skill names, e.g.

```text
Python; C; C++; Machine learning; Data analytics; Communication
```

- One skill per token — don't pack prose sentences into this field; each token
  becomes a catalog skill and is glossed as a unit.
- Soft skills (e.g. `Communication`) are fine and intentionally matchable: the
  resume parser extracts candidate soft skills too.
- Every token counts in the match-score denominator
  (`covered / required × 100`), so noise tokens directly deflate every
  candidate's score for that job.

### `JobCapability` (one statement per row — auto-populated)

Project evidence compares candidate project vectors against these rows.
Built from the **union** of three fields:

| Source field | Becomes |
|---|---|
| `keyResponsibilities` | one capability per `;`-separated statement |
| `roleSummary` | one capability (always included, not only as fallback) |
| `roundTechnical` | one capability (the technical interview competencies) |

| Field | Rule |
|---|---|
| `text` | the trimmed statement (deduped within the job) |
| `embedding` | `embed(text)`, one vector per statement |

**`requiredSkills` is deliberately EXCLUDED** from capabilities. Skills already
own 65% of the blend; adding them here would turn the formula into
"65% skills + 35% mixture of projects and skills" and inflate candidates with
matching skills but no project evidence. Do not add it back.

**Source-data rule:** write `key_responsibilities` as `;`-separated, complete
statements describing what the role actually does — these are compared
semantically against project descriptions, so token lists score worse than
sentences. A job whose responsibilities are all non-technical (e.g. client
engagement) will legitimately score low on project evidence; `roundTechnical`
is what carries the technical signal in that case, so fill it.

---

## Quick reference: which fields feed which vector

```text
Job.embedding            ←  jobTitle + roleType + roleSummary          (role ANN only)
Skill.embedding          ←  LLM gloss of each distinct requiredSkills token
JobCapability.embedding  ←  each keyResponsibilities statement
                            + roleSummary
                            + roundTechnical                           (requiredSkills EXCLUDED)
(candidate side, no storage)
  skill vectors          ←  per-skill gloss from the resume parser
  project vectors        ←  project description + keywords
```

All vectors are Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`),
512-dim, normalized (`lib/embeddings.ts`). Embedding inputs are lowercased by
the embed cache key; this is consistent on both sides.

## Validation checklist after an import

1. Counts line up — every job with `requiredSkills` has links, every job has
   capabilities:
   ```bash
   npx tsx scripts/backfill-job-match-embeddings.ts   # should report "0 need skills, 0 need capabilities"
   ```
2. Spot-check a new job's rows: its `Skill.gloss` values read like real
   descriptions (not bare names), and its capabilities are sentences, not blobs.
3. Score a known resume against a known job:
   ```bash
   npx tsx --env-file=.env scripts/match-score-probe.ts <jobId>
   npx tsx --env-file=.env scripts/verify-aswathy.ts          # Tiger Analytics acceptance pair
   ```
4. If you changed the `Job.embedding` composite: `scripts/reembed-jobs.ts`,
   then re-check role search ("Data Science" must still surface
   "Data Science Analyst").
