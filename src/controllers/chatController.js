const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Order = require("../models/Order");
const { emitToUser } = require("../socket");

const normalizeConversation = (conversation, currentUserId) => {
  if (!conversation) return null;
  const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
  const otherUser = participants.find((user) => String(user?._id || user) !== String(currentUserId));
  const order = conversation.orderId || null;
  return {
    id: conversation._id,
    orderId: order?._id || conversation.orderId || null,
    orderNumber: order?.orderNumber || "",
    orderName: order?.gigId?.title || "",
    packageTitle: order?.packageTitle || "",
    lastMessage: conversation.lastMessage || "",
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
    updatedAt: conversation.updatedAt,
    otherUser: {
      id: otherUser?._id || "",
      name: `${otherUser?.firstName || ""} ${otherUser?.lastName || ""}`.trim() || "User",
      email: otherUser?.email || "",
      avatar: otherUser?.avatar || "",
      role: otherUser?.role || "",
    },
  };
};

const normalizeMessage = (message) => ({
  id: message._id,
  conversationId: message.conversationId,
  orderId: message.orderId || null,
  senderId: message.senderId?._id || message.senderId,
  receiverId: message.receiverId?._id || message.receiverId,
  text: message.text || "",
  createdAt: message.createdAt,
  readAt: message.readAt || null,
});

const ensureConversationForOrder = async ({ orderId, clientId, providerId }) => {
  if (!orderId || !clientId || !providerId) return null;

  const order = await Order.findById(orderId).select("_id conversationId");
  if (!order) return null;

  if (order.conversationId) {
    const existing = await Conversation.findById(order.conversationId);
    if (existing) return existing;
  }

  let conversation = await Conversation.findOne({ orderId: order._id });
  if (!conversation) {
    conversation = await Conversation.create({
      orderId: order._id,
      participants: [clientId, providerId],
      lastMessage: "",
      lastMessageAt: null,
    });
  }

  if (!order.conversationId) {
    order.conversationId = conversation._id;
    await order.save({ validateBeforeSave: false });
  }

  return conversation;
};

const getConversations = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .populate("participants", "_id firstName lastName email avatar role")
      .populate({
        path: "orderId",
        select: "_id orderNumber gigId packageTitle",
        populate: { path: "gigId", select: "title" },
      })
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Conversations fetched successfully.",
      data: conversations.map((conversation) => normalizeConversation(conversation, req.user.id)),
    });
  } catch (error) {
    return next(error);
  }
};

const ensureConversationByOrder = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id." });
    }

    const order = await Order.findById(orderId)
      .populate("gigId", "title")
      .populate("clientId", "_id firstName lastName email avatar role")
      .populate("providerId", "_id firstName lastName email avatar role");

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const isParticipant =
      String(order.clientId?._id || order.clientId) === String(req.user.id) ||
      String(order.providerId?._id || order.providerId) === String(req.user.id) ||
      req.user.role === "superAdmin";

    if (!isParticipant) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const conversation = await ensureConversationForOrder({
      orderId: order._id,
      clientId: order.clientId?._id || order.clientId,
      providerId: order.providerId?._id || order.providerId,
    });

    const hydrated = await Conversation.findById(conversation._id)
      .populate("participants", "_id firstName lastName email avatar role")
      .populate({
        path: "orderId",
        select: "_id orderNumber gigId packageTitle",
        populate: { path: "gigId", select: "title" },
      })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Conversation prepared successfully.",
      data: normalizeConversation(hydrated, req.user.id),
    });
  } catch (error) {
    return next(error);
  }
};

const getConversationMessages = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const allowed = conversation.participants.some((id) => String(id) === String(req.user.id));
    if (!allowed && req.user.role !== "superAdmin") {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [messages, totalItems] = await Promise.all([
      Message.find({ conversationId })
        .populate("senderId", "_id firstName lastName avatar")
        .populate("receiverId", "_id firstName lastName avatar")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Message.countDocuments({ conversationId }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Messages fetched successfully.",
      data: {
        items: messages.reverse().map(normalizeMessage),
        pagination: {
          page,
          limit,
          totalItems,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

const sendMessage = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { conversationId } = req.params;
    const text = String(req.body.text || "").trim();
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }
    if (!text) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants orderId");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const participants = conversation.participants.map((id) => String(id));
    if (!participants.includes(String(req.user.id)) && req.user.role !== "superAdmin") {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const receiverId = participants.find((id) => id !== String(req.user.id));
    if (!receiverId) {
      return res.status(400).json({ success: false, message: "Receiver not found in conversation." });
    }

    const message = await Message.create({
      conversationId: conversation._id,
      orderId: conversation.orderId || null,
      senderId: req.user.id,
      receiverId,
      text,
    });

    conversation.lastMessage = text;
    conversation.lastMessageAt = new Date();
    await conversation.save({ validateBeforeSave: false });

    const hydrated = await Message.findById(message._id)
      .populate("senderId", "_id firstName lastName avatar")
      .populate("receiverId", "_id firstName lastName avatar")
      .lean();
    const normalized = normalizeMessage(hydrated);
    const senderName =
      `${hydrated?.senderId?.firstName || ""} ${hydrated?.senderId?.lastName || ""}`.trim() || "Someone";
    const messagePreview = text.length > 120 ? `${text.slice(0, 117)}...` : text;
    const orderId = conversation.orderId ? String(conversation.orderId) : "";
    const conversationIdStr = String(conversation._id);
    const targetPath = orderId
      ? `/messages?conversationId=${conversationIdStr}&orderId=${orderId}`
      : `/messages?conversationId=${conversationIdStr}`;

    emitToUser(String(receiverId), "chat:message:new", normalized);
    emitToUser(String(req.user.id), "chat:message:new", normalized);
    emitToUser(String(receiverId), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage: text,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage: text,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(receiverId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "message",
      title: `New message from ${senderName}`,
      description: messagePreview,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "chat_message",
        conversationId: conversationIdStr,
        orderId,
        senderId: String(req.user.id),
        targetPath,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Message sent successfully.",
      data: normalized,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  ensureConversationForOrder,
  getConversations,
  ensureConversationByOrder,
  getConversationMessages,
  sendMessage,
};
