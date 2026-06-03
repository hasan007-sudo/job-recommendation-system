// Job-centric search: title (exact + trigram + semantic), company, and
// experience act as filters; the match score is skill coverage only
// (matched skills / job's required-skill count, via ILIKE on requiredSkills).
// Rounds are parsed at read time from focusRoundPattern.

import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";
import { parseRounds } from "./rounds";
import type { JobCard, Seniority } from "./types";

const TITLE_TRIGRAM_MIN = 0.3;
const COMPANY_TRIGRAM_MIN = 0.4;
const TITLE_CANDIDATES = 20;
const RESULT_LIMIT = 30;

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

export type SearchInput = {
  companyText: string;
  roleText: string;
  skillNames: string[];
  experienceYears: number | null;
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
};

export async function searchJobs(input: SearchInput): Promise<JobCard[]> {
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

  // Score = skill coverage only: matched skills / job's required-skill count.
  // Filters (title, company, experience) decide which jobs qualify; coverage
  // ranks and badges them. No skills → coverage is null and the badge shows "—".
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
           ELSE NULL END AS "coverage"
    FROM "Job" j
    JOIN "Company" c ON c.id = j."companyId"
    -- Count the JOB's skill tokens, and how many are covered by any user skill.
    -- Counting job tokens (not user skills) keeps matched ≤ required, so
    -- coverage stays in [0,1] and "matched / total" reads correctly.
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM unnest(${skills}::text[]) sk
          WHERE length(regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g')) > 0
            AND regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')
              LIKE '%' || regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g') || '%'
        ))::int AS matched,
        COUNT(*)::int AS required
      FROM regexp_split_to_table(COALESCE(j."requiredSkills", ''), '[,;|]') AS tok
      WHERE length(regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')) > 0
    ) cov
    WHERE (cardinality(${titleIds}::text[]) = 0 OR j.id = ANY(${titleIds}::text[]))
      AND (cardinality(${companyIds}::text[]) = 0 OR j."companyId" = ANY(${companyIds}::text[]))
      AND (
        ${input.experienceYears}::int IS NULL
        OR ${input.experienceYears}::int BETWEEN COALESCE(j."experienceMinYears", 0)
                                             AND COALESCE(j."experienceMaxYears", 99)
      )
    ORDER BY "coverage" DESC NULLS LAST, j."createdAt" ASC
    LIMIT ${RESULT_LIMIT}
  `;

  return rows
    // With skills, a job must share at least one (coverage > 0). Without skills,
    // there's no score to gate on — show every filtered job.
    .filter((row) => !hasSkills || (row.coverage != null && row.coverage > 0))
    .map((row) => {
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
        score: row.coverage == null ? null : Math.round(row.coverage * 100),
        matchedSkills: row.matched,
        totalSkills: row.required,
      };
    });
}
