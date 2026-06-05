import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "../lib/embeddings";
import { roundDbAdapter } from "../lib/pgAdapter";

async function main() {
  const prisma = new PrismaClient({ adapter: roundDbAdapter() });

  const queries = ["SDE", "Product designer", "web dev", "ML", "swe", "backend", "frontend dev"];

  for (const q of queries) {
    const vec = toPgVectorLiteral(await embed(q));
    const rows = await prisma.$queryRawUnsafe<{ roleName: string; score: number }[]>(
      `SELECT "roleName", (1 - (embedding <=> $1::vector))::float AS score
       FROM "RoleProfile"
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      vec
    );
    console.log(`\n[${q}]`);
    for (const r of rows) console.log(`  ${r.score.toFixed(3)}  ${r.roleName}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
