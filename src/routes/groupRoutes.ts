import {
  acceptChallenge,
  createChallenge,
  getChallengeOptions,
  getChallenges,
  getChallengeTestDetails,
  startChallenge,
} from "../controllers/challengeGroupController.js";
import {
  createScheduledGroupTest,
  getGroupMembers,
  getGroupMembersForSelection,
  getGroupMockTestResults,
  getGroupTestInstanceDetails,
  getScheduledGroupTests,
  startGroupTest,
  submitScheduledTest,
} from "../controllers/groupController.js";
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

router.get("/:studyRoomId/members", verifyFirebaseToken, getGroupMembers);

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

router.get(
  "/:studyRoomId/members-for-selection",
  verifyFirebaseToken,
  getGroupMembersForSelection
);

router.post(
  "/:studyRoomId/schedule-test",
  verifyFirebaseToken,
  createScheduledGroupTest
);

router.get(
  `/start-group-test/:scheduledTestId`,
  verifyFirebaseToken,
  startGroupTest
);

router.get(
  "/:studyRoomId/scheduled-tests",
  verifyFirebaseToken,
  getScheduledGroupTests
);

router.get(
  `/scheduled-group-test/:testInstanceId`,
  verifyFirebaseToken,
  getGroupTestInstanceDetails
);

router.post(
  `/scheduled-group-test/:testInstanceId/submit`,
  verifyFirebaseToken,
  submitScheduledTest
);

router.get(
  `/group-test-results/:scheduledTestId`,
  verifyFirebaseToken,
  getGroupMockTestResults
);

router.get(
  `/challenge-options/:studyRoomId`,
  verifyFirebaseToken,
  getChallengeOptions
);

router.get(`/challenges/:studyRoomId`, verifyFirebaseToken, getChallenges);

router.post("/:studyRoomId/challenge", verifyFirebaseToken, createChallenge);

router.post(
  "/challenges/:challengeId/accept",
  verifyFirebaseToken,
  acceptChallenge
);

router.post(
  "/challenges/:challengeId/start",
  verifyFirebaseToken,
  startChallenge
);

router.get(
  "/challenge-instance/:testInstanceId",
  verifyFirebaseToken,
  getChallengeTestDetails
);

export default router;
