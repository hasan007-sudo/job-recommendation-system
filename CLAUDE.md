# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start Next.js dev server
npm run build        # production build
npm run test         # run all tests once (vitest)
npm run test:watch   # vitest in watch mode
npm run db:push      # push Prisma schema to database
npm run db:import    # import/re-embed jobs from source (tsx prisma/import-jobs.ts)
```

To run a single test file: `npx vitest run lib/__tests__/search.ranking.test.ts`

## Required Environment Variables

- `DATABASE_URL` — PostgreSQL/Aurora connection string
- `AWS_REGION` — for Amazon Bedrock (embeddings); credentials resolve from the standard AWS chain
- `OPENROUTER_API_KEY` — resume parsing LLM calls via OpenRouter (OpenAI-compatible endpoint)

## Architecture

**Two routes, two design eras:**
- `/` — legacy job search page (plain CSS, left untouched unless asked)
- `/onboarding` — new candidate onboarding flow (governed by the design system below)

**Data layer:** PostgreSQL (Amazon Aurora) via Prisma with `pgvector` and `pg_trgm` extensions. Schema has two models: `Company` and `Job`. `Job.embedding` is a `vector(512)` column — 512-dim normalized vectors from AWS Bedrock Titan Text Embeddings V2, computed at import time over a composite of `title + roleType + summary + skills`. The HNSW index for ANN lookups is defined in `prisma/db-init.sql`, not in the schema file.

**Search (`lib/search.ts`):** Resolves `{ companyText, roleText, skillNames, experienceYears, projectTexts, sort }` to a `JobCard[]`. The model has three parts:
1. **Candidate set** — union of role-matched ∪ company-matched ∪ skill-matched jobs. Title matching is a 3-tier union: exact → trigram (`pg_trgm`) → vector (ANN). Company matching is exact → trigram. Experience is the one hard filter.
2. **Match %** — equal blend of `skills%` (ILIKE token coverage) and `projects%` (MAX cosine similarity across project embeddings, rescaled at `PROJ_SIM_FLOOR = 0.40`). Computed entirely in a single SQL CTE — no post-SQL re-ranking.
3. **Sort** — `default` gives role/company tier at least `TIER_FLOOR = 15` slots; `score` is pure top-N by match %.

**Resume processing (`lib/resume.ts`):** Supports PDF (`unpdf`), DOCX (`mammoth`), TXT. Extracts text then calls an LLM via OpenRouter to return a structured `OnboardingProfile`. The profile drives search via `buildSearchInput()` in `lib/onboarding.ts`.

**Rounds (`lib/rounds.ts`):** Rounds are **not stored per-row** — they are parsed at read time. `parseRounds` splits `Job.focusRoundPattern` on `+`. `buildRounds` reads the 4 fixed round fields (`roundScreening`, `roundBehavioural`, `roundTechnical`, `roundCultureFit`) whose values are `;`-separated competency topics.

**Embeddings (`lib/embeddings.ts`):** Stateless — Bedrock only generates vectors; storage lives in Postgres. Query vectors are LRU-cached (max 500 entries per process).

**Components:** `components/shadcn/` holds lightly-adapted shadcn base primitives; `components/ui/` holds project-specific UI components styled to the design system.

**Tests:** All in `lib/__tests__/`, focused on search logic. Run with `vitest`.

## UI / Design System (mandatory)

Whenever you create, edit, or restyle any UI — components, pages, layouts, CSS —
you **must** read and follow `.interface-design/system.md` first. It is the
source of truth for color, typography, spacing, borders, radius, and component
patterns.

Rules:
- **Scope:** the design system applies to the `/onboarding` route and any new UI
  built in its style. The legacy `/` page uses an older plain-CSS system and is
  left untouched unless explicitly asked.
- **Tokens over guesses:** use the colors, spacing scale, radius ladder, and
  letter-spacing values defined in `system.md`. Do not introduce off-palette
  colors, off-scale spacing, off-ladder radii, or new accent hues.
- **Accent discipline:** indigo is the only brand color; emerald is reserved for
  the parse-success check only.
- **Depth:** borders-first. No shadows on cards/inputs/buttons — shadows only for
  true overlays (menus, modals).
- **Readability:** never track body/running text; only track uppercase
  eyebrows/labels per the letter-spacing config.

After any UI change, sanity-check it against `system.md` (the
`/interface-design:audit` skill can do this). If a design need genuinely isn't
covered by the system, extend `system.md` first, then build — don't drift
silently.

## Stack
- Next.js (App Router) + TypeScript + Tailwind CSS v4 + Prisma.
- Icons: `lucide-react`.
