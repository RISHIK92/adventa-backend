// src/controllers/chatController.ts
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { getDatabaseSchema } from "../utils/schemaIntrospector.js";
import { genAI } from "../ai/sdk/geminiSDK.js";
import { parseIntelligentJson } from "../utils/jsonParser.js";

const prisma = new PrismaClient();

const geminiClassifier = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});
const geminiSQL = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});
const geminiCoach = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});
const geminiChat = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});

const COACH_PERSONA_PROMPT = `You are "Ace," an expert AI coach for students preparing for competitive exams. Your tone is always encouraging, analytical, and focused on helping the student improve. You never just state data; you interpret it and provide insights. When you identify a weakness, you frame it constructively and suggest a clear, actionable next step. When you see a strength, you celebrate it and suggest how to leverage it.`;

const getConversation = async (req: Request, res: Response) => {
  const { uid } = req.user;

  const limit = parseInt(req.query.limit as string) || 15;
  const cursor = req.query.cursor as string | undefined;

  try {
    const messages = await prisma.conversationMessage.findMany({
      where: { userId: uid },
      take: limit,
      ...(cursor && {
        skip: 1,
        cursor: {
          id: cursor,
        },
      }),
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });

    messages.reverse();
    const nextCursor = messages.length === limit ? messages[0]?.id : null;

    res.status(200).json({
      messages,
      nextCursor,
    });
  } catch (error: any) {
    console.error("Failed to retrieve conversation:", error);
    res.status(500).json({
      error: "An error occurred while retrieving the conversation.",
      details: error.message,
    });
  }
};

