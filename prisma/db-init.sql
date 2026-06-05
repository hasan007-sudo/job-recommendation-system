-- Idempotent Postgres initialization for the job-centric search.
-- Run with: bunx prisma db execute --file prisma/db-init.sql --schema prisma/schema.prisma

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Fuzzy text matching (GIN trigram: `%` set-membership + similarity()).
CREATE INDEX IF NOT EXISTS job_title_trgm
  ON "Job" USING GIN ("jobTitle" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS job_skills_trgm
  ON "Job" USING GIN ("requiredSkills" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS company_name_trgm
  ON "Company" USING GIN (name gin_trgm_ops);

-- Semantic title match: HNSW cosine ANN over the 512-dim composite embedding.
CREATE INDEX IF NOT EXISTS job_embedding_hnsw
  ON "Job" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- DB-level dedup: one Job per (company, case-folded title). companyId lives on the row.
ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS dedup_key text
  GENERATED ALWAYS AS ("companyId" || '|' || lower(btrim("jobTitle"))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS job_dedup_key_uniq ON "Job" (dedup_key);
