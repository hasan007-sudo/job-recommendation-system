# How search works

The search resolves a free-text input `{ companyText, roleText, skillNames, experienceYears }` to a ranked list of interview-plan cards. It uses a **3-layer hybrid matcher**: each layer is tried in order, and the first one with a confident hit wins.

```
User input
  │
  ▼
┌────────────────────────────────────────────────────┐
│ Layer 1: normalize (lowercase, strip punctuation)  │
└────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────┐
│ Layer 2: exact DB lookup (case-insensitive)        │  ← 90% of typed queries
│   "Google" → Company.name = 'Google'               │  ← btree index, ~0.1ms
└────────────────────────────────────────────────────┘
  │ miss
  ▼
┌────────────────────────────────────────────────────┐
│ Layer 3: pg_trgm fuzzy similarity                  │  ← typos, partial matches
│   "googl" → "Google" (similarity 0.7)              │  ← GIN trigram index, ~3ms
└────────────────────────────────────────────────────┘
  │ miss or low confidence
  ▼
┌────────────────────────────────────────────────────┐
│ Layer 4: pgvector cosine on MiniLM embeddings      │  ← true semantic
│   "SDE" → "Software Engineer"                      │  ← HNSW index, ~10ms
│   "web dev" → "Fullstack Engineer"                 │     + 40ms first embed
└────────────────────────────────────────────────────┘
  │
  ▼
Candidate IDs (companies, roles, skills)
  │
  ▼
Single ranking SQL query → top 20 plan cards
```

The same 3-layer pattern is applied independently to **company text**, **role text**, and **each skill name**. The matched IDs from each are fed into the final ranking query.

---

## Layer 1: normalize

Implemented in [`lib/search.ts`](../lib/search.ts):

```ts
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s+#./-]/g, "");
}
```

- Strips whitespace and lowercases.
- Removes punctuation that isn't meaningful in tech names (we keep `+`, `#`, `.`, `/`, `-` so `C++`, `C#`, `Next.js`, `CI/CD` survive).
- This is what's passed to Layer 2 for the exact lookup, and to the embedder for Layer 4. Layer 3 keeps the original casing because `pg_trgm.similarity()` is case-insensitive anyway.

---

## Layer 2: exact DB lookup

**The fastest path.** A direct case-insensitive equality check on the indexed name columns. Most typed queries (when the user picks an autocomplete suggestion or types a known name correctly) terminate here.

```ts
const exact = await prisma.$queryRaw<Match[]>`
  SELECT id, 1.0::float AS score FROM "Company"
  WHERE lower(name) = ${norm}
  LIMIT 5
`;
if (exact.length > 0) return exact;
```

- Score is always **1.0** for exact hits — they're trusted absolutely.
- Uses the implicit btree index on `Company.name` (which is `@unique`).
- Cost: ~0.1ms.

For roles we also check `roleSlug` because users sometimes paste slugs (e.g. `software_engineer`). For skills we only check `name`.

---

## Layer 3: pg_trgm fuzzy similarity

If Layer 2 missed, we try **trigram similarity**. A trigram is any 3-character substring of the text; `pg_trgm` computes similarity as the Jaccard index between two strings' trigram sets.

### How trigrams work

```
"Google"  → {"  G", " Go", "Goo", "oog", "ogl", "gle", "le "}
"googl"   → {"  g", " go", "goo", "oog", "ogl", "gl "}

shared trigrams: {"goo", "oog", "ogl"}
similarity ≈ shared / (total unique)  → ~0.5
```

### Index

`docs/../prisma/db-init.sql` creates GIN indexes with the `gin_trgm_ops` opclass:

```sql
CREATE INDEX company_name_trgm ON "Company" USING GIN (name gin_trgm_ops);
```

This lets Postgres do `WHERE name % 'googl'` (the `%` operator is "trigram similar to") as a fast index lookup instead of a sequential scan. Without the index this would be ~50–500ms; with it, ~3ms.

### Code path

