-- Idempotent Postgres initialization for the rounds prototype.
-- Run with: bunx prisma db execute --file prisma/db-init.sql --schema prisma/schema.prisma

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Layer 3 (trigram) indexes
CREATE INDEX IF NOT EXISTS company_name_trgm
  ON "Company" USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS roleprofile_name_trgm
  ON "RoleProfile" USING GIN ("roleName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_name_trgm
  ON "Skill" USING GIN (name gin_trgm_ops);

-- Layer 4 (vector ANN) indexes. HNSW for cosine distance.
CREATE INDEX IF NOT EXISTS company_embedding_hnsw
  ON "Company" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS roleprofile_embedding_hnsw
  ON "RoleProfile" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS skill_embedding_hnsw
  ON "Skill" USING hnsw (embedding vector_cosine_ops);

-- Trigger that keeps InterviewPlan.cachedRoundCount in sync with InterviewRound.
CREATE OR REPLACE FUNCTION update_plan_round_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "InterviewPlan"
       SET "cachedRoundCount" = "cachedRoundCount" + 1
     WHERE id = NEW."planId";
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "InterviewPlan"
       SET "cachedRoundCount" = GREATEST("cachedRoundCount" - 1, 0)
     WHERE id = OLD."planId";
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS round_count_trigger ON "InterviewRound";
CREATE TRIGGER round_count_trigger
  AFTER INSERT OR DELETE ON "InterviewRound"
  FOR EACH ROW EXECUTE FUNCTION update_plan_round_count();
