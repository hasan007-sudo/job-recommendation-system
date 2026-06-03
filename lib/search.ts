// Job-centric search. Title (exact + trigram + semantic) and company act as a
// precedence tier, experience stays a hard filter, and the candidate set is the
// UNION of role-matched ∪ company-matched ∪ skill-matched ∪ project-matched jobs.
// The match % is an equal blend of two sub-scores:
//   • skills%   — job's required-skill tokens covered by the user's skills (ILIKE).
//   • projects% — job's required-skill tokens found in the user's project text,
//                 falling back to project↔job embedding cosine when none overlap.
// Default sort puts role/company matches on top, then by blended score; the
// "score" sort ignores the tier and ranks purely by blended score.
// Rounds are parsed at read time from focusRoundPattern.

import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";
import { parseRounds } from "./rounds";
import type { JobCard, Seniority } from "./types";

const TITLE_TRIGRAM_MIN = 0.3;
const COMPANY_TRIGRAM_MIN = 0.4;
const TITLE_CANDIDATES = 20;
const RESULT_LIMIT = 30;
// Raw candidates pulled before the blended score is computed + sorted in JS.
// Generous cap so the JS-side blend/sort isn't starved by a SQL-side limit.
const RAW_CANDIDATE_CAP = 200;

// Cosine similarity (1 - distance) → percent. Rescales the typical resume↔JD
// band (~0.15–0.7) across 0–100 so the project semantic fallback varies.
function simToPercent(sim: number): number {
  const clamped = Math.max(0, Math.min(1, (sim - 0.15) / 0.55));
  return Math.round(clamped * 100);
}

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

type Match = { id: string; score: number };

// Title candidates: merge exact, trigram, and semantic (vector) tiers so a generic
// query like "Software Engineer" also surfaces related real titles ("Associate Engineer").
// Max score per job id wins; exact (1.0) floats to the top, semantic fills in the rest.
async function matchTitle(text: string): Promise<Match[]> {
  const norm = normalize(text);
  if (!norm) return [];

  const byId = new Map<string, number>();
  const keepMax = (rows: Match[]) => {
    for (const r of rows) {
      const prev = byId.get(r.id) ?? 0;
      if (r.score > prev) byId.set(r.id, r.score);
    }
  };

  const exact = await prisma.$queryRaw<Match[]>`
    SELECT id, 1.0::float AS score FROM "Job"
    WHERE lower("jobTitle") = ${norm}
    LIMIT ${TITLE_CANDIDATES}
  `;
  keepMax(exact);

  const trigram = await prisma.$queryRaw<Match[]>`
    SELECT id, similarity("jobTitle", ${text})::float AS score FROM "Job"
    WHERE "jobTitle" % ${text} AND similarity("jobTitle", ${text}) >= ${TITLE_TRIGRAM_MIN}
    ORDER BY score DESC
    LIMIT ${TITLE_CANDIDATES}
  `;
  keepMax(trigram);

  const vec = await embed(text);
  const vecLit = toPgVectorLiteral(vec);
  const ann = await prisma.$queryRaw<Match[]>`
    SELECT id, (1 - (embedding <=> ${vecLit}::vector))::float AS score FROM "Job"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT ${TITLE_CANDIDATES}
  `;
  keepMax(ann);

  return Array.from(byId.entries()).map(([id, score]) => ({ id, score }));
}

