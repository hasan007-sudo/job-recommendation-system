# Search test cases — query → expected result

Plain-language acceptance cases for the job recommendation system. Each case
states what the user searches (or uploads) and what the system must return.
Cases marked **[verified]** were run against the live database on 2026-06-11;
their numbers are real outputs, not estimates. Re-check them with
`scripts/verify-aswathy.ts` and `scripts/match-score-probe.ts` after any
scoring or threshold change. Exact percentages may drift a few points when
glosses are regenerated or thresholds recalibrated — the structural
expectations (coverage decisions, ordering, caps) must hold regardless.

---

## Case 1 — Aswathy's resume vs Tiger Analytics (the founding case) [verified]

**User action:** uploads `Resume Aswathy B - Aswathy Balan.pdf`
(B.Tech Data Science; skills incl. Python, SQL, Machine learning, Data
Cleansing, Data Visualisation, Pandas, Scikit-learn, plus soft skills
Communication and Team Collaboration; projects: superconductivity ML
regression, CNN image classification, cybersecurity research, digital logic
design). Profile-driven search runs with role hint "Data Science",
experience 0, company "Tiger Analytics" selected on the search page.

**Expected result:**

- Tiger Analytics — Data Science Analyst (`cmq7qxif80009h605q5si77dg`):
  **matchScore 49%** = 0.65 × 67 + 0.35 × 16
  - requiredSkillScore **67 (4/6)**:
    - Python — covered (exact)
    - Machine learning — covered (exact)
    - Communication — covered (soft skill extracted from resume; gloss cosine
      vs "Team Collaboration" ≈ 0.43–1.0 depending on gloss phrasing)
    - Data analytics — covered (semantic, via Data Visualisation/SQL glosses,
      cosine ≈ 0.40)
    - C — NOT covered (best candidate cosine ≈ 0.27 < 0.30 threshold)
    - C++ — NOT covered (≈ 0.28 < 0.30) — she genuinely doesn't know C/C++
  - projectEvidenceScore **16**: her ML project evidences the technical-round
    capability (cos 0.221 → 48) and the roleSummary (0.183 → 33); the two
    client-engagement responsibilities are honestly unevidenced (≈ 0.04–0.09 → 0)
- The job detail page badge shows the **same 49%** as the search list (shared
  scoring path), with breakdown "Required skills 67" / "Project evidence 16".
- Under the old model this pair scored 17% — any regression toward that
  indicates the project channel or semantic coverage broke.

## Case 2 — Aswathy + company "Tiger Analytics" + role "Data Science", default sort [verified]

**User query:** company `Tiger Analytics`, role `Data Science`, Aswathy's
profile skills + projects, experience 0, sort `default`.

**Expected result (top of list, in order):**

1. Tiger Analytics — Business Analyst — **52%** (skills 75, projects 9)
2. Tiger Analytics — Data Science Analyst — **49%** (skills 67, projects 16)
3. Tiger Analytics — Data Engineering Analyst — **15%** (skills 24, projects 0)
4. Turing — Computational Mathematics Researcher — **71%** (skills 100, projects 17)
5. …remaining role/personalized matches by matchScore…

**Structural expectations:**

- ALL Tiger Analytics jobs appear first (Tier 0), ordered by matchScore among
  themselves — even the 15% one ranks above the 71% non-Tiger job. Company
  preference orders, it never changes the %.
- Tier 0 shows at most 10 company jobs (Tiger has 3, so no cap effect here).
- The 71% Turing job leads the non-company portion.

## Case 3 — same query, sort "score" (Match score)

**User query:** same as Case 2, sort `score`.

**Expected result:** flat ordering by matchScore — Turing 71% first, Tiger
Business Analyst 52% second, Tiger Data Science Analyst 49% third. Tiers
ignored entirely.

## Case 4 — semantic skill coverage (the AWS ↔ cloud class of match)

**User query:** skills only, parsed profile containing `Data Visualisation`,
`Data Cleansing`, `SQL` (with glosses) — no skill literally named
"Data analytics".

**Expected result:** jobs requiring `Data analytics` count it as **covered**
(gloss cosine ≈ 0.40 ≥ 0.30). Conversely a profile containing only `Python`
must NOT cover `C` or `C++` (cosine ≈ 0.26–0.28 < 0.30) — programming-language
adjacency is not equivalence.

