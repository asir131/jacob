const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const {
  getConversations,
  ensureConversationByOrder,
  getConversationMessages,
  sendMessage,
  markConversationMessagesAsRead,
  markAllProviderMessagesAsRead,
  clearConversationHistory,
  blockConversationUser,
  unblockConversationUser,
} = require("../controllers/chatController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
});

router.get("/conversations", requireAuth, getConversations);
router.post("/conversations/order/:orderId", requireAuth, ensureConversationByOrder);
router.get("/conversations/:conversationId/messages", requireAuth, getConversationMessages);
router.post("/conversations/:conversationId/messages", requireAuth, upload.array("attachments", 4), sendMessage);
router.post("/conversations/:conversationId/read", requireAuth, markConversationMessagesAsRead);
router.delete("/conversations/:conversationId/messages", requireAuth, clearConversationHistory);
router.post("/conversations/:conversationId/block", requireAuth, blockConversationUser);
router.delete("/conversations/:conversationId/block", requireAuth, unblockConversationUser);
router.post("/conversations/read-all", requireAuth, markAllProviderMessagesAsRead);

module.exports = router;
