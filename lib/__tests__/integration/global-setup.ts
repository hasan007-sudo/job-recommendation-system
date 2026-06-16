// Integration global setup: spin up a throwaway pgvector Postgres, provision the
// schema, and hand its connection string to the workers via provide()/inject().
//
// SAFETY: this suite must NEVER touch the real database. We capture whatever
// ROUND_DB_URL the environment carries (bun auto-loads .env), assert the
// container URL differs from it, and only ever operate on the container. Every
// DB op below — prisma db push and db-init.sql — runs against the container URL.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    roundDbUrl: string;
  }
}

const IMAGE = "pgvector/pgvector:pg16";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export default async function setup(project: TestProject) {
  const realUrl = process.env.ROUND_DB_URL; // the real DB — off-limits

  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer(IMAGE).start();
  const uri = container.getConnectionUri();

  // Hard guard: refuse to provision/seed if the container URL matches the real
  // DB by full string OR by host. Every DB op below uses `uri` only; this makes
  // it impossible for prisma db push / db-init / seeds to reach production.
  if (realUrl && (uri === realUrl || hostOf(uri) === hostOf(realUrl))) {
    await container.stop();
    throw new Error(
      "Integration setup refused: container URL shares a host with the configured ROUND_DB_URL.",
    );
  }

  // 1) Extensions first, so the Unsupported vector(512) column can be created.
  const ext = new Client({ connectionString: uri });
  await ext.connect();
  await ext.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await ext.query("CREATE EXTENSION IF NOT EXISTS vector");
  await ext.end();

  // 2) Tables from schema.prisma (drift-free) — targeting the container only.
  //    prisma.config.ts reads ROUND_DB_URL via env(); dotenv won't override an
  //    already-set var, so passing it here guarantees the container is the target.
  execFileSync("bunx", ["prisma", "db", "push", "--skip-generate"], {
    env: { ...process.env, ROUND_DB_URL: uri },
    stdio: "inherit",
  });

  // 3) Trigram GIN + HNSW indexes + dedup_key column (idempotent).
  const init = new Client({ connectionString: uri });
  await init.connect();
  await init.query(readFileSync("prisma/db-init.sql", "utf8"));
  await init.end();

  project.provide("roundDbUrl", uri);

  return async () => {
    await container.stop();
  };
}
