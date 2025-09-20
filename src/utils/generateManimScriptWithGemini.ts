import { GoogleGenerativeAI } from "@google/generative-ai";
import type { QuestionDetails } from "./getQuestionDetailsFromMCP.js";

// --- Gemini AI Setup ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is not set in the environment variables.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

/**
 * Generates a Manim script and a spoken description using the Gemini AI model.
 *
 * @param context The detailed question context from the database.
 * @returns An object containing the Manim code, the scene's class name, and the description.
 */
const generateManimScriptWithGemini = async (context: QuestionDetails) => {
  console.log(`[Job] Calling Gemini to generate script for question ID...`);

  const prompt = `
    You are a world-class Manim expert and a phenomenal educator. Your mission is to create a flawless, short, and crystal-clear video explanation for a given exam question. You will transform a JSON-based problem description into a complete, ready-to-use educational asset.

    You will receive a JSON object containing all the details of an exam question. Your output MUST be a single, valid JSON object, with no other text or markdown formatting before or after it. The output object will contain three keys: "manimCode", "className", and "spokenDescription".

    **INPUT CONTEXT:**
    \`\`\`json
    ${JSON.stringify(context, null, 2)}
    \`\`\`

    **YOUR TASK: A Step-by-Step Guide to Perfection**

    **1. Deep Analysis of the Input:**
    *   Thoroughly examine the entire input JSON. Understand the question's core concept, the provided solution's logic, the subject, topic, and difficulty.
    *   Internalize the step-by-step solution to form the narrative backbone of your explanation.

    **2. Architect the Visual Explanation (Pre-Coding Blueprint):**
    *   Before writing any code, storyboard the scene in your mind.
    *   **Scene Flow:** Plan the sequence:
        *   Start with a clear title and the question itself.
        *   Transition smoothly into the first step of the solution.
        *   Dedicate a clear visual segment for each subsequent step.
        *   Conclude with a final answer reveal and a quick summary slide.
    *   **Layout Management:** Plan where elements will appear on screen. Use Manim's layout tools like \`.to_edge()\`, \`.next_to()\`, and \`VGroup().arrange()\` to maintain a clean, organized, and professional look throughout the video.

    **3. Generate Flawless Manim Code:**
    *   Write a single, clean, and well-commented Python script using the **\`manimcommunity v0.18.0\`** library.
    *   The script must contain one, and only one, class that inherits from \`manim.Scene\`.
    *   **Avoid Visual Clutter:** This is critical. **Do not let animations and text overlap.** Actively manage the scene by fading out, transforming, or clearing previous steps before introducing new ones. For example, use \`self.play(FadeOut(step1_group), FadeIn(step2_title))\` to transition between steps.
    *   **Use Pedagogical Animations:**
        *   Employ simple, effective animations: \`Write\` or \`FadeIn\` for new concepts, \`TransformMatchingTex\` for evolving equations, and \`Transform\` for general changes.
        *   Use highlighting techniques like \`SurroundingRectangle\` or changing the \`color\` of a \`MathTex\` element to draw attention to crucial parts of the solution.
    *   **Ensure Perfect Pacing:** The explanation must be easy to follow. Add \`self.wait(n)\` calls (e.g., \`self.wait(1)\` or \`self.wait(2)\`) after each significant animation or piece of information is displayed. This gives the viewer a moment to absorb what they've seen before moving on.

    **4. Write a Professional Spoken Description:**
    *   Compose a concise, conversational, and encouraging script for a text-to-speech engine.
    *   **Crucial Requirement: Perfect Synchronization.** Every sentence or phrase in your description must directly correspond to an animation in your Manim code. Write the script as if you are narrating the \`self.play()\` calls in your \`construct\` method one by one.
    *   **Structure:**
        *   **Introduction:** Briefly introduce the problem. ("In this video, we'll tackle a problem about...")
        *   **Step-by-Step Narration:** Explain each step as it appears visually. ("First, we need to find the velocity. We do this by taking the derivative of the position vector...")
        *   **Conclusion:** State the final answer clearly and provide a brief recap of the method. ("And there we have it! The magnitude is... To recap, we simply...")

    **5. Final Output Assembly:**
    *   Package your work into a single JSON object.
    *   The \`manimCode\` key must contain the complete, runnable Python script as a single string.
    *   The \`className\` key must contain the name of the Manim Scene class you created.
    *   The \`spokenDescription\` key must contain the complete, synchronized narration script.

    **OUTPUT FORMAT (Strictly adhere to this JSON structure):**
    \`\`\`json
    {
      "manimCode": "from manim import *\\\\n\\\\nclass YourSceneName(Scene):\\\\n    def construct(self):\\\\n        # ... your clean, well-paced, and perfectly managed manim code here",
      "className": "YourSceneName",
      "spokenDescription": "In this video, we'll solve a problem about... First, let's look at the question. As you can see on the screen, the first step is to... Now that we have that, we'll move to the next step..."
    }
    \`\`\`
    `;

  try {
    const result = await geminiModel.generateContent(prompt);
    const responseText = result.response.text();

    // Find the JSON block within the response text to make parsing more robust
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Gemini response did not contain a valid JSON object.");
    }

    const jsonString = jsonMatch[0];
    const parsedResponse = JSON.parse(jsonString);

    if (
      !parsedResponse.manimCode ||
      !parsedResponse.className ||
      !parsedResponse.spokenDescription
    ) {
      throw new Error("Parsed JSON response is missing required keys.");
    }

    // Map the keys to match the worker's expectations
    return {
      manimCode: parsedResponse.manimCode,
      className: parsedResponse.className,
      description: parsedResponse.spokenDescription,
    };
  } catch (error) {
    console.error("[Job] Error calling or parsing Gemini API response:", error);
    // This error will be caught by the worker's retry loop
    throw new Error("Failed to generate script from Gemini.");
  }
};

export { generateManimScriptWithGemini };
