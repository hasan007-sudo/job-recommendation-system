-- One-time migration: 384-dim (MiniLM) -> 512-dim (Bedrock Titan v2).
-- Run with: bunx prisma db execute --file prisma/migrate-embedding-512.sql --schema prisma/schema.prisma
-- Then re-embed all rows: bun run tsx scripts/reembed-jobs.ts
--
-- The vector dimension changes, so the old 384-dim values are invalid and the
-- HNSW index must be dropped before altering the column type.

DROP INDEX IF EXISTS job_embedding_hnsw;

-- Clear the now-incompatible 384-dim vectors (ALTER TYPE can't recast dimensions).
UPDATE "Job" SET embedding = NULL;

ALTER TABLE "Job" ALTER COLUMN embedding TYPE vector(512);

-- Recreate the HNSW cosine index (same params as db-init.sql).
CREATE INDEX IF NOT EXISTS job_embedding_hnsw
  ON "Job" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
