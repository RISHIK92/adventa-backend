-- CreateTable
CREATE TABLE "public"."TestSubtopicSnapshot" (
    "id" TEXT NOT NULL,
    "testInstanceId" TEXT NOT NULL,
    "subtopicId" INTEGER NOT NULL,
    "accuracyPercentBefore" DECIMAL(5,2) NOT NULL,
    "totalAttemptedBefore" INTEGER NOT NULL,

    CONSTRAINT "TestSubtopicSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestSubtopicSnapshot_testInstanceId_subtopicId_key" ON "public"."TestSubtopicSnapshot"("testInstanceId", "subtopicId");

-- AddForeignKey
ALTER TABLE "public"."TestSubtopicSnapshot" ADD CONSTRAINT "TestSubtopicSnapshot_testInstanceId_fkey" FOREIGN KEY ("testInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestSubtopicSnapshot" ADD CONSTRAINT "TestSubtopicSnapshot_subtopicId_fkey" FOREIGN KEY ("subtopicId") REFERENCES "public"."Subtopic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
