# Project-based retrieval & scoring

How a candidate's **project text** (resume project names + descriptions) affects job
search. Companion to [`search.md`](./search.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).
All logic lives in [`lib/search.ts`](../lib/search.ts).

> **TL;DR** — Projects do two jobs: they can **get** a job into the result set
> (candidacy) and they **score** it (half the match %). "Getting" uses *keyword*
> overlap only; "scoring" uses keyword overlap, falling back to a *coarse* embedding
> cosine. Synonyms (e.g. `AWS` ↔ "cloud computing") are **not** matched at the skill
> level today — see [Limitations](#limitations).

---

## Where project text comes from

```
resume parse → profile.projects[]            // {name, description} → "name · description"
  └ deriveSearchInput (lib/onboarding.ts)     // projectText = profile.projects.join(". ")
      └ POST /api/search { projectText }
          └ searchJobs(input)  (lib/search.ts)
```

There is no UI field to type project text — it always rides along from the parsed
resume. Two values are derived once per request (`searchJobs`):

```
projTextNorm = projectText.toLowerCase().replace(/[^a-z0-9]/g, "")   // for keyword matching
projVec      = embed(projectText)                                    // for the cosine fallback
```

`projTextNorm` strips **all** non-alphanumerics (including spaces) into one blob, e.g.
`"Built with React, Docker"` → `"builtwithreactdocker"`.

---

## Two roles: getting vs scoring

| | GETTING (candidacy) | SCORING (the %) |
|---|---|---|
| Signal used | `projMatched` (keyword) only | `projMatched` → else `projSim` (cosine) |
| Effect | adds the job to the union set | sets `projectsPct`, half the blend |

**Getting** — the `raw` CTE `WHERE` (union):
```sql
WHERE <experience band>                    -- hard filter
  AND ( job ∈ titleIds OR company ∈ companyIds
     OR cov.matched     > 0
     OR cov."projMatched" > 0 )            -- ← projects can qualify a job alone (keyword only)
```

**Scoring** — `sub` → `scored` CTEs:
```
projMatched = COUNT(job's normalized skill tokens that appear as a substring in projTextNorm)
projectsPct = projMatched > 0  → round(projMatched / required × 100)     -- keyword path
              else projSim≠null → rescale(projSim)                        -- coarse cosine fallback
              else             → null
score       = round( mean( non-null [skillsPct, projectsPct] ) )         -- equal blend, no weights
```

- `projSim = 1 - (job.embedding <=> projVec)` — cosine similarity of the **whole project
  text** vs the **whole job composite embedding** (title + roleType + summary + skills).
- `rescale(x) = round(greatest(0, least(1, (x - 0.15) / 0.55)) × 100)` — maps the useful
  cosine band (~0.15–0.70) onto 0–100.
- **Key:** `projSim` only ever *scores* a job already in the set. It **never** pulls a job
  in. A job with `matched = 0` **and** `projMatched = 0` is excluded — its cosine is moot.

---

## Worked examples

Resume:
```
skills typed : React, AWS
projects     : "Realtime dashboard · built with React, Docker, WebSockets"
               "ML recommender · collaborative filtering in Python"
experience   : 3 yrs
projTextNorm : "realtimedashboardbuiltwithreactdockerwebsocketsmlrecommender
                collaborativefilteringinpython"
```

### A — projects confirm depth
**"Frontend Engineer" · requiredSkills: React, AWS, Docker, TypeScript (4)**
```
matched     : React✓ AWS✓             = 2 → skillsPct   = 2/4 = 50
projMatched : react✓ docker✓          = 2 → projectsPct = 2/4 = 50   (keyword)
score = mean(50, 50) = 50
```
You don't just *list* React — your projects *use* React + Docker. Projects hold/raise the %.

### B — projects pull a job IN that skills alone wouldn't
**"ML Engineer" · requiredSkills: Python, TensorFlow, Recommender (3)** — no typed-skill overlap
```
matched     : (React/AWS don't hit)   = 0 → skillsPct   = 0
projMatched : python✓                 = 1 → projectsPct = 1/3 = 33   (keyword)
score = mean(0, 33) = 17
```
`matched = 0`, but `projMatched > 0` adds it to the candidate set. Note the blend **halves**
it: once skills are typed, `skillsPct` is `0` (not absent) and averages in. So project-only
matches appear but rank modestly.

### C — semantic fallback (job already in the set via skills)
**"Cloud Engineer" · requiredSkills: AWS, Lambda, DynamoDB (3)** — no project keyword overlap
```
matched     : AWS✓                    = 1 → skillsPct   = 1/3 = 33
projMatched : (none in projText)      = 0
projSim     : cosine(projVec, jobC.embedding) = 0.22 → rescale → 13
projectsPct = 13   (← fallback, because projMatched = 0)
score = mean(33, 13) = 23
```
With no keyword overlap, projects still contribute a soft topical signal via the cosine —
but only because the job was already in the set (via `AWS`).

---

## Limitations

1. **No skill-level synonym matching.** The keyword path is literal substring matching, so
   `AWS` (job) vs "cloud computing" (project) **fails** — different characters. It will only
   hit if your project text literally contains the token `aws`.
2. **The cosine fallback is coarse and conditional.** `projSim` compares the *entire* project
   blob to the *entire* job composite embedding (dominated by title/summary, not skills), and
   it only fires when `projMatched = 0` for the whole job. It nudges the score for broadly
   related projects; it does **not** say "your cloud project covers the AWS requirement."
   If even one job skill keyword-hits, the cosine is ignored entirely.
3. **Substring fuzziness.** `projTextNorm` removes spaces, so short tokens (`go`, `r`, `c`)
   can match inside unrelated words. Same caveat as the skills `LIKE` match.
4. **Whole-blob embedding dilution.** A multi-project résumé embeds into one vector; a single
   job's relevance can be washed out by unrelated projects.

> Per-skill semantic matching (embed each job skill, compare to the project) would address
> #1 but is **not** implemented — see the note in the chat / `search.md` for the trade-offs
> (short-acronym embeddings, per-skill vectors at import time, threshold tuning).
</content>
