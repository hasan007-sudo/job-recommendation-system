import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "../lib/embeddings";
import { backfillJobMatchData } from "../lib/job-match-backfill";

type JobRow = {
  company_name: string | null;
  job_title: string | null;
  role_category: string | null;
  role_type: string | null;
  location: string | null;
  work_mode: string | null;
  role_summary: string | null;
  key_responsibilities: string | null;
  required_skills: string | null;
  other_skills_notes: string | null;
  education_requirement: string | null;
  round_screening: string | null;
  round_behavioural: string | null;
  round_technical: string | null;
  round_culture_fit: string | null;
  salary_inr_per_year_min: number | null;
  salary_inr_per_year_max: number | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  source_url: string | null;
  full_job_description: string | null;
  site: string | null;
  row_hash: string | null;
  loaded_at: Date | null;
  updated_at: Date | null;
};

// Fixed 4-round structure that every imported job uses. Stored in focusRoundPattern
// so the existing listing/search layer (parseRounds) keeps working unchanged.
const FIXED_ROUND_PATTERN = "Screening + Behavioural + Technical + Culture fit";

const targetUrl = process.env.ROUND_DB_URL;
if (!targetUrl) throw new Error("ROUND_DB_URL is required");

const target = new PrismaClient({ adapter: new PrismaPg({ connectionString: targetUrl }) });

function norm(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

// Winner per row hash: richest JD → freshest → most skills → stable hash.
function isBetter(candidate: JobRow, current: JobRow): boolean {
  const a = candidate.full_job_description?.length ?? 0;
  const b = current.full_job_description?.length ?? 0;
  if (a !== b) return a > b;

  const at = candidate.updated_at ? candidate.updated_at.getTime() : 0;
  const bt = current.updated_at ? current.updated_at.getTime() : 0;
  if (at !== bt) return at > bt;

  const as = candidate.required_skills?.length ?? 0;
  const bs = current.required_skills?.length ?? 0;
  if (as !== bs) return as > bs;

  return (candidate.row_hash ?? "") < (current.row_hash ?? "");
}

// Role-retrieval embedding only (title/roleType/summary). Skills are embedded
// per-token in the Skill catalog; capabilities per-statement in JobCapability.
function embeddingText(row: JobRow): string {
  return `${row.job_title}. ${row.role_type ?? ""}. ${row.role_summary ?? ""}`;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const confirm = process.argv.includes("--confirm");
  if (!sourceUrl) throw new Error("SOURCE_DATABASE_URL is required");

  const source = new PrismaClient({ adapter: new PrismaPg({ connectionString: sourceUrl }) });

  const rows = await source.$queryRawUnsafe<JobRow[]>(`
    SELECT company_name, job_title, role_category, role_type, location, work_mode,
           role_summary, key_responsibilities, required_skills, other_skills_notes,
           education_requirement, round_screening, round_behavioural, round_technical,
           round_culture_fit, salary_inr_per_year_min, salary_inr_per_year_max,
           experience_min_years, experience_max_years, source_url, full_job_description,
           site, row_hash, loaded_at, updated_at
    FROM "JobPostingsV2"
    WHERE job_title IS NOT NULL AND company_name IS NOT NULL
  `);

  // Dedup by source row hash (same-title roles at one company are distinct jobs);
  // rows without a hash fall back to (company, lower title). Keep the richest row.
  const winners = new Map<string, JobRow>();
  for (const row of rows) {
    if (!norm(row.company_name) || !norm(row.job_title)) continue;
    const key = row.row_hash ?? `${norm(row.company_name)}:${norm(row.job_title)}`;
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
        roleCategory: row.role_category,
        roleType: row.role_type,
        workMode: row.work_mode,
        requiredSkills: row.required_skills,
        otherSkillsNotes: row.other_skills_notes,
        educationRequirement: row.education_requirement,
        roleSummary: row.role_summary,
        keyResponsibilities: row.key_responsibilities,
        sourceUrl: row.source_url,
        fullJobDescription: row.full_job_description,
        roundScreening: row.round_screening,
        roundBehavioural: row.round_behavioural,
        roundTechnical: row.round_technical,
        roundCultureFit: row.round_culture_fit,
        focusRoundPattern: FIXED_ROUND_PATTERN,
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

  // 4. Match-scoring data — Skill catalog (gloss + embed new tokens only),
  //    JobSkill links, JobCapability rows. Resumable; skips populated jobs.
  const match = await backfillJobMatchData(target, { log: console.log });

  await source.$disconnect();
  await target.$disconnect();
  console.log(
    `Imported ${jobData.length} jobs across ${companyNames.length} companies. Embedded ${done}. ` +
      `Match data: +${match.newSkills} skills, ${match.jobSkillLinks} links, ${match.capabilities} capabilities.`,
  );
}

main().catch(async (error) => {
  console.error(error);
  await target.$disconnect();
  process.exit(1);
});
