// Populates the match-scoring tables for jobs: the deduped Skill catalog
// (gloss + embedding, created once per distinct token), JobSkill links, and
// JobCapability rows (one embedded statement per capability). Shared by
// prisma/import-jobs.ts, prisma/seed-jd-files.ts, and
// scripts/backfill-job-match-embeddings.ts — all pass their own PrismaClient.

import type { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "./embeddings";
import { glossSkills, normalizeSkillToken } from "./glosses";

const GLOSS_BATCH_SIZE = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry on Bedrock throttling AND transient network failures (DNS blips,
// dropped HTTP/2 streams) with exponential backoff. A long backfill must not
// die on one connectivity hiccup.
const RETRYABLE = new Set([
  "ThrottlingException",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_HTTP2_STREAM_CANCEL",
  "TimeoutError",
]);

function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  return (
    RETRYABLE.has(e?.name ?? "") ||
    RETRYABLE.has(e?.code ?? "") ||
    RETRYABLE.has(e?.cause?.code ?? "")
  );
}

async function embedWithRetry(text: string, attempt = 0): Promise<number[]> {
  try {
    return await embed(text);
  } catch (err: unknown) {
    if (isRetryable(err) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      return embedWithRetry(text, attempt + 1);
    }
    throw err;
  }
}

// Split requiredSkills on the existing separators, dedupe by normalized token.
export function splitSkillNames(requiredSkills: string | null): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of (requiredSkills ?? "").split(/[,;|]/)) {
    const name = raw.trim();
    const token = normalizeSkillToken(name);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    names.push(name);
  }
  return names;
}

// Capability statements = keyResponsibilities (split on ';') ∪ roleSummary
// (always) ∪ roundTechnical. requiredSkills is deliberately excluded — skills
// own 65% of the blend; including them here would double-count.
export function buildCapabilityTexts(job: {
  keyResponsibilities: string | null;
  roleSummary: string | null;
  roundTechnical: string | null;
}): string[] {
  const texts = [
    ...(job.keyResponsibilities ?? "").split(";").map((s) => s.trim()),
    (job.roleSummary ?? "").trim(),
    (job.roundTechnical ?? "").trim(),
  ].filter(Boolean);
  return [...new Set(texts)];
}

type JobRow = {
  id: string;
  requiredSkills: string | null;
  keyResponsibilities: string | null;
  roleSummary: string | null;
  roundTechnical: string | null;
};

export type BackfillResult = {
  jobsProcessed: number;
  newSkills: number;
  jobSkillLinks: number;
  capabilities: number;
};

