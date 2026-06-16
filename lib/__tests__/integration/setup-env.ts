// Per-worker setup: runs BEFORE each integration test file's imports, so that
// lib/prisma.ts (imported transitively by lib/search.ts) connects to the
// throwaway container instead of the real DB. Overrides whatever ROUND_DB_URL
// bun/.env injected.
//
// SAFETY: bun auto-loads .env, so on entry process.env.ROUND_DB_URL is the
// PRODUCTION url. We capture it, then refuse to proceed unless the container url
// is a genuinely different host. The prisma singleton only ever sees the
// container url — production is never connected.

import { inject } from "vitest";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const prodUrl = process.env.ROUND_DB_URL; // production (from .env) — off-limits
const uri = inject("roundDbUrl"); // throwaway container

if (!uri) {
  throw new Error("integration setup-env: roundDbUrl was not provided by global setup");
}
if (prodUrl && (uri === prodUrl || hostOf(uri) === hostOf(prodUrl))) {
  throw new Error(
    "integration setup-env REFUSED: container url shares a host with the configured (production) ROUND_DB_URL.",
  );
}

process.env.ROUND_DB_URL = uri;
