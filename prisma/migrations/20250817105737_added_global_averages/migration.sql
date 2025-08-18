-- AlterTable
ALTER TABLE "public"."Subtopic" ADD COLUMN     "averageAccuracyPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE "public"."Topic" ADD COLUMN     "averageAccuracyPercent" DECIMAL(5,2) DEFAULT 0.00;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "overallAverageAccuracy" DECIMAL(5,2) DEFAULT 0.00;