## Case 5 — soft-skill requirement

**User query:** parsed resume whose skills section lists soft skills
(Communication / Team Collaboration / Leadership).

**Expected result:** job tokens like `Communication` are coverable and count
toward requiredSkillScore. A resume parsed WITHOUT soft skills (old cached
profile) simply misses them — score is lower but nothing errors.

## Case 6 — manually typed skills (no glosses) [verified]

**User query:** on the search page, the user types skill chips by hand (no
resume upload), then clicks "Update results".

**Expected result:** typed skills whose token exists in the `Skill` catalog
get **catalog-fallback semantics** — the catalog row's stored gloss embedding
stands in as the query vector, with no LLM or Bedrock call (and never any call
per keystroke; work happens only on the search request). Verified against the
Tiger Analytics Data Science Analyst job:

- typed `Python, Machine learning, Data visualization, Communication` →
  **4/6 covered (67)**: `Data analytics` is covered semantically via the
  catalog vector for `datavisualization`, despite no gloss being supplied.
- typed `Python` alone → **1/6**: still does NOT cover `C`/`C++`
  (language adjacency is not equivalence).
- a token the catalog has never seen (e.g. the British spelling
  `Data Visualisation`) triggers **gloss-on-miss**: the search API glosses it
  in-request, embeds it, and caches it in the catalog (no `JobSkill` links, so
  job denominators are untouched). Same query then scores **4/6 (67)**, and
  the second request is a pure catalog hit with no LLM call. If the gloss LLM
  is unavailable, those skills degrade to exact-only and the search still
  succeeds.

Projects channel absent → scores cap at `0.65 × coverage` (e.g. 67 → 43%).

## Case 7 — projects pull jobs in (capability retrieval)

**User query:** profile with NO overlapping skills for some job J, but a
project semantically close to J's capabilities (e.g. an LLM-agents project vs
an "AI Engineer" job whose technical round lists agentic workflows).

**Expected result:** J can still appear in results via the capability-ANN path
(top-50 per project vector), scored `0.65 × low-or-0 + 0.35 × evidence`. In
Case 2's verified output this is visible as: Infosys — AI & ML Engineer
appears with **skills 0, projects 24 → 8%**.

## Case 8 — company-only search

**User query:** company `Tiger Analytics`, nothing else.

**Expected result:** Tiger's jobs (≤10), badge `—` on every card (no skills
and no projects → nothing to score; score is null, not 0). Ordered by recency
within the tier.

## Case 9 — empty / unmatched query

**User query:** nothing typed; or a role like `Nonexistent Role XYZ` with no
skills/company/projects and no title match.

**Expected result:** empty list `[]`. The system must never dump the job table.

## Case 10 — experience hard filter

**User query:** any matching query with experience `10`, against a job whose
band is 0–3 years.

**Expected result:** that job is excluded entirely (hard filter), regardless
of how high its matchScore would be. Jobs with NULL bounds are treated as
open-ended (0–99) and stay eligible.

## Case 11 — role synonym retrieval (title ANN)

**User query:** role `Data Science` (not an exact title).

**Expected result:** "Data Science Analyst" and similar titles enter the role
tier via exact/trigram/vector union. Role match affects **tier placement
only** — two jobs with the same skills/projects score identically whether or
not their title matched.

## Case 12 — list and detail must always agree [verified]

**User action:** run any search, note a job's %, open that job's detail page.

**Expected result:** the detail badge equals the list % exactly (both call the
same scoring SQL — Case 1 verified 49% = 49%). Any divergence is a bug, not
calibration drift.

## Case 13 — Tier-1 reservation under pressure

**User query:** role with many matches (e.g. `Engineer`) + a strong
skills/projects profile, default sort.

**Expected result:** at least min(10, available) role-matched jobs appear
before any personalized-only (Tier 2) job, even when Tier 2 jobs outscore
them. Role jobs beyond the first 10 are not excluded — they compete with
Tier 2 in the score-ordered backfill. Max 30 results total.

---

## How to re-verify

```bash
npx tsx --env-file=.env scripts/verify-aswathy.ts          # Cases 1–3, 7, 12
npx tsx --env-file=.env scripts/match-score-probe.ts <id>  # per-job breakdown
npm run test                                               # JS-side pipeline tests
```
