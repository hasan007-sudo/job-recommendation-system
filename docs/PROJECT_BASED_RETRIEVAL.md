# Project-based retrieval & scoring

How a candidate's **project experience** affects job search results.
All logic lives in [`lib/search.ts`](../lib/search.ts),
[`lib/resume.ts`](../lib/resume.ts), and [`lib/onboarding.ts`](../lib/onboarding.ts).

> **TL;DR** — At resume parse time an LLM extracts 3–8 domain skills/tech concepts
> per project (e.g. `["real-time systems", "WebSocket", "event-driven architecture"]`).
> Each project gets its own embedding. At search time, `projectsPct` = MAX cosine
> similarity between the job and any single project's embedding, rescaled to [0–100].
> Projects only **score** candidates — they do **not** pull new jobs into the result set.

---

## Where project keywords come from

```
Resume upload
  → analyzeResume() [OpenRouter LLM]          lib/resume.ts
      extracts: projects[i].keywords = ["real-time systems", "WebSocket", ...]
  → mapToProfile()
      profile.projects        = ["Name · description", ...]   // display only
      profile.projectKeywords = [["real-time systems", ...], [...]]

  → sessionStorage "rounds:profile"

User confirms → deriveSearchInput(profile)     lib/onboarding.ts
      projectTexts = projectKeywords.map(kws => kws.join(", "))
      // ["real-time systems, WebSocket, event-driven architecture", ...]

  → sessionStorage "rounds:autosearch"
  → POST /api/search { projectTexts: string[] }
  → searchJobs(input)                          lib/search.ts
```

**Fallback for old sessions** (profile cached before this feature): if
`projectKeywords` is absent, `deriveSearchInput` falls back to
`[profile.projects.join(". ")]` — raw prose as a single entry.

---

## LLM keyword extraction

The resume analysis prompt instructs the model to add a `keywords` field to each
project object:

```json
"projects": [
  {
    "name": "Real-time Notification System",
    "description": "...",
    "keywords": ["real-time systems", "push notifications", "WebSocket", "event-driven architecture"]
  }
]
```

Rules enforced by the prompt:
- 3–8 keywords per project.
- Domain skills and tech concepts only — no soft skills, team size, awards, or process words.

---

## Scoring: per-project embedding + MAX cosine

**Embedding (one Bedrock Titan call per project):**
```ts
projVecLits = await Promise.all(
  projectTexts.map(t => embed(t).then(toPgVectorLiteral))
)
// ["[0.12, 0.34, ...]", "[0.56, 0.78, ...]", ...]
```

**SQL — `projSim` (raw CTE):**
```sql
CASE WHEN ${hasProjVecs} AND j.embedding IS NOT NULL
     THEN (
       SELECT MAX((1 - (j.embedding <=> pv::vector))::float)
       FROM unnest(${projVecLits}::text[]) AS pv
     )
     ELSE NULL
END AS "projSim"
```

MAX means the job is scored against its **most relevant** project — one highly
related project is not diluted by unrelated ones.

**Rescaling — `projectsPct` (sub CTE):**
```
projectsPct = max(0, min(1, (projSim - FLOOR) / (1.0 - FLOOR))) × 100
```

Constant in `lib/search.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `PROJ_SIM_FLOOR` | `0.40` | Below this → 0 %. Filters background Titan noise (~0.10–0.20). |

The ceiling is always `1.0` (the max possible cosine), so scores scale naturally
across the full remaining range. Tune `PROJ_SIM_FLOOR` upward to tighten
relevance, downward to widen it.

**Blend:**
```
score = round( mean( non-null [skillsPct, projectsPct] ) )
```

---

## Worked example

Resume project: "Real-time Notification System · notifications for tickets and chats"

LLM extracts keywords: `["real-time systems", "push notifications", "WebSocket", "ticketing systems"]`

`projectTexts[0]` = `"real-time systems, push notifications, WebSocket, ticketing systems"`

Embedded → vector `V_proj`.

| Job | projSim | projectsPct |
|---|---|---|
| Backend Engineer (Node, WebSocket, Redis) | 0.61 | `round((0.61-0.40)/0.30 × 100)` = **70 %** |
| IT Consulting (Java, Spring, Kubernetes) | 0.18 | below floor → **0 %** |
| Mobile Developer (Swift, UIKit) | 0.12 | below floor → **0 %** |

---

## What projects do NOT do

- **Projects do not add jobs to the candidate set.** A job enters results only via
  title/company/skills match. The project score ranks it higher or lower within
  that set.
- **No keyword substring matching.** The old `projMatched` / `projTextNorm` approach
  (which caused tokens like "real" and "time" to match unrelated skill tokens) has
  been removed entirely.

---

## Limitations

1. **Keyword quality depends on the LLM.** Vague project descriptions produce vague
   keywords; detailed descriptions produce more discriminating vectors.
2. **Titan embedding space.** Cosine similarity between loosely related domains can
   still be 0.35–0.45, so `PROJ_SIM_FLOOR` requires ongoing calibration as more
   jobs are indexed.
3. **Projects don't open the candidate pool.** A candidate whose only relevant
   experience is in projects (no overlapping skills or role) won't see those jobs
   unless they also appear in the skill/title match.
