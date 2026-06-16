// Seed helpers for the integration suite, modelling the real relational schema:
// Skill catalog (token + gloss embedding) ← JobSkill → Job → JobCapability.
// They take an explicit PrismaClient already pointed at the throwaway container,
// and write every Unsupported `vector(512)` column via raw SQL (the only way
// Prisma can set it).

import type { PrismaClient } from "@prisma/client";
import { literal } from "./vectors";

let seq = 0;

// Wipe every table between tests so each case starts from a known empty state.
export async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "JobCapability", "JobSkill", "Job", "Skill", "Company" RESTART IDENTITY CASCADE',
  );
}

// Catalog skill. `token` must already be normalized (normalizeSkillToken form);
// `embedding` is the gloss vector used for semantic coverage. Returns skill id.
export async function seedSkill(
  prisma: PrismaClient,
  opts: { token: string; label?: string; gloss?: string; embedding?: number[] | null },
): Promise<string> {
  const skill = await prisma.skill.create({
    data: {
      token: opts.token,
      label: opts.label ?? opts.token,
      gloss: opts.gloss ?? opts.token,
    },
  });
  if (opts.embedding) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Skill" SET embedding = $1::vector WHERE id = $2`,
      literal(opts.embedding),
      skill.id,
    );
  }
  return skill.id;
}

export async function seedCompany(prisma: PrismaClient, name: string): Promise<string> {
  const company = await prisma.company.create({ data: { name } });
  return company.id;
}

export type CapabilitySeed = { text?: string; embedding?: number[] | null };

export type JobSeed = {
  title: string;
  experienceMinYears?: number | null;
  experienceMaxYears?: number | null;
  focusRoundPattern?: string;
  embedding?: number[] | null; // job title embedding (title vector tier)
  skillIds?: string[]; // JobSkill links (the job's required skills)
  capabilities?: CapabilitySeed[];
  createdAt?: Date;
};

// Create a job with its JobSkill links and JobCapability rows. Returns job id.
// Titles must be unique within a company (dedup_key generated column).
export async function seedJob(
  prisma: PrismaClient,
  companyId: string,
  j: JobSeed,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      companyId,
      jobTitle: j.title,
      focusRoundPattern:
        j.focusRoundPattern ?? "Opening/Screening+Technical/Role Skills",
      experienceMinYears: j.experienceMinYears ?? null,
      experienceMaxYears: j.experienceMaxYears ?? null,
      sourceRowHash: `seed-${seq++}`,
      ...(j.createdAt ? { createdAt: j.createdAt } : {}),
    },
  });

  if (j.embedding) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Job" SET embedding = $1::vector WHERE id = $2`,
      literal(j.embedding),
      job.id,
    );
  }

  for (const skillId of j.skillIds ?? []) {
    await prisma.jobSkill.create({ data: { jobId: job.id, skillId } });
  }

  for (const cap of j.capabilities ?? []) {
    const created = await prisma.jobCapability.create({
      data: { jobId: job.id, text: cap.text ?? "capability" },
    });
    if (cap.embedding) {
      await prisma.$executeRawUnsafe(
        `UPDATE "JobCapability" SET embedding = $1::vector WHERE id = $2`,
        literal(cap.embedding),
        created.id,
      );
    }
  }

  return job.id;
}
