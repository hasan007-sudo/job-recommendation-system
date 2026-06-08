-- Adds JobPostingsV2-sourced columns: core extras, original posting link, full JD,
-- and the fixed 4-round key-competency columns. Apply against ROUND_DB.
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "roleCategory" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "workMode" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "otherSkillsNotes" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "educationRequirement" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "sourceUrl" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "fullJobDescription" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "roundScreening" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "roundBehavioural" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "roundTechnical" text;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "roundCultureFit" text;
