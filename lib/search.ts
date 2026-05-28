// Job-centric search: rank real scraped jobs by title (exact + trigram + semantic),
// company, skills (ILIKE on requiredSkills text), and experience fit.
// Rounds are parsed at read time from focusRoundPattern.

import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";
import { parseRounds } from "./rounds";
import type { JobCard, Seniority } from "./types";

const WEIGHTS = { title: 2.0, company: 1.5, skill: 1.0, experience: 0.5 };
const TITLE_TRIGRAM_MIN = 0.3;
const COMPANY_TRIGRAM_MIN = 0.4;
const TITLE_CANDIDATES = 200;
const RESULT_LIMIT = 30;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s+#./-]/g, "");
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
  totalScore: number;
};

export async function searchJobs(input: SearchInput): Promise<JobCard[]> {
  const [titleMatches, companyIds] = await Promise.all([
    input.roleText ? matchTitle(input.roleText) : Promise.resolve([] as Match[]),
    input.companyText ? matchCompanyIds(input.companyText) : Promise.resolve([] as string[]),
  ]);

  const skills = input.skillNames.map((s) => s.trim()).filter(Boolean);

  // Nothing to constrain on → don't dump the whole table.
  if (titleMatches.length === 0 && companyIds.length === 0 && skills.length === 0) {
    return [];
  }

  const titleIds = titleMatches.map((m) => m.id);
  const titleScores = titleMatches.map((m) => m.score);

  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT
      j.id AS "jobId",
      j."jobTitle",
      c.name AS "companyName",
      j."experienceMinYears",
      j."experienceMaxYears",
      j."focusRoundPattern",
      (
        ${WEIGHTS.title}::float * COALESCE((
          SELECT s.score FROM (
            SELECT unnest(${titleIds}::text[]) AS id,
                   unnest(${titleScores}::float[]) AS score
          ) s WHERE s.id = j.id LIMIT 1
        ), 0)
        + ${WEIGHTS.company}::float * (
          CASE
            WHEN cardinality(${companyIds}::text[]) > 0
                 AND j."companyId" = ANY(${companyIds}::text[]) THEN 1.0
            ELSE 0.0
          END
        )
        + ${WEIGHTS.skill}::float * (
          SELECT COUNT(*) FROM unnest(${skills}::text[]) sk
          WHERE length(regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g')) > 0
            AND EXISTS (
              SELECT 1
              FROM regexp_split_to_table(COALESCE(j."requiredSkills", ''), '[,;|]') AS tok
              WHERE regexp_replace(lower(btrim(tok)), '[^a-z0-9]', '', 'g')
                LIKE '%' || regexp_replace(lower(btrim(sk)), '[^a-z0-9]', '', 'g') || '%'
            )
        )::float
        + ${WEIGHTS.experience}::float * (
          CASE
            WHEN ${input.experienceYears}::int IS NULL THEN 0
            WHEN ${input.experienceYears}::int BETWEEN COALESCE(j."experienceMinYears", 0)
                                                   AND COALESCE(j."experienceMaxYears", 99) THEN 1.0
            ELSE 0.0
          END
        )
      )::float AS "totalScore"
    FROM "Job" j
    JOIN "Company" c ON c.id = j."companyId"
    WHERE (cardinality(${titleIds}::text[]) = 0 OR j.id = ANY(${titleIds}::text[]))
      AND (cardinality(${companyIds}::text[]) = 0 OR j."companyId" = ANY(${companyIds}::text[]))
    ORDER BY "totalScore" DESC, j."createdAt" ASC
    LIMIT ${RESULT_LIMIT}
  `;

  return rows
    .filter((row) => Number(row.totalScore) > 0)
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
        score: Number(row.totalScore),
      };
    });
}
