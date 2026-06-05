import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "../lib/embeddings";

// One-time re-embed after switching the embedding model (MiniLM 384 -> Titan 512).
// Reads jobs from the target DB and rebuilds the composite text from stored
// columns (no dependency on SOURCE_DATABASE_URL). Run after migrate-embedding-512.sql.
//   bun run tsx scripts/reembed-jobs.ts              # all jobs
//   bun run tsx scripts/reembed-jobs.ts <jobId>      # one job

const connectionString = process.env.ROUND_DB_URL;
if (!connectionString) throw new Error("ROUND_DB_URL is required");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Mirror embeddingText() in prisma/import-jobs.ts, using the stored columns.
function embeddingText(j: {
  jobTitle: string;
  roleType: string | null;
  roleSummary: string | null;
  requiredSkills: string | null;
}): string {
  return `${j.jobTitle}. ${j.roleType ?? ""}. ${j.roleSummary ?? ""}. Skills: ${j.requiredSkills ?? ""}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry on Bedrock throttling with exponential backoff.
async function embedWithRetry(text: string, attempt = 0): Promise<number[]> {
  try {
    return await embed(text);
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "ThrottlingException" && attempt < 5) {
      await sleep(500 * 2 ** attempt);
      return embedWithRetry(text, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const jobId = process.argv[2];
  const jobs = await prisma.job.findMany({
    where: jobId ? { id: jobId } : undefined,
    select: { id: true, jobTitle: true, roleType: true, roleSummary: true, requiredSkills: true },
  });
  if (jobId && jobs.length === 0) throw new Error(`No job found with id ${jobId}`);
  console.log(`Re-embedding ${jobs.length} job(s)...`);

  let done = 0;
  for (const job of jobs) {
    const vec = await embedWithRetry(embeddingText(job));
    await prisma.$executeRawUnsafe(
      `UPDATE "Job" SET embedding = $1::vector WHERE id = $2`,
      toPgVectorLiteral(vec),
      job.id
    );
    if (++done % 100 === 0) console.log(`  embedded ${done}/${jobs.length}`);
  }

  await prisma.$disconnect();
  console.log(`Done. Re-embedded ${done} jobs.`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
