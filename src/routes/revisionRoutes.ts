import { Router } from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import {
  generateRevisionTest,
  getRevisionTestDataForTaking,
  submitRevisionTest,
  getRevisionTestResults,
  getRevisionTestDashboard,
} from "../controllers/revisionController.js";

const router = Router();

router.use(verifyFirebaseToken);

router.get("/dashboard/:examId", getRevisionTestDashboard);
router.post("/generate", generateRevisionTest);
router.get("/test-details/:testInstanceId", getRevisionTestDataForTaking);
router.post("/submit/:testInstanceId", submitRevisionTest);
router.get("/results/:testInstanceId", getRevisionTestResults);

export default router;