// Resumable AND self-healing: a job is reprocessed unless its stored rows
// exactly match what the current sources produce (count-based, not
// existence-based — a kill mid-job must not leave partial data skipped
// forever). Rows whose embedding write was interrupted (NULL embedding) are
// also repaired. New distinct skill tokens are glossed (batched OpenRouter
// call) and embedded once; existing catalog tokens cost nothing.
export async function backfillJobMatchData(
  prisma: PrismaClient,
  opts: { jobId?: string; log?: (msg: string) => void } = {},
): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});

  const jobs = await prisma.job.findMany({
    where: opts.jobId ? { id: opts.jobId } : undefined,
    select: {
      id: true,
      requiredSkills: true,
      keyResponsibilities: true,
      roleSummary: true,
      roundTechnical: true,
      _count: { select: { skills: true, capabilities: true } },
    },
  });
  if (opts.jobId && jobs.length === 0) {
    throw new Error(`No job found with id ${opts.jobId}`);
  }

  // Heal Skill rows whose embedding write was interrupted.
  const unembeddedSkills = await prisma.$queryRaw<{ id: string; gloss: string }[]>`
    SELECT id, gloss FROM "Skill" WHERE embedding IS NULL
  `;
  for (const s of unembeddedSkills) {
    const vec = await embedWithRetry(s.gloss);
    await prisma.$executeRawUnsafe(
      `UPDATE "Skill" SET embedding = $1::vector WHERE id = $2`,
      toPgVectorLiteral(vec),
      s.id,
    );
  }
  if (unembeddedSkills.length > 0) {
    log(`  healed ${unembeddedSkills.length} Skill rows with missing embeddings`);
  }

  // Jobs with capability rows whose embedding write was interrupted.
  const nullCapJobs = await prisma.$queryRaw<{ jobId: string }[]>`
    SELECT DISTINCT "jobId" FROM "JobCapability" WHERE embedding IS NULL
  `;
  const incompleteCapJobs = new Set(nullCapJobs.map((r) => r.jobId));

  // Completeness-based resume: stored row counts must match what the current
  // sources produce, otherwise the job's rows are rebuilt from scratch.
  const needSkills = jobs.filter(
    (j) => j._count.skills !== splitSkillNames(j.requiredSkills).length,
  );
  const needCaps = jobs.filter(
    (j) =>
      j._count.capabilities !== buildCapabilityTexts(j).length ||
      incompleteCapJobs.has(j.id),
  );
  log(`jobs: ${jobs.length} total, ${needSkills.length} need skills, ${needCaps.length} need capabilities`);

  // --- Skill catalog: gloss + embed only tokens not already stored. ---------
  const tokenToLabel = new Map<string, string>();
  for (const job of needSkills) {
    for (const name of splitSkillNames(job.requiredSkills)) {
      const token = normalizeSkillToken(name);
      if (!tokenToLabel.has(token)) tokenToLabel.set(token, name);
    }
  }

  const existing = await prisma.skill.findMany({
    where: { token: { in: [...tokenToLabel.keys()] } },
    select: { id: true, token: true },
  });
  const skillIdByToken = new Map(existing.map((s) => [s.token, s.id]));
  const newTokens = [...tokenToLabel.keys()].filter((t) => !skillIdByToken.has(t));

  let newSkills = 0;
  for (let i = 0; i < newTokens.length; i += GLOSS_BATCH_SIZE) {
    const batch = newTokens.slice(i, i + GLOSS_BATCH_SIZE);
    const labels = batch.map((t) => tokenToLabel.get(t)!);
    const glosses = await glossSkills(labels);
    for (let k = 0; k < batch.length; k++) {
      const token = batch[k];
      const label = labels[k];
      const gloss = glosses.get(label) ?? label;
      const vec = await embedWithRetry(gloss);
      // Two steps because Prisma can't write Unsupported("vector") via create.
      const row = await prisma.skill.create({
        data: { token, label, gloss },
        select: { id: true },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "Skill" SET embedding = $1::vector WHERE id = $2`,
        toPgVectorLiteral(vec),
        row.id,
      );
      skillIdByToken.set(token, row.id);
      if (++newSkills % 50 === 0) log(`  skills: ${newSkills}/${newTokens.length}`);
    }
  }

  // --- JobSkill links (rebuilt whole-job so partial state can't persist). ----
  let jobSkillLinks = 0;
  for (const job of needSkills) {
    const data = splitSkillNames(job.requiredSkills)
      .map((name) => skillIdByToken.get(normalizeSkillToken(name)))
      .filter((id): id is string => Boolean(id))
      .map((skillId) => ({ jobId: job.id, skillId }));
    await prisma.jobSkill.deleteMany({ where: { jobId: job.id } });
    if (data.length > 0) {
      const res = await prisma.jobSkill.createMany({ data, skipDuplicates: true });
      jobSkillLinks += res.count;
    }
  }

  // --- JobCapability rows. ----------------------------------------------------
  // Jobs are processed in small parallel batches, and each job's capabilities
  // embed in parallel — the per-row latency is dominated by network round-trips
  // (Bedrock + two DB calls), so sequential processing is needlessly slow.
  const CAP_JOB_CONCURRENCY = 5;
  let capabilities = 0;
  let capJobsDone = 0;
  for (let i = 0; i < needCaps.length; i += CAP_JOB_CONCURRENCY) {
    const batch = needCaps.slice(i, i + CAP_JOB_CONCURRENCY);
    await Promise.all(
      batch.map(async (job) => {
        // Rebuild whole-job: drop any partial rows from an interrupted run.
        await prisma.jobCapability.deleteMany({ where: { jobId: job.id } });
        await Promise.all(
          buildCapabilityTexts(job).map(async (text) => {
            const vec = await embedWithRetry(text);
            const row = await prisma.jobCapability.create({
              data: { jobId: job.id, text },
              select: { id: true },
            });
            await prisma.$executeRawUnsafe(
              `UPDATE "JobCapability" SET embedding = $1::vector WHERE id = $2`,
              toPgVectorLiteral(vec),
              row.id,
            );
            capabilities++;
          }),
        );
        if (++capJobsDone % 25 === 0)
          log(`  capabilities: job ${capJobsDone}/${needCaps.length}`);
      }),
    );
  }

  return { jobsProcessed: jobs.length, newSkills, jobSkillLinks, capabilities };
}
