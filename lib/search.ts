// Job-centric search. Title (exact + trigram + semantic) and company act as a
// precedence tier, experience stays a hard filter, and the candidate set is the
// UNION of role-matched ∪ company-matched ∪ skill-matched ∪ project-matched jobs.
// The match % is an equal blend of two sub-scores, computed in SQL so the LIMIT
// is a correct top-N by match %:
//   • skills%   — job's required-skill tokens covered by the user's skills (ILIKE).
//   • projects% — job's required-skill tokens found in the user's project text,
//                 falling back to project↔job embedding cosine when none overlap.
// "default" (Best match): role/company tier first, each tier guaranteed up to
// TIER_FLOOR slots, then backfilled toward RESULT_LIMIT by score. "score" (Match
// score): pure top-N by blended score, tier ignored.
// Rounds are parsed at read time from focusRoundPattern.

import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";
import { parseRounds } from "./rounds";
import type { JobCard, Seniority } from "./types";

const TITLE_TRIGRAM_MIN = 0.3;
const COMPANY_TRIGRAM_MIN = 0.4;
const TITLE_CANDIDATES = 20;
// We retrieve exactly what we display — no oversized candidate pool. The blended
// score is computed in SQL so the LIMIT is a correct top-N by match %.
const RESULT_LIMIT = 30;
// "Best match" guarantees each tier (role/company vs skill/project) at least this
// many slots before the other backfills toward RESULT_LIMIT.
const TIER_FLOOR = 15;

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s+#./-]/g, "");
}

export function deriveSeniority(experienceYears: number | null): Seniority {
  if (experienceYears === null) return "entry";
  if (experienceYears <= 2) return "entry";
  if (experienceYears <= 6) return "mid";
  return "senior";
}

// Title candidates: the UNION of exact, trigram, and semantic (vector) tiers, so a
// generic query like "Software Engineer" also surfaces related real titles. Title
// only decides membership (it never ranks the result), so we return ids only — the
// per-tier similarity lives in each tier's ORDER BY to pick the top TITLE_CANDIDATES.
async function matchTitleIds(text: string): Promise<string[]> {
  const norm = normalize(text);
  if (!norm) return [];

  const ids = new Set<string>();
  const add = (rows: { id: string }[]) => rows.forEach((r) => ids.add(r.id));

  // Tier 1 — exact: case-folded title equality.
  add(await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Job"
    WHERE lower("jobTitle") = ${norm}
    LIMIT ${TITLE_CANDIDATES}
  `);

  // Tier 2 — trigram: pg_trgm fuzzy match (catches typos/partials). `%` uses the
  // GIN index; keep only rows above the similarity floor, most similar first.
  add(await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Job"
    WHERE "jobTitle" % ${text} AND similarity("jobTitle", ${text}) >= ${TITLE_TRIGRAM_MIN}
    ORDER BY similarity("jobTitle", ${text}) DESC
    LIMIT ${TITLE_CANDIDATES}
  `);

  // Tier 3 — vector: semantic ANN (catches synonyms like "SDE" ↔ "Software
  // Engineer"). `<=>` is cosine distance over the HNSW index; nearest first.
  const vecLit = toPgVectorLiteral(await embed(text));
  add(await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Job"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT ${TITLE_CANDIDATES}
  `);

  return [...ids];
}

// Company candidates: exact then trigram. No vector — company names are typed near-exact.
async function matchCompanyIds(text: string): Promise<string[]> {
  const norm = normalize(text);
  if (!norm) return [];

  // Tier 1 — exact: case-folded name equality. If it hits, trust it and stop.
  const exact = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Company" WHERE lower(name) = ${norm} LIMIT 5
  `;
  if (exact.length > 0) return exact.map((r) => r.id);

  // Tier 2 — trigram: fuzzy fallback, best first. Caller keeps it only if the
  // top score clears COMPANY_TRIGRAM_MIN (short names → strict floor).
  const trigram = await prisma.$queryRaw<{ id: string; score: number }[]>`
    SELECT id, similarity(name, ${text})::float AS score FROM "Company"
    WHERE name % ${text}
    ORDER BY score DESC
    LIMIT 5
  `;
  if (trigram.length > 0 && trigram[0].score >= COMPANY_TRIGRAM_MIN) {
    return trigram.map((r) => r.id);
  }
  return [];
}

export type SortMode = "default" | "score";

export type SearchInput = {
  companyText: string;
  roleText: string;
  skillNames: string[];
  experienceYears: number | null;
  // Concatenated resume project text, scored against each job's required skills.
  projectText?: string;
  // "default" tiers role/company matches first; "score" ranks purely by blend.
  sort?: SortMode;
};

type SearchRow = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  focusRoundPattern: string;
  matched: number | null;
  required: number;
  skillsPct: number | null;
  projectsPct: number | null;
  score: number | null;
  roleOrCompanyMatched: boolean;
};