```ts
const trgm = await prisma.$queryRaw<Match[]>`
  SELECT id, similarity(name, ${text})::float AS score FROM "Company"
  WHERE name % ${text}
  ORDER BY score DESC
  LIMIT 5
`;
if (trgm.length > 0 && trgm[0].score >= TRIGRAM_MIN.company) return trgm;
```

We accept the trigram result only if the top score clears a per-field threshold:

```ts
const TRIGRAM_MIN = {
  company: 0.4,   // strictest — companies are short, false positives are bad
  role: 0.35,
  skill: 0.45,   // strictest — skill names matter
};
```

Below threshold → fall through to Layer 4.

### What trigrams catch
- Typos: `"googl"` → `Google`
- Variants: `"reactjs"` → `React`, `"postgres"` → `PostgreSQL`
- Partial matches: `"front"` → `Frontend Engineer`

### What trigrams miss
- Strings that share no character sequences:
  - `"SDE"` ↔ `"Software Engineer"` → **0 shared trigrams**
  - `"web dev"` ↔ `"Fullstack Engineer"` → 0 shared trigrams
- That's exactly when Layer 4 takes over.

---

## Layer 4: vector embeddings (pgvector)

When the input is too short or too semantically different for trigram, we use **vector similarity** — neural embeddings that capture meaning, not character overlap.

### The model

[`lib/embeddings.ts`](../lib/embeddings.ts) uses `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`:

- 384-dim sentence embeddings
- Mean-pooled, L2-normalized
- ~25 MB model, runs in-process via WASM, no API key, no network at query time
- Downloaded once and cached on disk under `~/.cache/huggingface/`

### Storage

Each searchable entity has a `vector(384)` column:

```prisma
model Company     { embedding Unsupported("vector(384)")? ... }
model RoleProfile { embedding Unsupported("vector(384)")? ... }
model Skill       { embedding Unsupported("vector(384)")? ... }
```

Embeddings are computed once during `bun run db:seed` (over names like `"Google"`, `"Software Engineer"`, `"React"`) and stored. Re-running the seed only re-embeds rows where `embedding IS NULL`, so it's idempotent.

### Index

```sql
CREATE INDEX company_embedding_hnsw
  ON "Company" USING hnsw (embedding vector_cosine_ops);
```

HNSW (Hierarchical Navigable Small World) is the standard approximate-nearest-neighbour index. Lookups are ~10ms even over hundreds of thousands of rows.

### Query

```ts
const vec = await embed(text);                     // ~40ms first time, 0ms cached
const vecLit = toPgVectorLiteral(vec);             // [0.12,-0.04,...]
const ann = await prisma.$queryRaw<Match[]>`
  SELECT id, (1 - (embedding <=> ${vecLit}::vector))::float AS score
  FROM "Company"
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> ${vecLit}::vector
  LIMIT 5
`;
```

The `<=>` operator is pgvector's cosine distance. `1 - distance` converts to similarity (1.0 = identical direction).

### Query embedding cache

The biggest cost in this layer is computing the embedding for the user's input (~40ms first time). To avoid paying it repeatedly we wrap `embed()` in an LRU cache keyed on the normalized text:

```ts
const cache = new LRUCache<string, number[]>({ max: 500 });

export async function embed(text: string): Promise<number[]> {
  const key = text.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  // ... run the model, cache, return
}
```

Common queries (`"React"`, `"Software Engineer"`, `"Google"`) get embedded once, then served from the cache forever.

### What vectors catch
- `"SDE"` → `Software Engineer` (model knows the abbreviation from training data)
- `"web dev"` → `Fullstack Engineer`
- `"ML"` → `ML Engineer` / `Machine Learning`
- `"Backend with Java"` → `Backend Engineer`

---

## Final ranking query

Once company / role / skill candidate IDs are resolved, a single SQL query in [`searchPlans()`](../lib/search.ts) does the ranking. Simplified shape:

