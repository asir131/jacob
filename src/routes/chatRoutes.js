const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const {
  getConversations,
  ensureConversationByOrder,
  getConversationMessages,
  sendMessage,
} = require("../controllers/chatController");

const router = express.Router();

router.get("/conversations", requireAuth, getConversations);
router.post("/conversations/order/:orderId", requireAuth, ensureConversationByOrder);
router.get("/conversations/:conversationId/messages", requireAuth, getConversationMessages);
router.post("/conversations/:conversationId/messages", requireAuth, sendMessage);

module.exports = router;
