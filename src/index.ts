import express from "express";
import authRouter from "./routes/authRoutes.js";
import weaknessRouter from "./routes/weaknessTestRoutes.js";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

app.use("/auth", authRouter);
app.use("/weakness", weaknessRouter);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
