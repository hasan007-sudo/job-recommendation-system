-- DropIndex
DROP INDEX "job_dedup_key_uniq";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "dedup_key";

