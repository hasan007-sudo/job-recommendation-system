import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";

type SkillRow = { name: string };

export async function GET() {
  const [companies, skillRows] = await Promise.all([
    prisma.company.findMany({ orderBy: { name: "asc" } }),
    // Skill suggestions = distinct tokens from every job's requiredSkills text.
    prisma.$queryRaw<SkillRow[]>`
      SELECT lower(btrim(s)) AS name, COUNT(*) AS n
      FROM "Job", regexp_split_to_table("requiredSkills", '[,;|]') AS s
      WHERE "requiredSkills" IS NOT NULL AND length(btrim(s)) >= 2
      GROUP BY lower(btrim(s))
      ORDER BY n DESC
      LIMIT 300
    `,
  ]);

  return NextResponse.json({
    companies: companies.map((company) => ({ id: company.id, name: company.name })),
    skills: skillRows.map((row) => ({ name: row.name })),
  });
}
