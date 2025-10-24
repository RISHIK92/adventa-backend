import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  generateRevisionTest,
  getRevisionTestDataForTaking,
  submitRevisionTest,
  getRevisionTestResults,
} from "../controllers/revisionController.js";

const router = Router();

router.use(verifyFirebaseToken);

router.post("/generate", generateRevisionTest);
router.get("/test/:testInstanceId", getRevisionTestDataForTaking);
router.post("/submit/:testInstanceId", submitRevisionTest);
router.get("/results/:testInstanceId", getRevisionTestResults);

export default router;
