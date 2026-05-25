import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Seniority, SkillCategory } from "@prisma/client";

type JobPostingRow = {
  company_name: string | null;
  job_title: string;
  role_type: string | null;
  required_skills: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  site: string | null;
  row_hash: string | null;
};

type RoleInfo = {
  roleSlug: string;
  roleName: string;
  seniority: Seniority;
};

const targetUrl = process.env.ROUND_DB_URL;

if (!targetUrl) {
  throw new Error("ROUND_DB_URL is required");
}

const target = new PrismaClient({
  adapter: new PrismaPg({ connectionString: targetUrl }),
});

function normalizeRole(row: JobPostingRow): RoleInfo {
  const text = `${row.role_type ?? ""} ${row.job_title}`.toLowerCase();
  const seniority = deriveSeniority(row.experience_min_years);

  if (text.includes("frontend") || text.includes("front end") || text.includes("ui")) {
    return { roleSlug: "frontend_engineer", roleName: "Frontend Engineer", seniority };
  }
  if (text.includes("backend") || text.includes("back end") || text.includes("api")) {
    return { roleSlug: "backend_engineer", roleName: "Backend Engineer", seniority };
  }
  if (text.includes("full stack") || text.includes("fullstack") || text.includes("mean")) {
    return { roleSlug: "fullstack_engineer", roleName: "Fullstack Engineer", seniority };
  }
  if (text.includes("machine learning") || text.includes(" ml ") || text.includes(" ai ")) {
    return { roleSlug: "ml_engineer", roleName: "ML Engineer", seniority };
  }
  return { roleSlug: "software_engineer", roleName: "Software Engineer", seniority };
}

function deriveSeniority(experienceYears: number | null) {
  if (experienceYears === null) return Seniority.entry;
  if (experienceYears <= 2) return Seniority.entry;
  if (experienceYears <= 6) return Seniority.mid;
  return Seniority.senior;
}

function splitSkills(value: string | null) {
  if (!value) return [];
  return value
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 20);
}

function roleKey(role: RoleInfo) {
  return `${role.roleSlug}:${role.seniority}`;
}

function sourceKey(row: JobPostingRow, companyName: string) {
  return row.row_hash ?? `${companyName}:${row.job_title}:${row.site ?? ""}`;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const confirm = process.argv.includes("--confirm");

  if (!sourceUrl) {
    throw new Error("SOURCE_DATABASE_URL is required");
  }

  const source = new PrismaClient({
    adapter: new PrismaPg({ connectionString: sourceUrl }),
  });

  const rows = await source.$queryRawUnsafe<JobPostingRow[]>(`
    select company_name, job_title, role_type, required_skills, experience_min_years, experience_max_years, site, row_hash
    from job_postings
    where job_title is not null
    limit 1000
  `);

  const usableRows = rows.filter((row) => row.company_name?.trim());
  const companies = Array.from(new Set(usableRows.map((row) => row.company_name!.trim())));
  const roleMap = new Map<string, RoleInfo>();
  const skillNames = new Set<string>();

  for (const row of usableRows) {
    const role = normalizeRole(row);
    roleMap.set(roleKey(role), role);
    for (const skill of splitSkills(row.required_skills)) skillNames.add(skill);
  }

  console.log(
    JSON.stringify(
      {
        mode: confirm ? "confirm" : "dry-run",
        sourceRows: rows.length,
        companies: companies.length,
        roleProfiles: roleMap.size,
        skills: skillNames.size,
        sourceJobs: usableRows.length,
      },
      null,
      2
    )
  );

  if (!confirm) {
    await source.$disconnect();
    await target.$disconnect();
    console.log("Dry run only. Re-run with --confirm to insert into ROUND_DB_URL.");
    return;
  }

  await target.company.createMany({
    data: companies.map((name) => ({ name })),
    skipDuplicates: true,
  });

  for (const role of roleMap.values()) {
    await target.roleProfile.upsert({
      where: { roleSlug_seniority: { roleSlug: role.roleSlug, seniority: role.seniority } },
      update: { roleName: role.roleName },
      create: role,
    });
  }

  await target.skill.createMany({
    data: Array.from(skillNames).map((name) => ({ name, category: SkillCategory.concept })),
    skipDuplicates: true,
  });

  const [storedCompanies, storedRoles, storedSkills] = await Promise.all([
    target.company.findMany({ where: { name: { in: companies } } }),
    target.roleProfile.findMany(),
    target.skill.findMany({ where: { name: { in: Array.from(skillNames) } } }),
  ]);

  const companyByName = new Map(storedCompanies.map((company) => [company.name, company]));
  const roleByKey = new Map(
    storedRoles.map((role) => [`${role.roleSlug}:${role.seniority}`, role])
  );
  const skillByName = new Map(storedSkills.map((skill) => [skill.name, skill]));

  const roleSkillPairs = new Map<string, { roleProfileId: string; skillId: string; weight: number }>();
  const sourceJobs = [];

  for (const row of usableRows) {
    const companyName = row.company_name!.trim();
    const roleInfo = normalizeRole(row);
    const company = companyByName.get(companyName);
    const role = roleByKey.get(roleKey(roleInfo));
    if (!company || !role) continue;

    sourceJobs.push({
      companyId: company.id,
      roleProfileId: role.id,
      jobTitle: row.job_title,
      sourceRoleType: row.role_type,
      requiredSkills: row.required_skills,
      experienceMinYears: row.experience_min_years,
      experienceMaxYears: row.experience_max_years,
      sourceSite: row.site,
      sourceRowHash: sourceKey(row, companyName),
    });

    for (const skillName of splitSkills(row.required_skills)) {
      const skill = skillByName.get(skillName);
      if (!skill) continue;
      roleSkillPairs.set(`${role.id}:${skill.id}`, {
        roleProfileId: role.id,
        skillId: skill.id,
        weight: 1,
      });
    }
  }

  await target.roleProfileSkill.createMany({
    data: Array.from(roleSkillPairs.values()),
    skipDuplicates: true,
  });

  await target.sourceJob.createMany({
    data: sourceJobs,
    skipDuplicates: true,
  });

  await source.$disconnect();
  await target.$disconnect();
  console.log("Imported existing job posting companies, role profiles, skills, role-skill links, and source jobs.");
}

main().catch(async (error) => {
  console.error(error);
  await target.$disconnect();
  process.exit(1);
});
