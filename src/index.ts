import express from "express";
import authRouter from "./routes/authRoutes.js";
import weaknessRouter from "./routes/weaknessTestRoutes.js";
import progressRouter from "./routes/progressRoute.js";
import quizRouter from "./routes/quizRoutes.js";
import pyqRouter from "./routes/pyqRoutes.js";
import practiceRouter from "./routes/practiceRoutes.js";
import groupRouter from "./routes/groupRoutes.js";
import aiPipelineRouter from "./routes/aiPipelineRoutes.js";
import drillRouter from "./routes/drillRoutes.js";
import userDataRouter from "./routes/userDataRoutes.js";
import aiScheduleRouter from "./routes/aiScheduleRoutes.js";
import videoRouter from "./routes/videoRoutes.js";
import cors from "cors";
import { YouTubeUploadService } from "./services/youtubeUpload.js";

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.json());

const youtubeService = new YouTubeUploadService();

// Route 1: To start the authentication
app.get("/auth/youtube", (req, res) => {
  const authUrl = youtubeService.getAuthUrl();
  console.log("Redirecting to YouTube for authentication...");
  res.redirect(authUrl);
});

// Route 2: The callback that Google will redirect to
app.get("/auth/youtube/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code not found.");
  }
  try {
    const tokens = await youtubeService.getTokensFromCode(code as string);
    console.log("SUCCESS! You can now use these tokens in your .env file.");
    console.log("--- REFRESH TOKEN (VERY IMPORTANT, STORE SECURELY) ---");
    console.log(tokens.refresh_token);
    console.log("----------------------------------------------------");
    console.log("--- ACCESS TOKEN (SHORT-LIVED) ---");
    console.log(tokens.access_token);
    console.log("----------------------------------");
    res.send(
      "Authentication successful! Check your server console for the refresh token."
    );
  } catch (error) {
    console.error("Failed to get tokens:", error);
    res.status(500).send("Failed to get tokens.");
  }
});

app.use("/auth", authRouter);
app.use("/weakness", weaknessRouter);
app.use("/test", progressRouter);
app.use("/pyq", pyqRouter);
app.use("/custom-quiz", quizRouter);
app.use("/practice", practiceRouter);
app.use("/study-group", groupRouter);
app.use("/ai-pipelines", aiPipelineRouter);
app.use("/drill", drillRouter);
app.use("/user", userDataRouter);
app.use("/schedule", aiScheduleRouter);
app.use("/video", videoRouter);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
