const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const {
  getConversations,
  ensureConversationByOrder,
  startProviderConversation,
  startCustomOrderConversation,
  startRepeatOrderConversation,
  getConversationMessages,
  sendMessage,
  createCustomOrderProposal,
  respondToCustomOrderProposal,
  markConversationMessagesAsRead,
  markAllProviderMessagesAsRead,
  clearConversationHistory,
  deleteConversationsFromInbox,
  blockConversationUser,
  unblockConversationUser,
} = require("../controllers/chatController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
});

router.get("/conversations", requireAuth, getConversations);
router.post("/conversations/order/:orderId", requireAuth, ensureConversationByOrder);
router.post("/conversations/provider/start", requireAuth, startProviderConversation);
router.post("/conversations/custom-order/start", requireAuth, startCustomOrderConversation);
router.post("/conversations/repeat-order/start", requireAuth, startRepeatOrderConversation);
router.get("/conversations/:conversationId/messages", requireAuth, getConversationMessages);
router.post("/conversations/:conversationId/messages", requireAuth, upload.array("attachments", 4), sendMessage);
router.post("/conversations/:conversationId/custom-order-proposals", requireAuth, createCustomOrderProposal);
router.patch("/custom-order-proposals/:proposalId/respond", requireAuth, respondToCustomOrderProposal);
router.post("/conversations/:conversationId/read", requireAuth, markConversationMessagesAsRead);
router.delete("/conversations", requireAuth, deleteConversationsFromInbox);
router.delete("/conversations/:conversationId/messages", requireAuth, clearConversationHistory);
router.post("/conversations/:conversationId/block", requireAuth, blockConversationUser);
router.delete("/conversations/:conversationId/block", requireAuth, unblockConversationUser);
router.post("/conversations/read-all", requireAuth, markAllProviderMessagesAsRead);

module.exports = router;
