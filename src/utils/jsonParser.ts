/**
 * A robust JSON parser that cleans and extracts a JSON object from a string
 * that might be wrapped in Markdown code blocks like ```json or backticks.
 *
 * @param text The raw text response from the LLM.
 * @returns The parsed JavaScript object.
 * @throws An error if no valid JSON object can be found or parsed.
 */
export function parseIntelligentJson(text: string): any {
  let cleanText = text.trim();

  cleanText = cleanText.replace(/^```(?:json|JSON)?\s*\n?/m, "");
  cleanText = cleanText.replace(/\n?```\s*$/m, "");
  cleanText = cleanText.trim();

  const firstBrace = cleanText.indexOf("{");
  const lastBrace = cleanText.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("No valid JSON object found in the LLM response.");
  }

  cleanText = cleanText.substring(firstBrace, lastBrace + 1);

  // 3. Attempt to parse the extracted string.
  try {
    return JSON.parse(cleanText);
  } catch (error) {
    console.error(
      "Final JSON parsing attempt failed for cleaned text:",
      cleanText
    );
    // Re-throw the original parsing error with more context.
    throw new Error(
      `Failed to parse cleaned JSON. Details: ${(error as Error).message}`
    );
  }
}
