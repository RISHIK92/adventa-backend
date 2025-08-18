import { Router } from "express";
import {
  getCustomQuizDashboard,
  getCustomQuizOptions,
  generateCustomQuiz,
  getCustomQuizDataForTaking,
  submitCustomQuiz,
  getCustomQuizResults,
} from "../controllers/quizController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.get("/dashboard/:examId", getCustomQuizDashboard);
router.get("/options/:examId", getCustomQuizOptions);
router.post("/generate", generateCustomQuiz);
router.get("/test/:testInstanceId", getCustomQuizDataForTaking);
router.post("/submit/:testInstanceId", submitCustomQuiz);
router.get("/results/:testInstanceId", getCustomQuizResults);

export default router;
