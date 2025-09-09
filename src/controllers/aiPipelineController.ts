import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Decimal } from "@prisma/client/runtime/library";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * ROUTE: GET /ai-pipelines/daily-plan/:examId
 * The core AI pipeline to generate a personalized "Plan for the Day" for a user.
 * Implements a "study -> practice" cycle and has the LLM select a topicId,
 * which the backend then enriches with the correct study link.
 */
const getDailyPlan = async (req: Request, res: Response) => {
  try {
    // --- PHASE 1: AUTHENTICATION, VALIDATION & CACHE CHECK ---
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
    startOfToday.setHours(0, 0, 0, 0);

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
      let responseData = existingRecommendation.recommendation as any;
      if (!responseData) {
        return res
          .status(404)
          .json({ success: false, error: "No recommendation found." });
      }
      if (
        !responseData.title ||
        !responseData.rationale ||
        !responseData.action
      ) {
        return res
          .status(500)
          .json({ success: false, error: "Corrupt recommendation data." });
      }

      // If it's a RECOMMEND_STUDY, always enrich with the latest studyLink from DB
      if (responseData.action?.type === "RECOMMEND_STUDY") {
        const selectedTopicId: number = Number(
          responseData.action.parameters.topicId
        );
        const topicDetail = await prisma.topic.findUnique({
          where: { id: selectedTopicId },
          select: { studyMaterialLink: true },
        });
        const studyLink = topicDetail?.studyMaterialLink ?? null;

        // Add/overwrite studyLink in both parameters and top-level
        responseData = {
          ...responseData,
          studyLink,
          recommendedId: existingRecommendation.id, // <-- Always add this
          action: {
            ...responseData.action,
            parameters: {
              ...responseData.action.parameters,
              studyLink,
            },
          },
        };
      } else {
        // For all other types, still add recommendedId
        responseData = {
          ...responseData,
          recommendedId: existingRecommendation.id,
        };
      }

      return res.status(200).json({
        success: true,
        data: responseData,
      });
    }

    // --- PHASE 2: DYNAMIC CONTEXT GATHERING ---
    const [
      subjectPerformances,
      allCompletedTests,
      mockTestCount,
      allTopicPerformances, // Get ALL topic performances, not just weakest
      allTopicsForExam,
      weeklyActivity,
      previousRecommendations,
      studyGroupMembership,
    ] = await Promise.all([
      prisma.userSubjectPerformance.findMany({
        where: { userId: uid, subject: { examId: numericExamId } },
        include: { subject: { select: { name: true } } },
      }),
      prisma.userTestInstanceSummary.findMany({
        where: {
          userId: uid,
          examId: numericExamId,
          completedAt: { not: null },
        },
        select: { numCorrect: true, numIncorrect: true },
      }),
      prisma.userTestInstanceSummary.count({
        where: {
          userId: uid,
          examId: numericExamId,
          testType: "mock",
          completedAt: { not: null },
        },
      }),
      // Get ALL topic performances with complete data
      prisma.userTopicPerformance.findMany({
        where: {
          userId: uid,
          topic: { subject: { examId: numericExamId } },
        },
        include: {
          topic: {
            select: {
              id: true,
              name: true,
              examWeightage: true,
              studyMaterialLink: true,
            },
          },
        },
        orderBy: { accuracyPercent: "asc" }, // Still order by accuracy for easy identification
      }),
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
        take: 5, // Get more previous recommendations for better context
      }),
      prisma.studyRoomMember.findFirst({ where: { userId: uid } }),
    ]);

    // --- PHASE 3: ON-THE-FLY PERFORMANCE CALCULATION & NEW USER CHECK ---
    if (allCompletedTests.length === 0) {
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
      await prisma.dailyRecommendation.create({
        data: {
          userId: uid,
          examId: numericExamId,
          recommendation: basicPlan,
        },
      });
      return res.status(200).json({ success: true, data: basicPlan });
    }

    const totalCorrect = allCompletedTests.reduce(
      (sum, test) => sum + test.numCorrect,
      0
    );
    const totalIncorrect = allCompletedTests.reduce(
      (sum, test) => sum + test.numIncorrect,
      0
    );
    const totalAttemptedOverall = totalCorrect + totalIncorrect;
    const overallAccuracyPercent =
      totalAttemptedOverall > 0
        ? new Decimal((totalCorrect / totalAttemptedOverall) * 100)
        : new Decimal(0);

    const isTopPerformer = overallAccuracyPercent.greaterThan(85);

    // Create comprehensive topic analysis
    const totalQuestionsPracticed = allTopicPerformances.reduce(
      (sum, p) => sum + p.totalAttempted,
      0
    );

    // Create a map for easy lookup
    const topicPerformanceMap = new Map(
      allTopicPerformances.map((p) => [p.topicId, p])
    );

    // Enhanced topic analysis with ALL topics
    const completeTopicAnalysis = allTopicsForExam.map((topic) => {
      const performance = topicPerformanceMap.get(topic.id);
      const examWeightage = parseFloat(topic.examWeightage as any);
      const userPracticeShare =
        totalQuestionsPracticed > 0
          ? ((performance?.totalAttempted || 0) / totalQuestionsPracticed) * 100
          : 0;

      return {
        topic_id: topic.id,
        topic_name: topic.name,
        exam_weightage: examWeightage,
        user_accuracy: performance
          ? parseFloat(performance.accuracyPercent.toString())
          : 0,
        questions_attempted: performance?.totalAttempted || 0,
        user_practice_share: userPracticeShare,
        is_conceptually_weak: performance
          ? performance.accuracyPercent.lessThan(50)
          : true,
        is_under_practiced:
          userPracticeShare < examWeightage * 0.5 && examWeightage > 2,
        has_study_material: !!topic.studyMaterialLink,
        priority_score: calculateTopicPriority(
          examWeightage,
          performance?.accuracyPercent || new Decimal(0),
          userPracticeShare
        ),
      };
    });

    // Sort by priority for LLM guidance
    completeTopicAnalysis.sort((a, b) => b.priority_score - a.priority_score);

    // --- PHASE 4: ENHANCED CONTEXT SYNTHESIS FOR LLM ---
    const userContext: any = {
      performance_summary: {
        overall_accuracy: `${overallAccuracyPercent.toFixed(2)}%`,
        proficiency_level: overallAccuracyPercent.greaterThan(75)
          ? "Advanced"
          : overallAccuracyPercent.greaterThan(50)
          ? "Intermediate"
          : "Beginner",
        is_top_performer: isTopPerformer,
        total_tests_completed: allCompletedTests.length,
        mock_tests_completed: mockTestCount,
      },
      subject_accuracies: subjectPerformances.map((p) => ({
        subject: p.subject.name,
        accuracy: `${p.accuracyPercent}%`,
      })),
      complete_topic_analysis: completeTopicAnalysis,
      topic_statistics: {
        total_topics: allTopicsForExam.length,
        topics_attempted: allTopicPerformances.length,
        topics_not_attempted:
          allTopicsForExam.length - allTopicPerformances.length,
        weakest_topics_count: completeTopicAnalysis.filter(
          (t) => t.user_accuracy < 50
        ).length,
        high_weightage_weak_topics: completeTopicAnalysis.filter(
          (t) => t.exam_weightage > 8 && t.user_accuracy < 60
        ).length,
        under_practiced_important_topics: completeTopicAnalysis.filter(
          (t) => t.is_under_practiced && t.exam_weightage > 5
        ).length,
      },
      past_week_activity: weeklyActivity.map(
        (a) => `${a.testType} test: "${a.testName}"`
      ),
      previous_recommendations: previousRecommendations.map((r, index) => ({
        recommendation: (r.recommendation as any).title,
        days_ago: index + 1,
        action_type: (r.recommendation as any).action?.type,
      })),
      social_context: {
        is_in_study_group: !!studyGroupMembership,
      },
    };

    // Enhanced follow-up context
    const lastRecommendation = previousRecommendations[0]
      ?.recommendation as any;
    if (
      lastRecommendation &&
      lastRecommendation.action?.type === "RECOMMEND_STUDY"
    ) {
      const studiedTopicId = lastRecommendation.action.parameters.topicId;
      const studiedTopicAnalysis = completeTopicAnalysis.find(
        (t) => t.topic_id === studiedTopicId
      );

      if (studiedTopicAnalysis) {
        userContext.follow_up_context = {
          action_required: "practice_studied_topic",
          studied_topic_id: studiedTopicId,
          studied_topic_name: studiedTopicAnalysis.topic_name,
          target_difficulty:
            studiedTopicAnalysis.user_accuracy < 60 ? "Medium" : "Hard",
          studied_topic_weightage: studiedTopicAnalysis.exam_weightage,
        };
      }
    }

    // Enhanced top performer analysis
    if (isTopPerformer) {
      const comparativelyWeakerTopics = completeTopicAnalysis
        .filter((t) => t.questions_attempted > 0)
        .sort((a, b) => a.user_accuracy - b.user_accuracy)
        .slice(0, 5);

      userContext.top_performer_details = {
        comparatively_weaker_topics: comparativelyWeakerTopics.map((t) => ({
          topic_id: t.topic_id,
          topic_name: t.topic_name,
        })),
        high_weightage_improvement_areas: completeTopicAnalysis
          .filter((t) => t.exam_weightage > 5 && t.user_accuracy < 90)
          .slice(0, 3),
      };
    }

    // --- PHASE 5: THE ENHANCED MASTER LLM PROMPT ---
    const llmPrompt = `
You are an expert AI academic coach. Your goal is to analyze a student's comprehensive performance data and generate a single, actionable, and prioritized 'Plan for the Day'.

**CRITICAL INSTRUCTION: You MUST select a specific topic_id from the complete_topic_analysis when recommending RECOMMEND_STUDY action. DO NOT make up topic IDs.**

**Student Context:**
${JSON.stringify(userContext, null, 2)}

**Available Actions (Choose ONLY ONE):**
- **RECOMMEND_STUDY:** Suggest studying a specific topic.
  - Parameters: { "topicId": [EXACT_ID_FROM_ANALYSIS], "contentName": "[EXACT_TOPIC_NAME]", "details": "Why this topic now" }

- **RECOMMEND_TEST:** Suggest a practice test. This is for AI-generated quizzes or drills.
  - Parameters: {
      "testType": "drill" | "quiz",
      "focus": "A short, user-facing string describing the test's purpose (e.g., 'Practice questions on Quantum Physics').",
      "topicIds": [Array of 1 to 4 numeric topic_ids from the analysis],
      "difficultyLevel": "Easy" | "Medium" | "Hard",
      "questionCount": [A number from 3 to 6],
      "timeLimitMinutes": [A number, e.g., 5, 10, or 15],
      "questionTypes": ["An array of strings, e.g., 'conceptual', 'theoretical', 'problem-solving']
    }

- **RECOMMEND_CHALLENGE:** For advanced users in study groups.
  - Parameters: { "details": "Challenge description with specific topic focus" }

- **RECOMMEND_JOIN_GROUP:** If user not in study group.
  - Parameters: { "details": "Benefits of joining for collaborative learning" }

**STRICT DECISION LOGIC (Follow this exact priority order):**

1.  **PRIORITY 1: FOLLOW-UP CYCLE (HIGHEST PRIORITY)**
    - IF 'follow_up_context' exists: You MUST choose 'RECOMMEND_TEST'.
    - Populate parameters as follows:
      - "testType": "drill"
      - "focus": \`Practice: \${userContext.follow_up_context.studied_topic_name}\`
      - "topicIds": [userContext.follow_up_context.studied_topic_id] (MUST be in an array)
      - "difficultyLevel": userContext.follow_up_context.target_difficulty
      - "questionCount": 5
      - "timeLimitMinutes": 10
      - "questionTypes": ["conceptual", "problem-solving"]
    - This overrides ALL other considerations.

2.  **PRIORITY 2: CRITICAL CONCEPTUAL GAPS**
    - IF Priority 1 not met AND any topic has user_accuracy < 50 AND exam_weightage > 8:
    - Choose 'RECOMMEND_STUDY' with the EXACT topic_id of the most critical topic.

3.  **PRIORITY 3: HIGH-WEIGHTAGE UNDER-PERFORMANCE**
    - IF Priorities 1&2 not met AND any topic has exam_weightage > 6 AND user_accuracy < 65:
    - Choose 'RECOMMEND_STUDY' with EXACT topic_id of highest priority_score topic.

4.  **PRIORITY 4: UNDER-PRACTICED IMPORTANT TOPICS**
    - IF Priorities 1-3 not met AND any topic has is_under_practiced = true AND exam_weightage > 5:
    - Choose 'RECOMMEND_STUDY' with EXACT topic_id.

5.  **PRIORITY 5: TOP PERFORMER CHALLENGE**
    - IF is_top_performer = true AND above priorities not met:
    - Choose 'RECOMMEND_TEST'.
    - Populate parameters as follows:
      - "testType": "quiz"
      - "focus": "Advanced quiz on weaker topics"
      - "topicIds": [An array of 1-3 topic_ids from top_performer_details.comparatively_weaker_topics]
      - "difficultyLevel": "Hard"
      - "questionCount": 6
      - "timeLimitMinutes": 10
      - "questionTypes": ["conceptual", "advanced"]
    - OR 'RECOMMEND_CHALLENGE' if is_in_study_group = true.

6.  **PRIORITY 6: GENERAL IMPROVEMENT**
    - If no other priority is met, choose 'RECOMMEND_STUDY' based on the topic with the highest priority_score.

**TOPIC SELECTION RULES (for RECOMMEND_STUDY):**
- ALWAYS use exact topic_id from complete_topic_analysis.
- ALWAYS use exact topic_name as provided.
- Prioritize topics with has_study_material = true.

**ANTI-REPETITION RULES:**
- DO NOT repeat exact recommendations from previous_recommendations.
- If last recommendation was RECOMMEND_STUDY, prefer RECOMMEND_TEST (as in Priority 1).

**Response Format (JSON ONLY):**
{
  "title": "Focused and specific title",
  "rationale": "Clear explanation of WHY this topic/action was selected based on data analysis",
  "action": {
    "type": "ACTION_TYPE",
    "parameters": {
      // Parameters must match the structures defined in "Available Actions"
    }
  }
}

**VALIDATION CHECKLIST:**
Before responding, verify:
- [ ] The chosen action strictly follows the PRIORITY LOGIC.
- [ ] For RECOMMEND_STUDY, the selected topic_id exists in complete_topic_analysis.
- [ ] For RECOMMEND_TEST, all required parameters (testType, focus, topicIds, difficultyLevel, questionCount, timeLimitMinutes, questionTypes) are included and correctly formatted.
- [ ] Rationale clearly explains the data-driven decision.

Respond with ONLY the JSON object, no additional text.`;

    // --- PHASE 6: EXECUTE LLM CALL ---
    const result = await model.generateContent(llmPrompt);
    const responseContent = result.response.text();
    if (!responseContent) throw new Error("Gemini returned an empty response.");

    const cleanedResponse = responseContent.trim().replace(/```json|```/g, "");
    let parsedPlan = JSON.parse(cleanedResponse);
    console.log("[AI Coach] Parsed LLM Plan:", parsedPlan);

    // Enhanced validation
    if (
      !parsedPlan.title ||
      !parsedPlan.rationale ||
      !parsedPlan.action?.type
    ) {
      throw new Error("LLM output is missing required fields.");
    }

    // Strict validation for RECOMMEND_TEST actions
    if (parsedPlan.action.type === "RECOMMEND_TEST") {
      const params = parsedPlan.action.parameters;
      if (
        !params.testType ||
        !params.focus || // <-- Added check for focus
        !Array.isArray(params.topicIds) ||
        params.topicIds.length === 0 ||
        !params.difficultyLevel ||
        !params.questionCount ||
        !params.timeLimitMinutes ||
        !Array.isArray(params.questionTypes)
      ) {
        console.error(
          "LLM generated an invalid RECOMMEND_TEST plan:",
          parsedPlan
        );
        // Fallback strategy: recommend studying the highest priority topic
        const fallbackTopic = completeTopicAnalysis[0];
        if (!fallbackTopic) {
          throw new Error(
            "No topics available for fallback RECOMMEND_STUDY action."
          );
        }
        parsedPlan = {
          title: `Let's Focus on ${fallbackTopic.topic_name}`,
          rationale: `We had trouble generating a specific quiz for you, so let's solidify your understanding in a key area. This topic is important based on its exam weightage and your current performance.`,
          action: {
            type: "RECOMMEND_STUDY",
            parameters: {
              topicId: fallbackTopic.topic_id,
              contentName: fallbackTopic.topic_name,
              details:
                "Focus on this high-priority topic to build a strong foundation.",
            },
          },
        };
      }
    }

    // Strict validation for RECOMMEND_STUDY actions
    if (parsedPlan.action.type === "RECOMMEND_STUDY") {
      const selectedTopicId = parsedPlan.action.parameters.topicId;
      const validTopic = completeTopicAnalysis.find(
        (t) => t.topic_id === selectedTopicId
      );

      if (!validTopic) {
        throw new Error(
          `LLM selected invalid topic_id: ${selectedTopicId}. Must be from complete_topic_analysis.`
        );
      }

      // Ensure parameters are correct
      parsedPlan.action.parameters.contentName = validTopic.topic_name;

      // Always add studyLink (string or null)
      const topicDetail = allTopicsForExam.find(
        (t) => t.id === selectedTopicId
      );
      parsedPlan.action.parameters.studyLink =
        topicDetail?.studyMaterialLink ?? null;
    }

    // --- PHASE 7: SAVE RECOMMENDATION AND RESPOND ---
    const recommendation = await prisma.dailyRecommendation.create({
      data: {
        userId: uid,
        examId: numericExamId,
        recommendation: parsedPlan,
      },
    });

    // Add top-level studyLink if RECOMMEND_STUDY
    let responseData = parsedPlan;
    if (parsedPlan.action?.type === "RECOMMEND_STUDY") {
      responseData = {
        ...parsedPlan,
        studyLink: parsedPlan.action.parameters.studyLink ?? null,
        recommendedId: recommendation.id,
        status: recommendation.status,
      };
    } else {
      responseData = {
        ...parsedPlan,
        recommendedId: recommendation.id,
        status: recommendation.status,
      };
    }

    res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Error generating daily plan:", error);
    res.status(500).json({
      success: false,
      error:
        "An internal server error occurred while generating your daily plan.",
    });
  }
};

// Helper function to calculate topic priority score
const calculateTopicPriority = (
  examWeightage: number,
  accuracyPercent: Decimal,
  userPracticeShare: number
): number => {
  const accuracy = parseFloat(accuracyPercent.toString());
  const weightage = examWeightage || 0;

  // Higher score = higher priority
  let score = 0;

  // Weightage contribution (0-40 points)
  score += Math.min(weightage * 4, 40);

  // Accuracy gap contribution (0-30 points) - lower accuracy = higher priority
  if (accuracy < 100) {
    score += Math.max(0, (100 - accuracy) * 0.3);
  }

  // Practice gap contribution (0-20 points)
  const expectedPracticeShare = weightage;
  if (userPracticeShare < expectedPracticeShare) {
    score += Math.min((expectedPracticeShare - userPracticeShare) * 2, 20);
  }

  // Critical weakness bonus (0-10 points)
  if (accuracy < 50 && weightage > 5) {
    score += 10;
  }

  return Math.round(score);
};

export { getDailyPlan };
