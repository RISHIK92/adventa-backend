-- AlterTable
ALTER TABLE "public"."UserTestInstanceSummary" ADD COLUMN     "examSessionId" INTEGER;

-- AddForeignKey
ALTER TABLE "public"."UserTestInstanceSummary" ADD CONSTRAINT "UserTestInstanceSummary_examSessionId_fkey" FOREIGN KEY ("examSessionId") REFERENCES "public"."ExamSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
