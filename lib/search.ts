// 3-layer hybrid search: exact -> pg_trgm -> pgvector cosine.
// Replaces the in-memory linear-scan resolver. Uses indexed SQL throughout.

import type { Seniority } from "@prisma/client";
import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";
import type { PlanCard } from "./types";

// Score weights. Tune these.
const SCORE_WEIGHTS = {
  company: 3,
  role: 2,
  seniority: 1.5,
};

const TRIGRAM_MIN = {
  company: 0.4,
  role: 0.35,
  skill: 0.45,
};

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

// ── Layered matchers ───────────────────────────────────────────────────────

export async function matchCompany(text: string): Promise<Match[]> {
  const norm = normalize(text);
  if (!norm) return [];

  // Layer 2: exact (case-insensitive)
  const exact = await prisma.$queryRaw<Match[]>`
    SELECT id, 1.0::float AS score FROM "Company"
    WHERE lower(name) = ${norm}
    LIMIT 5
  `;
  if (exact.length > 0) return exact;

  // Layer 3: pg_trgm
  const trgm = await prisma.$queryRaw<Match[]>`
    SELECT id, similarity(name, ${text})::float AS score FROM "Company"
    WHERE name % ${text}
    ORDER BY score DESC
    LIMIT 5
  `;
  if (trgm.length > 0 && trgm[0].score >= TRIGRAM_MIN.company) return trgm;

  // Layer 4: vector cosine
  const vec = await embed(text);
  const vecLit = toPgVectorLiteral(vec);
  const ann = await prisma.$queryRaw<Match[]>`
    SELECT id, (1 - (embedding <=> ${vecLit}::vector))::float AS score FROM "Company"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT 5
  `;
  return ann;
}

type RoleMatch = { id: string; roleSlug: string; seniority: Seniority; score: number };

export async function matchRoles(text: string): Promise<RoleMatch[]> {
  const norm = normalize(text);
  if (!norm) return [];

  // Exact: roleSlug or roleName
  const exact = await prisma.$queryRaw<RoleMatch[]>`
    SELECT id, "roleSlug", seniority, 1.0::float AS score FROM "RoleProfile"
    WHERE lower("roleSlug") = ${norm} OR lower("roleName") = ${norm}
    LIMIT 10
  `;
  if (exact.length > 0) return exact;

  const trgm = await prisma.$queryRaw<RoleMatch[]>`
    SELECT id, "roleSlug", seniority, similarity("roleName", ${text})::float AS score
    FROM "RoleProfile"
    WHERE "roleName" % ${text}
    ORDER BY score DESC
    LIMIT 10
  `;
  if (trgm.length > 0 && trgm[0].score >= TRIGRAM_MIN.role) return trgm;

  const vec = await embed(text);
  const vecLit = toPgVectorLiteral(vec);
  const ann = await prisma.$queryRaw<RoleMatch[]>`
    SELECT id, "roleSlug", seniority, (1 - (embedding <=> ${vecLit}::vector))::float AS score
    FROM "RoleProfile"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT 10
  `;
  return ann;
}

export async function matchSkill(text: string): Promise<Match[]> {
  const norm = normalize(text);
  if (!norm) return [];

  const exact = await prisma.$queryRaw<Match[]>`
    SELECT id, 1.0::float AS score FROM "Skill"
    WHERE lower(name) = ${norm}
    LIMIT 3
  `;
  if (exact.length > 0) return exact;

  const trgm = await prisma.$queryRaw<Match[]>`
    SELECT id, similarity(name, ${text})::float AS score FROM "Skill"
    WHERE name % ${text}
    ORDER BY score DESC
    LIMIT 3
  `;
  if (trgm.length > 0 && trgm[0].score >= TRIGRAM_MIN.skill) return trgm;

  const vec = await embed(text);
  const vecLit = toPgVectorLiteral(vec);
  const ann = await prisma.$queryRaw<Match[]>`
    SELECT id, (1 - (embedding <=> ${vecLit}::vector))::float AS score FROM "Skill"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT 3
  `;
  return ann;
}

export async function matchSkills(texts: string[]): Promise<Match[]> {
  const all = await Promise.all(texts.map((t) => matchSkill(t)));
  // Dedupe by id, keep max score per skill.
  const byId = new Map<string, number>();
  for (const matches of all) {
    for (const m of matches) {
      const prev = byId.get(m.id) ?? 0;
      if (m.score > prev) byId.set(m.id, m.score);
    }
  }
  return Array.from(byId.entries()).map(([id, score]) => ({ id, score }));
}

// ── Main search ─────────────────────────────────────────────────────────────

export type SearchInput = {
  companyText: string;
  roleText: string;
  skillNames: string[];
  experienceYears: number | null;
};

type SearchRow = {
  planId: string;
  companyId: string | null;
  companyName: string | null;
  roleSlug: string;
  roleName: string;
  seniority: Seniority;
  cachedRoundCount: number;
  companyScore: number;
  roleScore: number;
  skillWeightSum: number;
  seniorityBonus: number;
  totalScore: number;
};

