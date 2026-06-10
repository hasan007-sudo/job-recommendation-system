-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";

-- CreateTable
CREATE TABLE "public"."Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Job" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "site" TEXT,
    "location" TEXT,
    "roleType" TEXT,
    "requiredSkills" TEXT,
    "roleSummary" TEXT,
    "keyResponsibilities" TEXT,
    "focusRoundPattern" TEXT NOT NULL,
    "focusRounds" TEXT,
    "experienceMinYears" INTEGER,
    "experienceMaxYears" INTEGER,
    "salaryInrMinPerYear" INTEGER,
    "salaryInrMaxPerYear" INTEGER,
    "embedding" vector(512),
    "sourceRowHash" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    -- DB-level dedup: one Job per (company, case-folded title).
    "dedup_key" TEXT GENERATED ALWAYS AS (("companyId" || '|'::text) || lower(btrim("jobTitle"))) STORED,
    "competencies" TEXT,
    "roleCategory" TEXT,
    "workMode" TEXT,
    "otherSkillsNotes" TEXT,
    "educationRequirement" TEXT,
    "sourceUrl" TEXT,
    "fullJobDescription" TEXT,
    "roundScreening" TEXT,
    "roundBehavioural" TEXT,
    "roundTechnical" TEXT,
    "roundCultureFit" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "public"."Company"("name" ASC);

-- CreateIndex
CREATE INDEX "Job_companyId_idx" ON "public"."Job"("companyId" ASC);

-- CreateIndex
CREATE INDEX "Job_experienceMinYears_experienceMaxYears_idx" ON "public"."Job"("experienceMinYears" ASC, "experienceMaxYears" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Job_sourceRowHash_key" ON "public"."Job"("sourceRowHash" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "job_dedup_key_uniq" ON "public"."Job"("dedup_key" ASC);

-- Semantic title match: HNSW cosine ANN over the 512-dim composite embedding.
CREATE INDEX "job_embedding_hnsw"
  ON "public"."Job" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Fuzzy text matching (GIN trigram: `%` set-membership + similarity()).
-- Prisma's diff engine ignores these; they are managed only in this migration.
CREATE INDEX "job_title_trgm" ON "public"."Job" USING GIN ("jobTitle" gin_trgm_ops);
CREATE INDEX "job_skills_trgm" ON "public"."Job" USING GIN ("requiredSkills" gin_trgm_ops);
CREATE INDEX "company_name_trgm" ON "public"."Company" USING GIN (name gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