// Company candidates: exact then trigram. No vector — company names are typed near-exact.
async function matchCompanyIds(text: string): Promise<string[]> {
  const norm = normalize(text);
  if (!norm) return [];

  const exact = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Company" WHERE lower(name) = ${norm} LIMIT 5
  `;
  if (exact.length > 0) return exact.map((r) => r.id);

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
  coverage: number | null;
  projMatched: number;
  projSim: number | null;
  roleOrCompanyMatched: boolean;
};

export async function searchJobs(input: SearchInput): Promise<JobCard[]> {
  const sort = input.sort ?? "default";
  const projectText = (input.projectText ?? "").trim();
  // Normalize to the same [a-z0-9] form the SQL applies to each job skill token,
  // so substring matching of a token inside the project blob is apples-to-apples.
  const projTextNorm = projectText.toLowerCase().replace(/[^a-z0-9]/g, "");

  const [titleMatches, companyIds] = await Promise.all([
    input.roleText
      ? matchTitle(input.roleText)
      : Promise.resolve([] as Match[]),
    input.companyText
      ? matchCompanyIds(input.companyText)
      : Promise.resolve([] as string[]),
  ]);

  const skills = input.skillNames.map((s) => s.trim()).filter(Boolean);

  // Nothing to constrain on → don't dump the whole table.
  if (
    titleMatches.length === 0 &&
    companyIds.length === 0 &&
    skills.length === 0
  ) {
    return [];
  }

  const titleIds = titleMatches.map((m) => m.id);
  const hasSkills = skills.length > 0;

  // Embed the project text once for the semantic fallback. With no project text
  // we pass a throwaway literal that only needs to parse — the CASE guard
  // (hasProjVec) keeps projSim null and the `<=>` is never evaluated.
  const hasProjVec = projectText.length > 0;
  const projVecLit = hasProjVec ? toPgVectorLiteral(await embed(projectText)) : "[0]";

  // Candidate set = role-matched ∪ company-matched ∪ skill-matched ∪
  // project-keyword-matched (experience stays a hard filter). Sub-score columns
  // are raw; the blend + tier sort + final limit happen in JS below.
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT
      j.id AS "jobId",
      j."jobTitle",
      c.name AS "companyName",
      j."experienceMinYears",
      j."experienceMaxYears",
      j."focusRoundPattern",
      CASE WHEN ${hasSkills} THEN cov.matched ELSE NULL END AS "matched",
      cov.required AS "required",
      CASE WHEN ${hasSkills}
           THEN cov.matched::float / NULLIF(cov.required, 0)
           ELSE NULL END AS "coverage",
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
          SELECT 1 FROM unnest(${skills}::text[]) sk
          WHERE length(regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g')) > 0
            AND regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')
              LIKE '%' || regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g') || '%'
        ))::int AS matched,
        COUNT(*) FILTER (WHERE
          length(${projTextNorm}) > 0
          AND position(regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g') in ${projTextNorm}) > 0
        )::int AS "projMatched",
        COUNT(*)::int AS required
      FROM regexp_split_to_table(COALESCE(j."requiredSkills", ''), '[,;|]') AS tok
      WHERE length(regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')) > 0
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
    ORDER BY "roleOrCompanyMatched" DESC, cov.matched DESC, cov."projMatched" DESC, j."createdAt" ASC
    LIMIT ${RAW_CANDIDATE_CAP}
  `;

  const cards: JobCard[] = rows.map((row) => {
    const skillsPct = row.coverage == null ? null : Math.round(row.coverage * 100);

    // Projects only score when the resume has project text. Keyword overlap of
    // the job's required skills wins; fall back to embedding cosine when none hit.
    let projectsPct: number | null = null;
    if (hasProjVec) {
      if (row.projMatched > 0 && row.required > 0) {
        projectsPct = Math.round((row.projMatched / row.required) * 100);
      } else if (row.projSim != null) {
        projectsPct = simToPercent(row.projSim);
      }
    }

    const parts = [skillsPct, projectsPct].filter((p): p is number => p != null);
    const score = parts.length
      ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)
      : null;

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
      score,
      skillsPct,
      projectsPct,
      roleOrCompanyMatched: row.roleOrCompanyMatched,
      matchedSkills: row.matched,
      totalSkills: row.required,
    };
  });

  // Stable sort: within a tier (or overall, for "score") rank by blended score.
  // SQL already ordered the cap by role/company then coverage, so ties keep a
  // sensible (createdAt-asc) order.
  cards.sort((a, b) => {
    if (sort === "default" && a.roleOrCompanyMatched !== b.roleOrCompanyMatched) {
      return a.roleOrCompanyMatched ? -1 : 1;
    }
    return (b.score ?? -1) - (a.score ?? -1);
  });

  return cards.slice(0, RESULT_LIMIT);
}
