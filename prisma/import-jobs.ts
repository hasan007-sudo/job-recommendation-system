import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "../lib/embeddings";

type JobRow = {
  company_name: string | null;
  job_title: string | null;
  role_type: string | null;
  location: string | null;
  role_summary: string | null;
  key_responsibilities: string | null;
  required_skills: string | null;
  focus_rounds: string | null;
  focus_round_pattern: string | null;
  salary_inr_per_year_min: number | null;
  salary_inr_per_year_max: number | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  site: string | null;
  row_hash: string | null;
  loaded_at: Date | null;
  updated_at: Date | null;
};

const targetUrl = process.env.ROUND_DB_URL;
if (!targetUrl) throw new Error("ROUND_DB_URL is required");

const target = new PrismaClient({ adapter: new PrismaPg({ connectionString: targetUrl }) });

function norm(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function segmentCount(pattern: string | null): number {
  if (!pattern) return 0;
  return pattern.split("+").map((s) => s.trim()).filter(Boolean).length;
}

// Winner per (company, title): richest round pattern → freshest → most skills → stable hash.
function isBetter(candidate: JobRow, current: JobRow): boolean {
  const a = segmentCount(candidate.focus_round_pattern);
  const b = segmentCount(current.focus_round_pattern);
  if (a !== b) return a > b;

  const at = candidate.updated_at ? candidate.updated_at.getTime() : 0;
  const bt = current.updated_at ? current.updated_at.getTime() : 0;
  if (at !== bt) return at > bt;

  const as = candidate.required_skills?.length ?? 0;
  const bs = current.required_skills?.length ?? 0;
  if (as !== bs) return as > bs;

  return (candidate.row_hash ?? "") < (current.row_hash ?? "");
}

function embeddingText(row: JobRow): string {
  return `${row.job_title}. ${row.role_type ?? ""}. ${row.role_summary ?? ""}. Skills: ${row.required_skills ?? ""}`;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const confirm = process.argv.includes("--confirm");
  if (!sourceUrl) throw new Error("SOURCE_DATABASE_URL is required");

  const source = new PrismaClient({ adapter: new PrismaPg({ connectionString: sourceUrl }) });

  const rows = await source.$queryRawUnsafe<JobRow[]>(`
    SELECT company_name, job_title, role_type, location, role_summary, key_responsibilities,
           required_skills, focus_rounds, focus_round_pattern,
           salary_inr_per_year_min, salary_inr_per_year_max,
           experience_min_years, experience_max_years, site, row_hash, loaded_at, updated_at
    FROM job_postings
    WHERE job_title IS NOT NULL AND company_name IS NOT NULL AND focus_round_pattern IS NOT NULL
  `);

  // Dedup by (company, lower title): keep the richest row.
  const winners = new Map<string, JobRow>();
  for (const row of rows) {
    if (!norm(row.company_name) || !norm(row.job_title)) continue;
    const key = `${norm(row.company_name)}|${norm(row.job_title)}`;
    const current = winners.get(key);
    if (!current || isBetter(row, current)) winners.set(key, row);
  }

  const deduped = Array.from(winners.values());
  const companyNames = Array.from(new Set(deduped.map((r) => r.company_name!.trim())));

  console.log(
    JSON.stringify(
      {
        mode: confirm ? "confirm" : "dry-run",
        sourceRows: rows.length,
        afterDedup: deduped.length,
        companies: companyNames.length,
      },
      null,
      2
    )
  );

  if (!confirm) {
    await source.$disconnect();
    await target.$disconnect();
    console.log("Dry run only. Re-run with --confirm to write to ROUND_DB_URL.");
    return;
  }

  // 1. Companies
  await target.company.createMany({
    data: companyNames.map((name) => ({ name })),
    skipDuplicates: true,
  });
  const companies = await target.company.findMany({ where: { name: { in: companyNames } } });
  const companyByName = new Map(companies.map((c) => [c.name, c.id]));

  // 2. Jobs
  const jobData = deduped
    .map((row) => {
      const companyId = companyByName.get(row.company_name!.trim());
      if (!companyId) return null;
      return {
        companyId,
        jobTitle: row.job_title!,
        site: row.site,
        location: row.location,
        roleType: row.role_type,
        requiredSkills: row.required_skills,
        roleSummary: row.role_summary,
        keyResponsibilities: row.key_responsibilities,
        focusRoundPattern: row.focus_round_pattern!,
        focusRounds: row.focus_rounds,
        experienceMinYears: row.experience_min_years,
        experienceMaxYears: row.experience_max_years,
        salaryInrMinPerYear: row.salary_inr_per_year_min,
        salaryInrMaxPerYear: row.salary_inr_per_year_max,
        sourceRowHash: row.row_hash ?? `${norm(row.company_name)}:${norm(row.job_title)}`,
        loadedAt: row.loaded_at,
        sourceUpdatedAt: row.updated_at,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await target.job.createMany({ data: jobData, skipDuplicates: true });

  // 3. Embeddings — backfill rows that have none.
  const textByHash = new Map(deduped.map((r) => [r.row_hash ?? `${norm(r.company_name)}:${norm(r.job_title)}`, embeddingText(r)]));
  const pending = await target.$queryRaw<{ id: string; sourceRowHash: string }[]>`
    SELECT id, "sourceRowHash" FROM "Job" WHERE embedding IS NULL
  `;

  let done = 0;
  for (const job of pending) {
    const text = textByHash.get(job.sourceRowHash);
    if (!text) continue;
    const vec = await embed(text);
    await target.$executeRawUnsafe(
      `UPDATE "Job" SET embedding = $1::vector WHERE id = $2`,
      toPgVectorLiteral(vec),
      job.id
    );
    if (++done % 100 === 0) console.log(`  embedded ${done}/${pending.length}`);
  }

  await source.$disconnect();
  await target.$disconnect();
  console.log(`Imported ${jobData.length} jobs across ${companyNames.length} companies. Embedded ${done}.`);
}

main().catch(async (error) => {
  console.error(error);
  await target.$disconnect();
  process.exit(1);
});
