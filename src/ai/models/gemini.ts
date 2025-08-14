import { genAI } from "../sdk/geminiSDK.js";

export const geminiApi = async (systemPrompt: string, userPrompt: string) => {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const prompt = `${systemPrompt}\n\nUser: ${userPrompt}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 750,
    },
  });

  return result.response.text();
};
