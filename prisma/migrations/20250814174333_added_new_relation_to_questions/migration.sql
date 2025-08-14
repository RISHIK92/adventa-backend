-- CreateTable
CREATE TABLE "public"."TestInstanceQuestion" (
    "id" TEXT NOT NULL,
    "testInstanceId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "TestInstanceQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestInstanceQuestion_testInstanceId_idx" ON "public"."TestInstanceQuestion"("testInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "TestInstanceQuestion_testInstanceId_questionId_key" ON "public"."TestInstanceQuestion"("testInstanceId", "questionId");

-- AddForeignKey
ALTER TABLE "public"."TestInstanceQuestion" ADD CONSTRAINT "TestInstanceQuestion_testInstanceId_fkey" FOREIGN KEY ("testInstanceId") REFERENCES "public"."UserTestInstanceSummary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestInstanceQuestion" ADD CONSTRAINT "TestInstanceQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
