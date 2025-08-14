import { prisma } from "../services/db.js";
import questionsJson from "./questions.json" with { type: "json" };
import examDefaults from "./examDefaults.json" with { type: "json" };


async function getExamIdOrCreate(examName: string) {
  const matchKey = Object.keys(examDefaults).find((key) =>
    examName.toLowerCase().includes(key.toLowerCase())
  );

    const { durationInMinutes, totalQuestions } = examDefaults[(matchKey || "Default") as keyof typeof examDefaults];


  const exam = await prisma.exam.upsert({
    where: { name: examName },
    update: {},
    create: {
      name: examName,
      durationInMinutes,
      totalQuestions,
    },
  });

  console.log(`Ensured exam '${examName}' exists with ID: ${exam.id}`);
  return exam.id;
}

async function main() {
  console.log("📥 Starting import...");

  const questions = questionsJson as any[];


  for (const q of questions) {
    const examId = await getExamIdOrCreate(q.examname);
    const primarySubtopic = q.subtopics?.[0] || "Uncategorized";

    const subject = await prisma.subject.upsert({
      where: { examId_name: { examId, name: q.subject } },
      update: {},
      create: { examId, name: q.subject },
    });

    const topic = await prisma.topic.upsert({
      where: { subjectId_name: { subjectId: subject.id, name: q.topic } },
      update: {},
      create: { subjectId: subject.id, name: q.topic },
    });

    const subtopic = await prisma.subtopic.upsert({
      where: { topicId_name: { topicId: topic.id, name: primarySubtopic } },
      update: {},
      create: { topicId: topic.id, name: primarySubtopic },
    });

    await prisma.question.create({
      data: {
        subtopicId: subtopic.id,
        question: q.question,
        shortcut: q.shortcut || null,
        equations: q.equation || null,
        imageUrl: q.imageurl || null,
        imagesolurl: q.imagesolurl || null,
        options: q.options || null,
        correctOption: q.correct_option,
        solution: q.solution,
        examname: q.examname,
        humanDifficultyLevel: q.difficulty_level as any, // Ensure it matches enum
        questionType: q.question_type || [],
        averageTimeSec: q.avg_time_to_solve || null,
      },
    });

    console.log(`✅ Added: ${q.question.substring(0, 50)}...`);
  }

  console.log("🎉 Import completed!");
}

main()
  .catch((err) => {
    console.error("❌ Error importing questions:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
