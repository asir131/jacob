const express = require("express");
const optionalAuth = require("../middlewares/optionalAuth");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createSupportMessage,
  deleteSupportMessages,
  listSupportMessages,
  startSupportConversation,
  updateSupportMessageStatus,
} = require("../controllers/supportController");

const router = express.Router();

router.post("/", optionalAuth, createSupportMessage);
router.get("/admin", requireAuth, requireAdmin, listSupportMessages);
router.delete("/admin", requireAuth, requireAdmin, deleteSupportMessages);
router.post("/admin/:id/conversation", requireAuth, requireAdmin, startSupportConversation);
router.patch("/admin/:id/status", requireAuth, requireAdmin, updateSupportMessageStatus);

module.exports = router;