export async function searchPlans(input: SearchInput): Promise<PlanCard[]> {
  const seniority = deriveSeniority(input.experienceYears);

  const [companyMatches, roleMatches, skillMatches] = await Promise.all([
    input.companyText ? matchCompany(input.companyText) : Promise.resolve([] as Match[]),
    input.roleText ? matchRoles(input.roleText) : Promise.resolve([] as RoleMatch[]),
    input.skillNames.length > 0 ? matchSkills(input.skillNames) : Promise.resolve([] as Match[]),
  ]);

  const companyIds = companyMatches.map((m) => m.id);
  const companyScoreById = new Map(companyMatches.map((m) => [m.id, m.score]));

  // Build the set of candidate role IDs. If we got direct role matches, use them;
  // otherwise fall back to skill-inferred roles (role profiles that link to any matched skill).
  let roleIds = roleMatches.map((r) => r.id);
  const roleScoreById = new Map(roleMatches.map((r) => [r.id, r.score]));

  if (roleIds.length === 0 && skillMatches.length > 0) {
    const skillIds = skillMatches.map((s) => s.id);
    const inferred = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT rp.id FROM "RoleProfile" rp
      JOIN "RoleProfileSkill" rps ON rps."roleProfileId" = rp.id
      WHERE rps."skillId" = ANY(${skillIds}::text[])
    `;
    roleIds = inferred.map((r) => r.id);
  }

  // When no role/skill signal was provided, leave roleIds empty.
  // The SQL filter below treats an empty array as "no role constraint" via cardinality()=0.
  // Scoring + LIMIT 20 surfaces the relevant plans (e.g. company-matched ones float up).

  const skillIds = skillMatches.map((s) => s.id);

  // Single ranking query. Returns company-specific plans for matched companies
  // PLUS global fallback plans, scored together.
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT
      p.id AS "planId",
      p."companyId",
      c.name AS "companyName",
      rp."roleSlug",
      rp."roleName",
      rp.seniority,
      p."cachedRoundCount",
      COALESCE((
        SELECT MAX(s.score) FROM (
          SELECT unnest(${companyIds}::text[]) AS id,
                 unnest(${companyMatches.map((m) => m.score)}::float[]) AS score
        ) s WHERE s.id = p."companyId"
      ), 0)::float AS "companyScore",
      COALESCE((
        SELECT MAX(s.score) FROM (
          SELECT unnest(${roleMatches.map((r) => r.id)}::text[]) AS id,
                 unnest(${roleMatches.map((r) => r.score)}::float[]) AS score
        ) s WHERE s.id = rp.id
      ), 0)::float AS "roleScore",
      COALESCE((
        SELECT SUM(rps.weight)::float FROM "RoleProfileSkill" rps
        WHERE rps."roleProfileId" = rp.id AND rps."skillId" = ANY(${skillIds}::text[])
      ), 0) AS "skillWeightSum",
      CASE WHEN rp.seniority = ${seniority}::"Seniority" THEN ${SCORE_WEIGHTS.seniority}::float ELSE 0::float END AS "seniorityBonus",
      (
        COALESCE((
          SELECT MAX(s.score) FROM (
            SELECT unnest(${companyIds}::text[]) AS id,
                   unnest(${companyMatches.map((m) => m.score)}::float[]) AS score
          ) s WHERE s.id = p."companyId"
        ), 0) * ${SCORE_WEIGHTS.company}::float
        + COALESCE((
          SELECT MAX(s.score) FROM (
            SELECT unnest(${roleMatches.map((r) => r.id)}::text[]) AS id,
                   unnest(${roleMatches.map((r) => r.score)}::float[]) AS score
          ) s WHERE s.id = rp.id
        ), 0) * ${SCORE_WEIGHTS.role}::float
        + COALESCE((
          SELECT SUM(rps.weight)::float FROM "RoleProfileSkill" rps
          WHERE rps."roleProfileId" = rp.id AND rps."skillId" = ANY(${skillIds}::text[])
        ), 0)
        + CASE WHEN rp.seniority = ${seniority}::"Seniority" THEN ${SCORE_WEIGHTS.seniority}::float ELSE 0::float END
      )::float AS "totalScore"
    FROM "InterviewPlan" p
    LEFT JOIN "Company" c ON p."companyId" = c.id
    JOIN "RoleProfile" rp ON p."roleProfileId" = rp.id
    WHERE p.status = 'verified'
      AND (
        rp.id = ANY(${roleIds}::text[])
        OR cardinality(${roleIds}::text[]) = 0
      )
      AND (
        p."companyId" IS NULL
        OR p."companyId" = ANY(${companyIds}::text[])
        OR cardinality(${companyIds}::text[]) = 0
      )
    ORDER BY "totalScore" DESC, p."createdAt" ASC
    LIMIT 20
  `;

  return rows.map((row) => ({
    planId: row.planId,
    companyName: row.companyName,
    roleName: row.roleName,
    roleSlug: row.roleSlug,
    seniority: row.seniority,
    roundCount: Number(row.cachedRoundCount),
    score: Number(row.totalScore),
    components: {
      company: Number(row.companyScore),
      role: Number(row.roleScore),
      skill: Number(row.skillWeightSum),
      seniority: Number(row.seniorityBonus),
    },
  }));
}