```sql
SELECT
  p.id AS "planId",
  c.name AS "companyName",
  rp."roleName",
  rp.seniority,
  p."cachedRoundCount",
  -- per-component scores
  (max company-match score for this plan's company) AS "companyScore",
  (max role-match score for this plan's role)       AS "roleScore",
  (sum of matched-skill weights for this plan's role) AS "skillWeightSum",
  (1.5 if seniority matches derived seniority else 0) AS "seniorityBonus",
  -- total
  (companyScore * 3 + roleScore * 2 + skillWeightSum + seniorityBonus) AS "totalScore"
FROM "InterviewPlan" p
LEFT JOIN "Company" c ON p."companyId" = c.id
JOIN "RoleProfile" rp ON p."roleProfileId" = rp.id
WHERE p.status = 'verified'
  AND (rp.id = ANY($roleIds) OR cardinality($roleIds) = 0)
  AND (p."companyId" = ANY($companyIds) OR p."companyId" IS NULL OR cardinality($companyIds) = 0)
ORDER BY "totalScore" DESC
LIMIT 20;
```

### Weights

Defined at the top of `lib/search.ts`:

```ts
const SCORE_WEIGHTS = {
  company: 3,
  role: 2,
  seniority: 1.5,
};
```

- **Company hit is weighted highest** — if the user typed a specific company they want plans for it.
- **Role hit second.**
- **Seniority match adds a fixed boost** so e.g. `4 years` → `mid` plans float over `entry`/`senior`.
- **Skill weights** come from `RoleProfileSkill.weight` and are summed across all matched skills for the plan's role.

### Permissive filters

The `cardinality($ids) = 0` checks make each filter optional. If the user typed only a company name, `roleIds` is empty → role filter passes for every plan → scoring surfaces all that company's plans on top.

| Input | What filters | What scoring favors |
|---|---|---|
| `Google` | company OR null | Google plans (+3 each) |
| `SDE` + `5 yrs` | role | SWE plans, mid bonus (+1.5) |
| `Google` + `SDE` + `5 yrs` | both | Google SWE mid (+3 +2 +1.5) |
| `[React, Node.js]` chips | skill-inferred roles | plans with matched skill links |
| nothing | nothing | top 20 by seniorityBonus (essentially random) |

### Denormalized round count

`InterviewPlan.cachedRoundCount` is read directly into each card — **no `COUNT(*)` subquery per row**. The column is kept in sync by a Postgres trigger on `InterviewRound` (see `prisma/db-init.sql`). A seed-time recompute pass acts as a safety net beneath the trigger.

---

## Latency budget (per search request)

| Step | Cold | Warm |
|---|---|---|
| Layer 1 normalize | 0ms | 0ms |
| Layer 2 exact lookup | ~0.1ms | ~0.1ms |
| Layer 3 pg_trgm (GIN) | ~3ms | ~3ms |
| Layer 4 embed query | 30–60ms | **0ms** (LRU cache) |
| Layer 4 HNSW cosine | ~10ms | ~10ms |
| Final ranking SQL | ~10ms | ~10ms |
| **Total (typical)** | **~80ms first** | **~15ms warmed** |

The embedding step is the single biggest cost. Trigram acts as a cheap filter that lets ~90% of queries skip Layer 4 entirely.

---

## Files

| File | What it does |
|---|---|
| [`lib/search.ts`](../lib/search.ts) | Layered matchers + final ranking SQL |
| [`lib/embeddings.ts`](../lib/embeddings.ts) | MiniLM pipeline + LRU cache |
| [`prisma/db-init.sql`](../prisma/db-init.sql) | Extensions, GIN/HNSW indexes, round-count trigger |
| [`prisma/seed.ts`](../prisma/seed.ts) | Embedding pass + global fallback plans |
| [`app/api/search/route.ts`](../app/api/search/route.ts) | POST endpoint that wraps `searchPlans` |
| [`app/api/plan/[id]/route.ts`](../app/api/plan/[id]/route.ts) | GET endpoint for card-click round detail |
