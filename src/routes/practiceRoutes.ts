import {
  getMistakesByExam,
  getPyqsByTopicAndExam,
  getSubjectsWithTopicsByExam,
} from "../controllers/practiceController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { Router } from "express";

const router = Router();

router.get("/mistakes/:examId", verifyFirebaseToken, getMistakesByExam);
router.get(
  "/subjects/:examId",
  verifyFirebaseToken,
  getSubjectsWithTopicsByExam
);
router.get(
  "/topic-pyq/:examId/:topicId",
  verifyFirebaseToken,
  getPyqsByTopicAndExam
);

export default router;
