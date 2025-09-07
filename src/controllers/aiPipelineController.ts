import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

/**
 * ROUTE: GET /ai-pipelines/daily-plan/:examId
 * The core AI pipeline to generate a personalized "Plan for the Day" for a user.
 */
const getDailyPlan = async (req: Request, res: Response) => {
  try {
    // --- PHASE 1: AUTHENTICATION & CONTEXT GATHERING ---
    const { uid } = req.user;
    const { examId } = req.params;

    if (!examId) {
      return res
        .status(400)
        .json({ success: false, error: "Exam ID is required in the URL." });
    }
    const numericExamId = parseInt(examId, 10);

    if (isNaN(numericExamId)) {
      return res.status(400).json({
        success: false,
        error: "A valid numeric Exam ID is required.",
      });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0); // Set time to midnight at the beginning of the day

    const existingRecommendation = await prisma.dailyRecommendation.findFirst({
      where: {
        userId: uid,
        examId: numericExamId,
        createdAt: {
          gte: startOfToday,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingRecommendation) {
      console.log(
        `[AI Coach] Serving existing recommendation for user ${uid} for today.`
      );
      return res.status(200).json({
        success: true,
        data: existingRecommendation.recommendation,
      });
    }

    const [
      userSummary,
      weakestSubtopics,
      topicPerformances,
      allTopicsForExam,
      weeklyActivity,
      previousRecommendations,
      studyGroupMembership,
    ] = await Promise.all([
      prisma.userExamOverallSummary.findUnique({
        where: { userId_examId: { userId: uid, examId: numericExamId } },
      }),
      // Fetch weakest areas, now including the topic's study link
      prisma.userSubtopicPerformance.findMany({
        where: {
          userId: uid,
          subtopic: { topic: { subject: { examId: numericExamId } } },
        },
        orderBy: { accuracyPercent: "asc" },
        take: 5,
        include: {
          subtopic: {
            include: {
              topic: {
                select: { name: true, studyMaterialLink: true },
              },
            },
          },
        },
      }),
      prisma.userTopicPerformance.findMany({
        where: { userId: uid, topic: { subject: { examId: numericExamId } } },
      }),
      // Fetch all exam topics, including their study links
      prisma.topic.findMany({
        where: { subject: { examId: numericExamId } },
        select: {
          id: true,
          name: true,
          examWeightage: true,
          studyMaterialLink: true,
        },
      }),
      prisma.userTestInstanceSummary.findMany({
        where: {
          userId: uid,
          examId: numericExamId,
          completedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        select: { testName: true, testType: true, completedAt: true },
        orderBy: { completedAt: "desc" },
      }),
      prisma.dailyRecommendation.findMany({
        where: { userId: uid, examId: numericExamId },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
      prisma.studyRoomMember.findFirst({ where: { userId: uid } }),
    ]);

    // Handle new users: If no summary, they need to start with a diagnostic test.
    if (!userSummary || userSummary.totalMockTestsCompleted < 1) {
      const basicPlan = {
        title: "Start with a Diagnostic Test",
        rationale:
          "To create your personalized plan, we first need to understand your baseline strengths and weaknesses. Completing this diagnostic test is the first step.",
        action: {
          type: "RECOMMEND_TEST",
          parameters: {
            testType: "diagnostic",
            details:
              "Take the initial diagnostic test for your exam to unlock personalized coaching.",
          },
        },
      };
      return res.status(200).json({ success: true, data: basicPlan });
    }

    // --- PHASE 2: ENHANCED CONTEXT SYNTHESIS ---

    // Identify if the user is a "Top Performer"
    const isTopPerformer = userSummary.overallAccuracyPercent.greaterThan(85);

    // Calculate Lagging Topics
    const totalQuestionsPracticed = topicPerformances.reduce(
      (sum, p) => sum + p.totalAttempted,
      0
    );
    const userPracticeDistribution = new Map(
      topicPerformances.map((p) => [p.topicId, p.totalAttempted])
    );
    const laggingTopics = allTopicsForExam
      .filter((topic) => {
        const examShare = parseFloat(topic.examWeightage as any);
        const userPracticeShare =
          totalQuestionsPracticed > 0
            ? ((userPracticeDistribution.get(topic.id) || 0) /
                totalQuestionsPracticed) *
              100
            : 0;
        return userPracticeShare < examShare * 0.5 && examShare > 2;
      })
      .map((t) => t.name);

    // Format the base context for the LLM
    const userContext: any = {
      performance_summary: {
        overall_accuracy: `${userSummary.overallAccuracyPercent}%`,
        proficiency_level: userSummary.overallAccuracyPercent.greaterThan(75)
          ? "Advanced"
          : userSummary.overallAccuracyPercent.greaterThan(50)
          ? "Intermediate"
          : "Beginner",
        is_top_performer: isTopPerformer,
      },
      top_weaknesses: weakestSubtopics.map((p) => ({
        subtopic: p.subtopic.name,
        topic: p.subtopic.topic.name,
        accuracy: `${p.accuracyPercent}%`,
        study_link: p.subtopic.topic.studyMaterialLink || null, // Pass the link directly
        is_conceptually_weak: p.accuracyPercent.lessThan(50), // Flag for severe weakness
      })),
      lagging_topics: laggingTopics,
      past_week_activity: weeklyActivity.map(
        (a) => `${a.testType} test: "${a.testName}"`
      ),
      previous_recommendations: previousRecommendations.map(
        (r) => (r.recommendation as any).title
      ),
      social_context: {
        is_in_study_group: !!studyGroupMembership,
      },
    };

    // Add specialized context ONLY for top performers
    if (isTopPerformer) {
      const comparativelyWeakerTopics = [...topicPerformances]
        .sort((a, b) => a.accuracyPercent.comparedTo(b.accuracyPercent))
        .slice(0, 3)
        .map((p) => ({
          topic:
            allTopicsForExam.find((t) => t.id === p.topicId)?.name ||
            "Unknown Topic",
          accuracy: `${p.accuracyPercent}%`,
        }));

      const lowWeightageTopics = allTopicsForExam
        .filter((t) => parseFloat(t.examWeightage as any) < 3)
        .map((t) => t.name);

      userContext.top_performer_details = {
        comparatively_weaker_topics: comparativelyWeakerTopics,
        low_weightage_topics_for_coverage: lowWeightageTopics,
      };
    }

    // --- PHASE 3: ENHANCED LLM PROMPT ---

    const llmPrompt = `
      You are an expert AI academic coach. Your goal is to analyze a student's performance data and generate a single, actionable, and prioritized 'Plan for the Day'.

      **Student Context:**
      ${JSON.stringify(userContext, null, 2)}

      **Available Actions (Choose ONLY ONE):**
      - **RECOMMEND_STUDY:** Suggest studying a specific topic. Use this if the user is conceptually weak.
        - Parameters: { "contentType": "topic", "contentName": "The name of the topic", "details": "A descriptive string.", "studyLink": "The provided URL for the study material" }
      - **RECOMMEND_TEST:** Suggest a practice test. Use this for practice and reinforcement.
        - Parameters: { "testType": "drill" | "quiz" | "smart_mock" | "pyq", "details": "A descriptive string." }
      - **RECOMMEND_CHALLENGE:** For advanced users in a study group.
        - Parameters: { "details": "e.g., 'You're performing well. Challenge a peer to a quiz on Calculus to sharpen your skills.'" }
      - **RECOMMEND_JOIN_GROUP:** If the user is not in a study group.
        - Parameters: { "details": "e.g., 'Consider joining a study group to collaborate and compete with peers.'" }

      **Your Task and Decision Logic (Follow this order):**
      1.  **PRIORITY 1: ADDRESS CONCEPTUAL GAPS.** Look at the 'top_weaknesses' list. If any item has 'is_conceptually_weak' set to 'true' and a 'study_link' is available, your primary duty is to recommend the 'RECOMMEND_STUDY' action. A user cannot practice what they do not understand. Use the 'topic', 'details', and 'studyLink' from that weakness. This overrides all other recommendations.
      2.  **PRIORITY 2: CHALLENGE TOP PERFORMERS.** If the user is a 'top_performer' and has no conceptual gaps (Priority 1 was not met), follow the special instructions to assign them a hard drill or a challenge.
      3.  **PRIORITY 3: GENERAL RECOMMENDATION.** If neither of the above conditions is met, choose the most logical action for an intermediate user (e.g., a drill on a moderate weakness, a mock test, etc.).
      4.  Do not repeat recommendations from the 'previous_recommendations' list.
      5.  Respond with a single, valid JSON object in the specified format.

      **Special Instructions for Top Performers:**
      - If 'is_top_performer' is true, the user needs to be challenged, not just remediated.
      - **PRIORITY 1 (for them): Target Comparative Weaknesses.** The best action is likely a 'RECOMMEND_TEST' of type 'drill'. This drill should focus on their 'comparatively_weaker_topics' and be explicitly set to a 'Hard' or 'Elite' difficulty. Frame this as "perfecting" their skills.
      - **PRIORITY 2 (for them): Ensure Full Coverage.** If they have recently practiced their weaker topics, a great alternative is a 'drill' on 'low_weightage_topics_for_coverage'. This prevents surprises on the exam.

      **JSON Output Format:**
      {
        "title": "Your Plan for Today",
        "rationale": "A brief explanation of why this plan was chosen based on the user's context.",
        "action": {
          "type": "ACTION_TYPE_FROM_ABOVE",
          "parameters": { ... }
        }
      }

      Please respond with only the JSON object, no additional text.
    `;

    // --- PHASE 4: EXECUTE LLM CALL AND VALIDATE RESPONSE ---
    const result = await model.generateContent(llmPrompt);

    const responseContent = result.response.text();
    if (!responseContent) throw new Error("Gemini returned an empty response.");

    // Clean the response to ensure it's valid JSON
    const cleanedResponse = responseContent.trim().replace(/```json|```/g, "");
    const parsedPlan = JSON.parse(cleanedResponse);

    if (
      !parsedPlan.title ||
      !parsedPlan.rationale ||
      !parsedPlan.action?.type
    ) {
      throw new Error("LLM output is missing required fields.");
    }

    // --- PHASE 5: SAVE RECOMMENDATION AND RESPOND TO USER ---
    await prisma.dailyRecommendation.create({
      data: {
        userId: uid,
        examId: numericExamId,
        recommendation: parsedPlan, // Save the entire JSON object from the AI
      },
    });

    res.status(200).json({ success: true, data: parsedPlan });
  } catch (error) {
    console.error("Error generating daily plan:", error);
    res.status(500).json({
      success: false,
      error:
        "An internal server error occurred while generating your daily plan.",
    });
  }
};

export { getDailyPlan };
