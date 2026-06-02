import { prisma } from "./prisma";
import { embed, toPgVectorLiteral } from "./embeddings";

type Row = { id: string; sim: number };

// Cosine similarity (1 - distance) → percent. Rescaled to spread typical
// resume↔JD similarities (~0.2–0.8) across a 0–100 band so the badge varies.
function simToPercent(sim: number): number {
  const clamped = Math.max(0, Math.min(1, (sim - 0.15) / 0.55));
  return Math.round(clamped * 100);
}

export async function computeMatchScores(
  resumeText: string,
  jobIds: string[]
): Promise<Record<string, number>> {
  if (!resumeText.trim() || jobIds.length === 0) return {};
  const vec = await embed(resumeText);
  const vecLit = toPgVectorLiteral(vec);

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, (1 - (embedding <=> ${vecLit}::vector))::float AS sim
    FROM "Job"
    WHERE id = ANY(${jobIds}) AND embedding IS NOT NULL
  `;

  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = simToPercent(r.sim);
  return out;
}
