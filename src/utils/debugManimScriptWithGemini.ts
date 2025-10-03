import type { QuestionDetails } from "./getQuestionDetailsFromMCP.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Gemini AI Setup ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is not set in the environment variables.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/**
 * Attempts to debug a failed Manim script and regenerate its SRT subtitles.
 *
 * @param context The original, detailed question context.
 * @param failedCode The Manim code that resulted in an error.
 * @param errorMessage The stderr/traceback from the failed Manim execution.
 * @returns An object with the corrected Manim code, class name, and revised subtitles.
 */
export const debugManimScriptWithGemini = async (
  context: QuestionDetails,
  failedCode: string,
  errorMessage: string
) => {
  console.log(`[Job] Calling Gemini to debug failed script...`);

  const prompt = `
    You are an expert Manim developer specializing in debugging. Your task is to analyze a failed Manim script, identify the error based on the provided traceback, provide a corrected version of the code, and generate a new set of synchronized SRT subtitles for the corrected code.

    You will receive the original context, the failed code, and the error message.
    Your output MUST be a single, valid JSON object with the keys "manimCode", "className", and "subtitlesSRT". Do not include any other text or markdown.

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
    2.  **Correct the Code:** Fix the error in the Python script using \`manimcommunity v0.18.0\`. Do NOT change the core animation logic unless the error requires it. Ensure the pacing (\`self.wait()\`) is still logical.
    3.  **Preserve the Class Name:** The corrected script must use the *same* Manim Scene class name as the failed code. This is critical.
    4.  **Regenerate SRT Subtitles:** Based on the timing of your **FIXED** Manim code, generate a new, perfectly synchronized set of subtitles in the SRT format. The format must be: Index, Timestamp (HH:MM:SS,ms --> HH:MM:SS,ms), Text, and a blank line.
    5.  **Return in Strict JSON Format:** Provide your response in the format specified below.

    **OUTPUT FORMAT (Strictly adhere to this JSON structure):**
    \`\`\`json
    {
      "manimCode": "from manim import *\\n\\nclass OriginalSceneName(Scene):\\n    def construct(self):\\n        # ... your FIXED manim code here",
      "className": "OriginalSceneName",
      "subtitlesSRT": "1\\n00:00:00,000 --> 00:00:03,500\\nThis is the corrected subtitle for the first part of the fixed animation.\\n\\n2\\n00:00:03,500 --> 00:00:08,000\\nThis second subtitle now correctly matches the new timing."
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
      !parsedResponse.subtitlesSRT
    ) {
      throw new Error(
        "Parsed JSON debug response is missing required keys: manimCode, className, subtitlesSRT."
      );
    }

    const createDescriptionFromSRT = (srt: string) => {
      return srt
        .replace(
          /(\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n)/g,
          ""
        )
        .replace(/\n\n/g, " ")
        .trim();
    };

    return {
      manimCode: parsedResponse.manimCode,
      className: parsedResponse.className,
      subtitlesSRT: parsedResponse.subtitlesSRT,
      description: createDescriptionFromSRT(parsedResponse.subtitlesSRT),
    };
  } catch (error) {
    console.error(
      "[Job] Error calling or parsing Gemini API debug response:",
      error
    );
    throw new Error("Failed to get debugged script from Gemini.");
  }
};
