-- CreateTable
CREATE TABLE "public"."UserGroupStats" (
    "userId" TEXT NOT NULL,
    "studyRoomId" TEXT NOT NULL,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserGroupStats_pkey" PRIMARY KEY ("userId","studyRoomId")
);

-- AddForeignKey
ALTER TABLE "public"."UserGroupStats" ADD CONSTRAINT "UserGroupStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserGroupStats" ADD CONSTRAINT "UserGroupStats_studyRoomId_fkey" FOREIGN KEY ("studyRoomId") REFERENCES "public"."StudyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
