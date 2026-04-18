const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createSupportMessage,
  listSupportMessages,
  updateSupportMessageStatus,
} = require("../controllers/supportController");

const router = express.Router();

router.post("/", createSupportMessage);
router.get("/admin", requireAuth, requireAdmin, listSupportMessages);
router.patch("/admin/:id/status", requireAuth, requireAdmin, updateSupportMessageStatus);

module.exports = router;
