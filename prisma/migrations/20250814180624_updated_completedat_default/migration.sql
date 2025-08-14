-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ALTER COLUMN "completedAt" DROP NOT NULL,
ALTER COLUMN "completedAt" DROP DEFAULT;
