import { GoogleGenerativeAI } from "@google/generative-ai";
import type { QuestionDetails } from "./getQuestionDetailsFromMCP.js";

// --- Gemini AI Setup ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is not set in the environment variables.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

/**
 * Generates a Manim script and a spoken description using the Gemini AI model.
 *
 * @param context The detailed question context from the database.
 * @returns An object containing the Manim code, the scene's class name, and the description.
 */
const generateManimScriptWithGemini = async (context: QuestionDetails) => {
  console.log(`[Job] Calling Gemini to generate script for question ID...`);
  const prompt = `
    You are a master visual educator and a world-class Manim expert. Your mission is to create a deeply intuitive and visually engaging video that doesn't just present a solution, but truly explains the underlying concepts. Think of this as a premium educational video, not a quick text-to-video clip.

    You will receive a JSON object with question details. Your output MUST be a single, valid JSON object, with no other text or markdown formatting. The output object will have three keys: "manimCode", "className", and "spokenScript".

    **INPUT CONTEXT:**
    \`\`\`json
    ${JSON.stringify(context, null, 2)}
    \`\`\`

    **YOUR TASK: A Step-by-Step Guide**

    **1. Deeply Analyze and Storyboard a VISUAL Narrative:**
    *   Go beyond the text. How can you VISUALLY represent the problem? Can you use graphs, shapes, or number lines?
    *   Your goal is to "show, not just tell." Instead of displaying a wall of text, use Manim's animation capabilities to build the explanation step-by-step.
    *   The final video should be comprehensive and well-paced. Do not rush. Prioritize clarity and depth over brevity.

    **2. Generate Flawless Manim Code That Teaches Visually:**
    *   Write a single, clean Python script using the **\`manimcommunity v0.18.0\`** library, with one class inheriting from \`manim.Scene\`.
    *   **Embrace Visual Tools:**
        *   **Highlighting:** Use \`SurroundingRectangle\`, color changes (\`.set_color()\`), or \`Indicate()\` to draw the viewer's attention to the part of the equation you are discussing.
        *   **Relationships:** Use \`Arrow\` and \`Line\` to connect different parts of the problem and show relationships.
        *   **Transformation:** Use \`Transform\` to show an equation evolving from one step to the next. This is much more powerful than just fading elements in and out.
        *   **Illustration:** If a variable represents a real-world object, consider using simple shapes (\`Circle\`, \`Square\`) to represent it. If the problem involves functions, use \`Axes\` and \`plot\`.
    *   **Pacing for Comprehension:** Use frequent and generous \`self.wait(n)\` calls. A longer, well-explained video is better than a short, confusing one. Give the viewer time to absorb each visual step.

    **3. Generate a Descriptive Spoken Script:**
    *   The spoken script should narrate the VISUALS on screen. It's a voiceover, not just a transcript of on-screen text.
    *   **Example:** Instead of a script that says "Now we add 5 to both sides," a better script would be: *"To isolate X, we need to cancel out this minus five. Watch as we introduce a plus five on both sides of the equation to maintain the balance."* This directly references the animation the viewer is seeing.
    *   The script should be a single, cohesive string.

    **4. Final Output Assembly:**
    *   Package your work into a single JSON object.

    **OUTPUT FORMAT (Strictly adhere to this JSON structure, noting the more descriptive script and advanced code):**
    \`\`\`json
    {
      "manimCode": "from manim import *\\n\\nclass AdvancedLinearScene(Scene):\\n    def construct(self):\\n        # ... comprehensive, well-paced manim code ...\\n        equation = MathTex(\\\"2x - 5 = 11\\\").scale(1.5)\\n        self.play(Write(equation))\\n        self.wait(2)\\n\\n        # Highlight the '-5' term\\n        highlight_box = SurroundingRectangle(equation.get_part_by_tex(\\\"-5\\\"))\\n        self.play(Create(highlight_box))\\n        self.wait(1.5)\\n\\n        # Show adding 5 to both sides\\n        new_equation = MathTex(\\\"2x - 5 + 5 = 11 + 5\\\").scale(1.5)\\n        self.play(Transform(equation, new_equation), FadeOut(highlight_box))\\n        self.wait(3)",
      "className": "AdvancedLinearScene",
      "spokenScript": "We begin with the equation 2x minus 5 equals 11. Our goal is to solve for x. First, let's focus on this minus 5 term. To isolate the variable, we need to cancel it out by adding 5 to both sides of the equation. Watch how the equation transforms as we do this, resulting in 2x equals 16."
    }
    \`\`\`
    `;

  try {
    const result = await geminiModel.generateContent(prompt);
    const responseText = result.response.text();

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Gemini response did not contain a valid JSON object.");
    }

    const jsonString = jsonMatch[0];
    const parsedResponse = JSON.parse(jsonString);

    if (
      !parsedResponse.manimCode ||
      !parsedResponse.className ||
      !parsedResponse.spokenScript
    ) {
      throw new Error("Parsed JSON response is missing required keys.");
    }

    return {
      manimCode: parsedResponse.manimCode,
      className: parsedResponse.className,
      description: parsedResponse.spokenScript.trim(),
    };
  } catch (error) {
    console.error("[Job] Error calling or parsing Gemini API response:", error);
    throw new Error("Failed to generate script from Gemini.");
  }
};

export { generateManimScriptWithGemini };