export async function searchJobs(input: SearchInput): Promise<JobCard[]> {
  const sort = input.sort ?? "default";
  const projectText = (input.projectText ?? "").trim();
  // Normalize to the same [a-z0-9] form the SQL applies to each job skill token,
  // so substring matching of a token inside the project blob is apples-to-apples.
  const projTextNorm = projectText.toLowerCase().replace(/[^a-z0-9]/g, "");

  const [titleIds, companyIds] = await Promise.all([
    input.roleText
      ? matchTitleIds(input.roleText)
      : Promise.resolve([] as string[]),
    input.companyText
      ? matchCompanyIds(input.companyText)
      : Promise.resolve([] as string[]),
  ]);

  const skills = input.skillNames.map((s) => s.trim()).filter(Boolean);
  // Pre-normalize to the same [a-z0-9] form the SQL applies to each job skill
  // token, so the LIKE compares apples-to-apples. Done once here instead of per
  // (token × skill) inside the lateral.
  const normalizedSkills = skills
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);

  // Nothing to constrain on → don't dump the whole table.
  if (titleIds.length === 0 && companyIds.length === 0 && skills.length === 0) {
    return [];
  }

  const hasSkills = skills.length > 0;

  // Embed the project text once for the semantic fallback. With no project text
  // we pass a throwaway literal that only needs to parse — the CASE guard
  // (hasProjVec) keeps projSim null and the `<=>` is never evaluated.
  const hasProjVec = projectText.length > 0;
  const projVecLit = hasProjVec ? toPgVectorLiteral(await embed(projectText)) : "[0]";

  // Candidate set = role-matched ∪ company-matched ∪ skill-matched ∪
  // project-keyword-matched (experience stays a hard filter). Sub-scores, the
  // blend, the per-tier floor, and the final order/limit are all computed here so
  // a 30-row LIMIT is a correct top-N by match %.
  //   raw    → counts + raw cosine + tier flag
  //   sub    → skills% / projects% (keyword, else rescaled cosine)
  //   scored → blended score = mean of the non-null sub-scores
  //   ranked → row number within each tier (for the Best-match floor)
  //   pick   → select RESULT_LIMIT rows (default: floor-15/tier then backfill by
  //            score; score: pure top-N), then display role-tier-first for default.
  const rows = await prisma.$queryRaw<SearchRow[]>`
    -- 1) raw — the UNION candidate set: every job matching role, company, skills,
    --    or project keywords (and passing the experience hard filter), carrying
    --    raw counts (matched / projMatched / required), raw cosine, and tier flag.
    WITH raw AS (
      SELECT
        j.id AS "jobId",
        j."jobTitle",
        c.name AS "companyName",
        j."experienceMinYears",
        j."experienceMaxYears",
        j."focusRoundPattern",
        j."createdAt",
        CASE WHEN ${hasSkills} THEN cov.matched ELSE NULL END AS matched,
        cov.required AS required,
        cov."projMatched" AS "projMatched",
        CASE WHEN ${hasProjVec} AND j.embedding IS NOT NULL
             THEN (1 - (j.embedding <=> ${projVecLit}::vector))::float
             ELSE NULL END AS "projSim",
        (
          (cardinality(${titleIds}::text[]) > 0 AND j.id = ANY(${titleIds}::text[]))
          OR (cardinality(${companyIds}::text[]) > 0 AND j."companyId" = ANY(${companyIds}::text[]))
        ) AS "roleOrCompanyMatched"
      FROM "Job" j
      JOIN "Company" c ON c.id = j."companyId"
      -- Per job: count its skill tokens, how many a user skill covers, and how many
      -- appear in the project text. Counting job tokens keeps matched ≤ required.
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM unnest(${normalizedSkills}::text[]) nsk
            WHERE ntok LIKE '%' || nsk || '%'
          ))::int AS matched,
          COUNT(*) FILTER (WHERE
            length(${projTextNorm}) > 0
            AND position(ntok in ${projTextNorm}) > 0
          )::int AS "projMatched",
          COUNT(*)::int AS required
        FROM (
          SELECT regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g') AS ntok
          FROM regexp_split_to_table(COALESCE(j."requiredSkills", ''), '[,;|]') AS tok
          WHERE length(regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')) > 0
        ) tokens
      ) cov
      WHERE (
          ${input.experienceYears}::int IS NULL
          OR ${input.experienceYears}::int BETWEEN COALESCE(j."experienceMinYears", 0)
                                               AND COALESCE(j."experienceMaxYears", 99)
        )
        AND (
          (cardinality(${titleIds}::text[]) > 0 AND j.id = ANY(${titleIds}::text[]))
          OR (cardinality(${companyIds}::text[]) > 0 AND j."companyId" = ANY(${companyIds}::text[]))
          OR cov.matched > 0
          OR cov."projMatched" > 0
        )
    ),
    -- 2) sub — per-job sub-scores derived from raw counts (both in [0,100]):
    --      skillsPct   = % of the job's required skills you list
    --      projectsPct = % of them your projects show (keyword overlap), or — when
    --                    none overlap — the project↔job cosine rescaled to [0,100]
    sub AS (
      SELECT raw.*,
        CASE WHEN ${hasSkills} AND required > 0
             THEN round(matched::numeric / required * 100)::int END AS "skillsPct",
        CASE WHEN ${hasProjVec} THEN
          CASE
            -- primary: keyword overlap of job skills in the project text
            WHEN "projMatched" > 0 AND required > 0
              THEN round("projMatched"::numeric / required * 100)::int
            -- fallback: rescale the cosine band (~0.15–0.7) onto 0–100
            WHEN "projSim" IS NOT NULL
              THEN round((greatest(0, least(1, ("projSim" - 0.15) / 0.55)) * 100)::numeric)::int
            ELSE NULL
          END
        ELSE NULL END AS "projectsPct"
      FROM raw
    ),
    -- 3) scored — the blended match %: equal mean of whichever sub-scores exist
    --    (one null → use the other; both null → null, badge shows "—").
    scored AS (
      SELECT sub.*,
        CASE
          WHEN "skillsPct" IS NULL AND "projectsPct" IS NULL THEN NULL
          WHEN "skillsPct" IS NULL THEN "projectsPct"
          WHEN "projectsPct" IS NULL THEN "skillsPct"
          ELSE round((("skillsPct" + "projectsPct") / 2.0)::numeric)::int
        END AS score
      FROM sub
    ),
    -- 4) ranked — number each job within its tier (role/company vs the rest),
    --    best score first. rn_in_tier ≤ TIER_FLOOR is the Best-match floor.
    ranked AS (
      SELECT scored.*,
        ROW_NUMBER() OVER (
          PARTITION BY "roleOrCompanyMatched"
          ORDER BY score DESC NULLS LAST, "createdAt" ASC
        ) AS rn_in_tier
      FROM scored
    ),
    -- 5) pick — SELECT which RESULT_LIMIT rows survive. default keeps the first
    --    TIER_FLOOR of each tier (prio 0), then backfills remaining slots by
    --    score (prio 1); score ignores tiers → global top-N by score.
    pick AS (
      SELECT * FROM ranked
      ORDER BY
        CASE WHEN ${sort} = 'default' AND rn_in_tier <= ${TIER_FLOOR} THEN 0 ELSE 1 END ASC,
        score DESC NULLS LAST,
        "createdAt" ASC
      LIMIT ${RESULT_LIMIT}
    )
    -- 6) final projection + DISPLAY order: default floats the role/company tier to
    --    the top (then by score); score is already a pure by-score list.
    SELECT
      "jobId", "jobTitle", "companyName",
      "experienceMinYears", "experienceMaxYears", "focusRoundPattern",
      matched, required, "skillsPct", "projectsPct", score, "roleOrCompanyMatched"
    FROM pick
    -- Display: default shows the role/company tier first; score is pure by-%.
    ORDER BY
      CASE WHEN ${sort} = 'default' AND "roleOrCompanyMatched" THEN 0 ELSE 1 END ASC,
      score DESC NULLS LAST,
      "createdAt" ASC
  `;

  return rows.map((row) => {
    const rounds = parseRounds(row.focusRoundPattern);
    return {
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      companyName: row.companyName,
      seniority: deriveSeniority(row.experienceMinYears),
      experienceMinYears: row.experienceMinYears,
      experienceMaxYears: row.experienceMaxYears,
      roundCount: rounds.length,
      rounds,
      score: row.score,
      skillsPct: row.skillsPct,
      projectsPct: row.projectsPct,
      roleOrCompanyMatched: row.roleOrCompanyMatched,
      matchedSkills: row.matched,
      totalSkills: row.required,
    };
  });
}
