import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { backfillJobMatchData } from "../lib/job-match-backfill";

// Populates Skill / JobSkill / JobCapability for existing jobs. Resumable —
// jobs already populated are skipped, and the Skill catalog only glosses/embeds
// tokens it hasn't seen. Requires OPENROUTER_API_KEY (glosses) + AWS creds
// (Titan embeddings).
//   npx tsx scripts/backfill-job-match-embeddings.ts            # all jobs
//   npx tsx scripts/backfill-job-match-embeddings.ts <jobId>    # one job (debugging)

const connectionString = process.env.ROUND_DB_URL;
if (!connectionString) throw new Error("ROUND_DB_URL is required");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  const jobId = process.argv[2];
  const result = await backfillJobMatchData(prisma, { jobId, log: console.log });
  console.log(
    `Done. jobs=${result.jobsProcessed} newSkills=${result.newSkills} ` +
      `jobSkillLinks=${result.jobSkillLinks} capabilities=${result.capabilities}`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
