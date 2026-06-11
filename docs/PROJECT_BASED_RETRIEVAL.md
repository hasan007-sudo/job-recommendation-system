# Project-based retrieval & scoring

How a candidate's **project experience** affects job search results.
Logic lives in [`lib/search.ts`](../lib/search.ts),
[`lib/resume.ts`](../lib/resume.ts), [`lib/onboarding.ts`](../lib/onboarding.ts),
and [`lib/job-match-backfill.ts`](../lib/job-match-backfill.ts).

> **TL;DR** — Each job stores one embedded **capability** per responsibility
> statement (`JobCapability`). Each candidate project is embedded from its
> **description + keywords**. `projectEvidenceScore` = the average, across the
> job's capabilities, of each capability's best project cosine, rescaled
> through the 0.10–0.35 evidence window. Projects also **retrieve** candidates
> now: a capped ANN (top-50 per project vector) over capability embeddings
> pulls jobs into the result set. The score contributes 35% of the blend.

This replaces the old model (project keywords vs the single composite
`Job.embedding`, MAX cosine, 0.40 floor). That model was measured dead
corpus-wide: 0 of 215 jobs crossed the 0.40 floor because keyword-list queries
vs composite job text peak at cosine ~0.17.

---

## Job side: `JobCapability`

Built at import/backfill from the **union** of three fields (one embedded row
per statement, deduped):

```text
keyResponsibilities  → one capability per ';'-separated statement
roleSummary          → one capability (always, not only as fallback)
roundTechnical       → one capability (technical interview competencies)
```

`requiredSkills` is **deliberately excluded** — skills already own 65% of the
blend; a skills capability would turn the formula into
"65% skills + 35% mixture of projects and skills" and inflate candidates with
matching skills but no project evidence.

Why the union (measured, Tiger Analytics "Data Science Analyst" vs a real ML
project): the job's two responsibilities are client-engagement statements
scoring 0.04–0.10 (noise), while the signal lives in `roundTechnical` (0.19)
and `roleSummary` (0.13–0.18). Responsibilities-only would leave project
evidence at ~0 for this job.

## Candidate side: project texts

```
Resume upload
  → parseResume() [OpenRouter LLM]             lib/resume.ts
      projects[i] = { name, description, keywords[3–8] }
  → mapToProfile()
      profile.projects        = ["Name · description", ...]
      profile.projectKeywords = [["machine learning", ...], ...]
  → deriveSearchInput(profile)                 lib/onboarding.ts
      projectTexts[i] = `${projects[i]}. Keywords: ${keywords[i].join(", ")}`
  → POST /api/search { projectTexts }  /  POST /api/jobs/:id/match
```

**Description + keywords, not keywords alone** — descriptions carry the
stronger evidence of what was built, and prose-vs-prose comparison scores
better against capability statements than bare keyword lists. Profiles parsed
before keywords existed fall back to prose-only; keyword-only profiles fall
back to joined keywords.

Each project text is embedded separately (Bedrock Titan, LRU-cached).

---

## Retrieval: projects now ADD candidates (bounded)

Unlike the old model, projects pull jobs into the candidate set — via a
**capped** ANN per project vector over the HNSW-indexed capability embeddings:

```sql
SELECT DISTINCT "jobId" FROM (
  SELECT "jobId" FROM "JobCapability"
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $projVec::vector
  LIMIT 50                                   -- MAX_CAPABILITY_MATCHES
) nearest
```

The cap mirrors the title tier's top-20: a permissive similarity can never
flood the candidate set. Scoring then runs only on the bounded union.

## Scoring: AVG over capabilities of best-project cosine

```sql
-- per candidate job (LEFT JOIN LATERAL in lib/search.ts):
capabilityEvidence(c) = GREATEST(0, LEAST(1,
    (MAX cosine(c.embedding, projectVecs) - 0.10) / (0.35 - 0.10))) × 100

projectEvidenceScore  = AVG(capabilityEvidence) across the job's capabilities
```

| Constant | Value | Meaning |
|---|---|---|
| `PROJECT_EVIDENCE_MIN` | `0.10` | Below this → 0 evidence. Measured noise: 0.04–0.10. |
| `PROJECT_EVIDENCE_MAX` | `0.35` | At/above this → 100. Measured signal starts ~0.13. |

- **MAX across projects, per capability** — each capability is evidenced by the
  candidate's most relevant project; unrelated projects don't dilute it.
- **AVG across capabilities** — a project must cover the breadth of the role,
  not just one line. This is deliberately strict: dead capabilities (e.g.
  client-engagement statements an academic project can't evidence) pull the
  average down. That's the model being honest about role breadth, not a bug.
- Do not reuse the old `0.40` floor — it was calibrated for a different
  comparison and zeroes everything in this one.

**Blend:**
```
matchScore = round( 0.65 × requiredSkillScore + 0.35 × projectEvidenceScore )
```
No projects → `projectEvidenceScore = 0` (fixed weights; the UI shows the
breakdown so a 65-capped score is explainable).

---

## Worked example (real, verified)

Aswathy B (B.Tech Data Science; ML + image-classification projects) vs
Tiger Analytics — Data Science Analyst:

```text
capability                                        best cos   evidence
"Engage with clients to understand …"               0.040          0
"Translate business problems …"                     0.086          0
roleSummary "…data analytics and machine learning"  0.183         33
roundTechnical "Python/C/C++; Data analytics; ML…"  0.221         48
                                   projectEvidenceScore = AVG ≈ 16

requiredSkillScore = 4/6 = 67   (C, C++ honestly uncovered)
matchScore = 0.65 × 67 + 0.35 × 16 = 49        (old model: 17)
```

Her ML project is what scores against the technical capability; the consulting
JD's client-facing lines are honestly unevidenced by academic projects.

---

## What projects do and don't do

- **Do**: retrieve up to 50 jobs per project vector (capability ANN) and
  contribute 35% of every candidate job's score.
- **Don't**: affect tier ordering (preference is company/role only), or
  substitute for skills (capabilities deliberately exclude `requiredSkills`).
- **No keyword substring matching** — fully semantic since the capability model.

## Limitations

1. **Capability quality = source-data quality.** Jobs whose
   `keyResponsibilities` are vague or non-technical lean entirely on
   `roleSummary`/`roundTechnical` for signal — see
   [`IMPORTING_JOBS.md`](./IMPORTING_JOBS.md) for authoring rules.
2. **AVG punishes breadth gaps by design.** A candidate matching 1 of 4
   capabilities scores ~25 on this channel even with a perfect hit. If that
   proves too strict in practice, the calibrated alternative is a top-k mean —
   not raising the ceiling blindly.
3. **The window needs ongoing calibration.** 0.10–0.35 comes from one verified
   pair plus corpus probes; validate against more resume/JD pairs with
   [`scripts/match-score-probe.ts`](../scripts/match-score-probe.ts) before
   trusting it as final.
