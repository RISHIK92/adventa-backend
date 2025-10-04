import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { Router } from "express";
import {
  getConversation,
  handleChat,
} from "../controllers/aiTutorController.js";

const router = Router();

router.post("/chat", verifyFirebaseToken, handleChat);
router.get("/conversation", verifyFirebaseToken, getConversation);

export default router;
