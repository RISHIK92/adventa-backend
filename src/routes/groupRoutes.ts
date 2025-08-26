import {
  getMyGroups,
  createGroup,
  getGroupInvitations,
  respondToInvitation,
  getPublicGroups,
  getQuickStats,
  getRecommendedGroups,
  joinPublicGroup,
  leaveGroup,
  deleteStudyRoom,
} from "../controllers/homeGroupController.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import router from "./authRoutes.js";

router.get("/my-groups", verifyFirebaseToken, getMyGroups);
router.post("/create-group", verifyFirebaseToken, createGroup);
router.get("/invitations", verifyFirebaseToken, getGroupInvitations);
router.post(
  "/invitations/:invitationId/respond",
  verifyFirebaseToken,
  respondToInvitation
);
router.get("/public", verifyFirebaseToken, getPublicGroups);
router.get("/quick-stats", verifyFirebaseToken, getQuickStats);
router.get("/recommendations", verifyFirebaseToken, getRecommendedGroups);
router.post("/:studyRoomId/join", verifyFirebaseToken, joinPublicGroup);
router.delete("/:studyRoomId/leave", verifyFirebaseToken, leaveGroup);
router.delete("/:studyRoomId/delete", verifyFirebaseToken, deleteStudyRoom);

export default router;
