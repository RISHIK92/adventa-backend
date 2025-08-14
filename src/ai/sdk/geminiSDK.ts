import { GoogleGenerativeAI } from "@google/generative-ai";

process.env.GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyAenlxGWE96xDKqrlsP50YhFTZIJGo";

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