const handleChat = async (req: Request, res: Response) => {
  const { uid } = req.user;
  const { message } = req.body;

  if (!message || !uid) {
    return res.status(400).json({ error: "message and userId are required" });
  }

  try {
    const dbSchema = await getDatabaseSchema();
    const conversationHistory = await prisma.conversationMessage.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    conversationHistory.reverse();

    // --- Step 1: Enhanced Intent Classification ---
    const classificationPrompt = `
      ${COACH_PERSONA_PROMPT}

      You are categorizing a student's request. Based on the message, history, and the database schema, determine the intent.
      Respond with a valid JSON object. It MUST contain a key "intent". The possible values for "intent" are:
      1. "database_query": The student is asking for specific data (e.g., "My percentile in the last mock test", "Show my accuracy", "How many users are there?", "Total number of quizzes")
      2. "strategic_advice": The student is asking for a plan or advice based on performance (e.g., "What are my weakest topics?", "How should I prepare?", "Generate a study plan")
      3. "clarification_needed": The request is ambiguous (e.g., "How did I do?"). If you choose this, you MUST also include a key "missing_info" describing what you need
      4. "general_chat": Conversational messages (e.g., "hello", "thanks!", "motivate me")

      Database Schema: ${dbSchema}
      History: ${conversationHistory
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")}
      Student's message: "${message}"

      Important: If the question can be answered with data from the database schema, classify it as "database_query" even if it's about platform statistics like "total users" or "how many quizzes".

      Respond with JSON only, no other text.
    `;

    const classificationResult = await geminiClassifier.generateContent(
      classificationPrompt
    );
    const { intent, missing_info } = parseIntelligentJson(
      classificationResult.response.text()
    );

    console.log(`[Intent] Detected: ${intent}`);

    let finalAnswer: string;

    // --- Step 2: Routing based on Enhanced Intents ---
    if (intent === "database_query" || intent === "strategic_advice") {
      const sqlGenerationPrompt = `
        You are an expert PostgreSQL data analyst. Your task is to write a SINGLE SQL query to get the data needed to answer a student's question.
        
        CRITICAL RULES:
        - Write ONLY ONE SQL statement
        - Do NOT include semicolons in the query
        - Do NOT use multiple statements or CTEs unless absolutely necessary
        - Use double quotes for column names in PostgreSQL (e.g., "userId", "createdAt")
        - Return only valid PostgreSQL syntax
        
        Guidelines:
        - If the question is about "my" or "the user's" data, filter by userId: '${uid}'
        - If the question is about platform statistics (total users, all quizzes, etc.), don't filter by userId
        - For counting users, use: SELECT COUNT(DISTINCT "userId") as total_users FROM "User"
        - For counting records, use: SELECT COUNT(*) as total FROM "TableName"
        - Keep queries simple and efficient
        
        Schema: ${dbSchema}
        History: ${conversationHistory
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")}
        Student's Question: "${message}"
        Current User ID: ${uid}
        
        Respond with a JSON object with a single key "query" containing ONE SQL statement WITHOUT semicolons.
        
        Example response:
        {"query": "SELECT COUNT(*) as total FROM \\"User\\""}
      `;

      const generatedQuery = await getSQLFromLLM(sqlGenerationPrompt);
      console.log("Generated SQL Query:", generatedQuery);

      const queryResult: unknown = await prisma.$queryRawUnsafe(generatedQuery);

      if (typeof queryResult !== "object" || queryResult === null) {
        throw new Error("Database query returned an unexpected result.");
      }

      const serializableResult = JSON.parse(
        JSON.stringify(queryResult, (_, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      );

      // Analysis & Coaching Prompt
      const analysisPrompt = `
        ${COACH_PERSONA_PROMPT}

        A student asked: "${message}"
        We ran a query and got this data:
        ${JSON.stringify(serializableResult, null, 2)}

        Your task is to act as their personal coach, "Ace".
        1. Directly answer their question using the data in a clear, friendly way.
        2. If the data is about their personal performance, analyze it to find one key insight (a strength or weakness).
        3. If it's relevant to their learning journey, provide one piece of clear, actionable advice.
        4. If it's just platform statistics (like total users), present it in an encouraging, conversational way.

        Be conversational, encouraging, and concise. Don't just state numbers - interpret them and make them meaningful!

        Example for personal data:
        "Great question! Your overall accuracy in Algebra is 75%. That's a solid foundation! I noticed you're very accurate with linear equations but a bit slower on quadratic problems. For your next step, I recommend a 15-minute timed practice set focused just on quadratics to boost your speed. Ready to try?"

        Example for platform data:
        "We currently have 1,247 active students on the platform! You're part of a growing community of learners all working toward their goals. Keep up the great work!"
      `;
      const finalAnswerResult = await geminiCoach.generateContent(
        analysisPrompt
      );
      finalAnswer = finalAnswerResult.response.text();
    } else if (intent === "clarification_needed") {
      finalAnswer = `I can definitely help with that! To give you the best answer, could you please tell me ${
        missing_info || "more specific details"
      }?`;
    } else {
      // Default to "general_chat"
      const chatPrompt = `
        ${COACH_PERSONA_PROMPT}
        The student sent the following message. Provide a short, encouraging, and conversational response in character as "Ace".
        Student's message: "${message}"
      `;
      const chatResult = await geminiChat.generateContent(chatPrompt);
      finalAnswer = chatResult.response.text();
    }

    // --- Step 3: Store and Respond ---
    await prisma.$transaction([
      prisma.conversationMessage.create({
        data: { role: "user", content: message, userId: uid },
      }),
      prisma.conversationMessage.create({
        data: {
          role: "assistant",
          content: finalAnswer,
          userId: uid,
        },
      }),
    ]);

    res.status(200).json({ response: finalAnswer });
  } catch (error: any) {
    console.error("Chatbot processing failed:", error);
    res.status(500).json({
      error: "An error occurred while processing your request.",
      details: error.message,
    });
  }
};

async function getSQLFromLLM(prompt: string): Promise<string> {
  const result = await geminiSQL.generateContent(prompt);
  const responseText = result.response.text();
  console.log("Raw SQL generation response:", responseText);
  try {
    const parsedJson = parseIntelligentJson(responseText);
    const query = parsedJson.query;
    if (!query) {
      throw new Error("Parsed JSON from LLM does not contain a 'query' key.");
    }
    if (typeof query !== "string") {
      throw new Error("'query' key in LLM response is not a string.");
    }

    // Clean the query
    let cleanQuery = query.trim();

    // Remove any trailing semicolons
    cleanQuery = cleanQuery.replace(/;+\s*$/g, "");

    // Check for multiple statements (semicolons in the middle of the query)
    if (cleanQuery.includes(";")) {
      throw new Error(
        "SQL injection attempt detected: multiple statements separated by semicolons."
      );
    }

    // Additional security checks
    const dangerousKeywords = [
      "DROP",
      "DELETE",
      "TRUNCATE",
      "ALTER",
      "CREATE",
      "INSERT",
      "UPDATE",
      "GRANT",
      "REVOKE",
      "EXEC",
    ];
    const upperQuery = cleanQuery.toUpperCase();
    for (const keyword of dangerousKeywords) {
      if (upperQuery.includes(keyword)) {
        throw new Error(`Dangerous SQL operation detected: ${keyword}`);
      }
    }

    console.log("Cleaned SQL Query:", cleanQuery);
    return cleanQuery;
  } catch (e: any) {
    console.error("Failed to parse SQL JSON from LLM:", responseText);
    throw new Error(
      `The AI failed to generate valid SQL query JSON. Details: ${e.message}`
    );
  }
}

export { handleChat, getConversation };
