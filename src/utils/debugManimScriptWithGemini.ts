import type { QuestionDetails } from "./getQuestionDetailsFromMCP.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Gemini AI Setup ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is not set in the environment variables.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

/**
 * Attempts to debug a failed Manim script using the Gemini AI model.
 *
 * @param context The original, detailed question context.
 * @param failedCode The Manim code that resulted in an error.
 * @param errorMessage The stderr/traceback from the failed Manim execution.
 * @returns An object with the corrected Manim code, the original class name, and a potentially revised description.
 */
const debugManimScriptWithGemini = async (
  context: QuestionDetails,
  failedCode: string,
  errorMessage: string
) => {
  console.log(`[Job] Calling Gemini to debug failed script...`);

  // --- PROMPT ENGINEERING: A prompt specifically for debugging ---
  const prompt = `
    You are an expert Manim developer specializing in debugging. Your task is to analyze a failed Manim script, identify the error based on the provided traceback, and provide a corrected version.

    You will receive the original context, the failed code, and the error message.
    Your output MUST be a single, valid JSON object with the keys "manimCode", "className", and "spokenDescription". Do not include any other text or markdown.

    **ORIGINAL CONTEXT (The goal of the video):**
    \`\`\`json
    ${JSON.stringify(context, null, 2)}
    \`\`\`

    **FAILED MANIM CODE:**
    \`\`\`python
    ${failedCode}
    \`\`\`

    **ERROR MESSAGE / TRACEBACK:**
    \`\`\`
    ${errorMessage}
    \`\`\`

    **YOUR TASK:**

    1.  **Analyze the Error:** Carefully read the error message and traceback to understand the root cause (e.g., syntax error, incorrect class name, missing import, wrong method call).
    2.  **Correct the Code:** Fix the error in the Python script. Do NOT change the core animation logic unless it's necessary to fix the error.
    3.  **Preserve the Class Name:** The corrected script must use the *same* Manim Scene class name as the failed code. This is critical.
    4.  **Review the Spoken Description:** Read the original description. If your code fix significantly changes the timing or visual flow of the animation, update the description to match. Otherwise, return the original description.
    5.  **Return in Strict JSON Format:** Provide your response in the format specified below.

    **OUTPUT FORMAT (Strictly adhere to this JSON structure):**
    \`\`\`json
    {
      "manimCode": "from manim import *\\n\\nclass OriginalSceneName(Scene):\\n    def construct(self):\\n        # ... your FIXED manim code here",
      "className": "OriginalSceneName",
      "spokenDescription": "The reviewed and potentially adjusted spoken description..."
    }
    \`\`\`
    `;

  try {
    const result = await geminiModel.generateContent(prompt);
    const responseText = result.response.text();

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        "Gemini debug response did not contain a valid JSON object."
      );
    }

    const jsonString = jsonMatch[0];
    const parsedResponse = JSON.parse(jsonString);

    if (
      !parsedResponse.manimCode ||
      !parsedResponse.className ||
      !parsedResponse.spokenDescription
    ) {
      throw new Error("Parsed JSON debug response is missing required keys.");
    }

    return {
      manimCode: parsedResponse.manimCode,
      className: parsedResponse.className,
      description: parsedResponse.spokenDescription,
    };
  } catch (error) {
    console.error(
      "[Job] Error calling or parsing Gemini API debug response:",
      error
    );
    throw new Error("Failed to get debugged script from Gemini.");
  }
};

export { debugManimScriptWithGemini };
