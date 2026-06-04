# Future implementation — semantic skill matching + domain affinity

Proposal (not yet built) to fix the two gaps documented in
[`PROJECT_BASED_RETRIEVAL.md`](./PROJECT_BASED_RETRIEVAL.md):

1. **Skill-level synonyms** — keyword matching can't see `AWS` ↔ "cloud computing".
   We want to match a candidate's skills/projects to a job's required skills
   **semantically**.
2. **Domain affinity** — a candidate who worked at a **FinTech** company or built a
   FinTech project should surface FinTech jobs even when the exact skills differ. This
   is what the **role-summary** embedding captures, so we **keep** the existing
   composite `Job.embedding` and add per-skill vectors alongside it.

Net model: **two embedding signals**, kept separate because they answer different
questions.

| Signal | Source vector(s) | Answers |
|---|---|---|
| **Skill coverage** (new) | per-skill `JobSkill.embedding` | "does the candidate know *this skill* (or a synonym)?" |
| **Domain affinity** (keep) | composite `Job.embedding` (title + roleType + **roleSummary** + skills) | "has the candidate worked in *this domain* (FinTech, health, etc.)?" |

---

## 1. Data model changes

### Keep `Job.embedding` (composite) — domain affinity
No change. Still built at import as
`"${jobTitle}. ${roleType}. ${roleSummary}. Skills: ${requiredSkills}"`. The
**roleSummary** is what carries domain context ("a payments platform…", "lending
risk models…"), so this vector is exactly what we compare a candidate's
work/project history against to surface FinTech-like roles.

### Add per-skill embeddings — skill coverage
```prisma
model JobSkill {
  id        String @id @default(cuid())
  jobId     String
  job       Job    @relation(fields: [jobId], references: [id], onDelete: Cascade)
  skill     String                              // normalized job skill token, e.g. "aws"
  embedding Unsupported("vector(384)")?         // embed(expandSkill(skill))
  @@index([jobId])
}
```
`prisma/db-init.sql` — HNSW index for ANN search (mirror `job_embedding_hnsw`):
```sql
CREATE INDEX job_skill_embedding_hnsw ON "JobSkill"
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

> Storage note: one row per (job, skill). With ~N jobs × ~7 skills that's ~7N small
> rows — fine for this scale. Backfill is a one-time import pass.

---

## 2. Import-time (`prisma/import-jobs.ts`)

For each job, in addition to the existing composite embedding:

```ts
const skills = splitSkills(job.requiredSkills);          // existing , ; | split + normalize
for (const skill of skills) {
  const vec = await embed(expandSkill(skill));           // reuse lib/embeddings.embed / embedBatch
  await db.jobSkill.create({ jobId, skill, embedding: toPgVectorLiteral(vec) });
}
```

### `expandSkill()` — the critical detail for short acronyms
MiniLM on a bare 3-char token (`"AWS"`, `"GCP"`, `"k8s"`) is noisy and won't sit near
"cloud computing". **Expand before embedding** using a small alias map; fall back to
the raw skill when unknown:

```ts
const SKILL_ALIASES: Record<string, string> = {
  aws:        "AWS Amazon Web Services cloud computing",
  gcp:        "GCP Google Cloud Platform cloud computing",
  k8s:        "Kubernetes container orchestration",
  ml:         "machine learning",
  // … curated, grows over time
};
function expandSkill(s: string): string {
  return SKILL_ALIASES[s] ?? s;   // unknown skills embed as-is (full names already embed fine)
}
```
This curated map is also the cheap **middle-ground** on its own: even without
embeddings, expanding `aws → "…cloud…"` lets the existing keyword path hit
"cloud computing". Embeddings then generalize beyond the curated list.

---

## 3. Query-time (`lib/search.ts`)

Embed the candidate once per request (reuse `embed`, LRU-cached):

```ts
const skillVecs   = await embedBatch(candidateSkills.map(expandSkill));  // per typed skill
const projVec     = await embed(projectText);                            // already exists
const domainVec   = await embed(candidateContext);                       // NEW — see §4
```

### A. Semantic skill coverage (the AWS ↔ cloud fix)
For each job skill vector, it's "covered" if it's close to *any* candidate evidence
vector (typed skills ∪ project text):

```sql
-- per job skill s:
covered(s) = EXISTS candidateVec : (1 - (s.embedding <=> candidateVec)) >= SEMANTIC_MIN
```
Then **merge with the existing keyword path** (keyword OR semantic), so we never lose
today's exact matches:
```
skillCovered = keyword_matched(s)  OR  semantic_covered(s)
skillsPct    = count(skillCovered) / required × 100
```
- `SEMANTIC_MIN` ≈ 0.45–0.55 (calibrate). Conservative to avoid "everything matches".
- Implement as a `JOIN LATERAL` over `JobSkill` with an `ANY(<candidate vectors>)`
  closeness check, OR precompute per-skill coverage in SQL with `<=>` against each
  `candidateVec` passed as a `vector[]` literal.

### B. Domain affinity (the FinTech surfacing)
One coarse cosine of the candidate's **context** vs the job composite (which holds the
role summary):
```
domainPct = rescale( 1 - (Job.embedding <=> domainVec) )     -- 0–100
```
Use it **two** ways:
1. **Candidacy widener** — add `OR domainPct >= DOMAIN_MIN` to the union `WHERE`, so a
   FinTech-experienced candidate surfaces FinTech jobs even with thin skill overlap.
   Gate with a strict `DOMAIN_MIN` so we don't dump the table.
2. **Sub-score** — feed it into the blend (below).

### C. Blend
Keep the equal-mean philosophy (no weights), now over up to three non-null sub-scores:
```
score = round( mean( non-null [ skillsPct, projectsPct, domainPct ] ) )
```
> Decision to confirm at build time: equal blend vs. a *small* domain weight, and
> whether `domainPct` should be a full sub-score or only a candidacy widener + tiebreaker
> (so domain doesn't dominate a strong skills match). Recommended start: equal blend,
> with `DOMAIN_MIN` high enough that domain only adds genuinely relevant jobs.

---

## 4. Candidate "context" vector for domain affinity (`lib/onboarding.ts`)

`domainVec` must capture *where/what* the candidate has worked — companies, roles,
domain, projects — so it lands near a FinTech job's role summary. There's already a
`buildResumeText()` in `lib/resume.ts` that concatenates roleHint + skills + work +
projects; add a domain-focused variant or reuse it:

```
candidateContext = [ strongest_domain, work_experience(company + role)…, projects… ].join(" ")
// e.g. "FinTech. Backend Engineer at Razorpay. Payments reconciliation service. …"
```
Pass it through `deriveSearchInput` → `SearchInput.contextText` → embedded at query time
into `domainVec`. (`work_experience[].company` is already parsed in `lib/resume.ts` but
currently dropped from search — this is where it earns its keep.)

---

## Worked example — the FinTech case

```
Candidate: worked at "Razorpay (payments)", project "UPI reconciliation service",
           skills: Java, Postgres
domainVec  = embed("FinTech. Backend Engineer at Razorpay. UPI reconciliation. Java, Postgres")

Job X "Backend Engineer — Lending"  roleSummary: "credit risk & loan servicing platform"
   requiredSkills: Java, Kafka, Postgres
   skillsPct (keyword∪semantic): Java✓ Postgres✓ Kafka✗     = 2/3 = 67
   domainPct = rescale(cosine(domainVec, Job.embedding) 0.58) = 78   ← FinTech ↔ lending
   score = mean(67, 78) = 73     ← surfaced & ranked up by domain affinity

Job Y "Backend Engineer — AdTech"  roleSummary: "real-time bidding pipeline"
   requiredSkills: Java, Kafka, Postgres   (same skills!)
   skillsPct = 2/3 = 67
   domainPct = rescale(cosine 0.31) = 29
   score = mean(67, 29) = 48     ← same skills, lower because domain is unrelated
```
Two jobs with identical skills rank differently because the **role-summary embedding**
lets the candidate's FinTech history pull the lending role up.

---

## Caveats & mitigations

| Risk | Mitigation |
|---|---|
| Short acronyms embed poorly | `expandSkill()` alias map before embedding (§2) |
| Threshold fuzziness ("everything matches") | conservative `SEMANTIC_MIN` / `DOMAIN_MIN`; merge with keyword (don't replace) |
| Per-skill vector cost/storage | precompute at import; HNSW index; ~7 rows/job is cheap at this scale |
| Project/context blob dilution | optionally embed per-project sentence; or weight domainVec toward work_experience |
| Domain affinity overpowering skills | keep `DOMAIN_MIN` high; consider domain as widener+tiebreaker, not full equal third |
| Latency (extra embeds + ANN) | candidate embeds are LRU-cached (`lib/embeddings.ts`); job vectors precomputed |

---

## Files to touch (when built)

| File | Change |
|---|---|
| `prisma/schema.prisma` | add `JobSkill` model (+ relation) |
| `prisma/db-init.sql` | HNSW index on `JobSkill.embedding` |
| `prisma/import-jobs.ts` | per-skill embed (`expandSkill` → `embed`), keep composite |
| `lib/embeddings.ts` | add `expandSkill()` + `SKILL_ALIASES`; reuse `embedBatch` |
| `lib/search.ts` | semantic skill-coverage (merge with keyword), `domainPct`, blend, candidacy widener |
| `lib/onboarding.ts` | build `contextText`, pass through `SearchInput` |
| `app/api/search/route.ts` | accept `contextText` |
| `docs/search.md` / `ARCHITECTURE.md` | document the two-signal model |

## Open decisions (resolve before building)
- `SEMANTIC_MIN`, `DOMAIN_MIN` thresholds — calibrate on real data.
- Is `domainPct` a full equal sub-score, or a candidacy widener + tiebreaker only?
- Candidate side for skill coverage: embed each typed skill, or just `projectText`, or both?
- Build `expandSkill` map vs. switch to a larger embedding model for short tokens.
</content>
