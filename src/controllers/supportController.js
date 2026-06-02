const mongoose = require("mongoose");
const SupportMessage = require("../models/SupportMessage");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const { emitToRole, emitToUser } = require("../socket");

const normalizeSupportMessage = (item) => ({
  id: String(item._id),
  fullName: item.fullName || "",
  email: item.email || "",
  subject: item.subject || "",
  message: item.message || "",
  status: item.status || "pending",
  userId: item.userId?._id ? String(item.userId._id) : item.userId ? String(item.userId) : "",
  conversationId: item.conversationId ? String(item.conversationId) : "",
  user: item.userId?._id
    ? {
        id: String(item.userId._id),
        firstName: item.userId.firstName || "",
        lastName: item.userId.lastName || "",
        name: `${item.userId.firstName || ""} ${item.userId.lastName || ""}`.trim() || item.fullName || "User",
        email: item.userId.email || item.email || "",
        role: item.userId.role || "",
        avatar: item.userId.avatar || "",
      }
    : null,
  createdAt: item.createdAt || null,
  updatedAt: item.updatedAt || null,
  resolvedAt: item.resolvedAt || null,
});

const normalizeConversation = (conversation, currentUserId) => {
  const participants = Array.isArray(conversation?.participants) ? conversation.participants : [];
  const otherUser = participants.find((user) => String(user?._id || user) !== String(currentUserId));

  return {
    id: String(conversation._id),
    blockedBy: conversation.blockedBy || null,
    lastMessage: conversation.lastMessage || "",
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
    otherUser: {
      id: otherUser?._id ? String(otherUser._id) : "",
      name: `${otherUser?.firstName || ""} ${otherUser?.lastName || ""}`.trim() || "User",
      email: otherUser?.email || "",
      avatar: otherUser?.avatar || "",
      role: otherUser?.role || "",
    },
  };
};

const normalizeChatMessage = (message) => ({
  id: String(message._id),
  conversationId: String(message.conversationId),
  orderId: message.orderId || null,
  senderId: message.senderId?._id ? String(message.senderId._id) : String(message.senderId || ""),
  receiverId: message.receiverId?._id ? String(message.receiverId._id) : String(message.receiverId || ""),
  text: message.text || "",
  messageType: message.messageType || "text",
  attachments: Array.isArray(message.attachments) ? message.attachments : [],
  createdAt: message.createdAt,
  readAt: message.readAt || null,
});

const emitConversationUpdated = (userId, conversation, lastMessage = "") => {
  if (!userId || !conversation?._id) return;
  emitToUser(String(userId), "chat:conversation:updated", {
    conversationId: String(conversation._id),
    lastMessage: lastMessage || conversation.lastMessage || "",
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || new Date(),
    blockedBy: conversation.blockedBy || null,
  });
};

const hydrateConversation = (conversationId) =>
  Conversation.findById(conversationId)
    .populate("participants", "_id firstName lastName email avatar role")
    .select("_id participants blockedBy lastMessage lastMessageAt updatedAt createdAt")
    .lean();

const createSupportMessage = async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();

    if (!fullName || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Full name, email, subject, and message are required.",
      });
    }

    const matchedUser = await User.findOne({ email }).select("_id").lean();
    const supportMessage = await SupportMessage.create({
      fullName,
      email,
      subject,
      message,
      userId: req.user?.id || matchedUser?._id || null,
    });

    emitToRole("superAdmin", "notification:new", {
      id: `SUP-${Date.now()}`,
      type: "system",
      title: "New support message",
      description: `${fullName} sent a support request: ${subject}`,
      data: {
        notificationType: "support_message",
        providerName: fullName,
        categoryName: "Support",
        targetPath: "/support",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Support message sent successfully.",
      data: normalizeSupportMessage(supportMessage),
    });
  } catch (error) {
    return next(error);
  }
};

const listSupportMessages = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 15));
    const skip = (page - 1) * limit;

    const [items, totalItems] = await Promise.all([
      SupportMessage.find({})
        .populate("userId", "_id firstName lastName email avatar role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportMessage.countDocuments({}),
    ]);
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Support messages fetched successfully.",
      data: {
        items: items.map(normalizeSupportMessage),
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

const startSupportConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid support message id.",
      });
    }

    const supportMessage = await SupportMessage.findById(id);
    if (!supportMessage) {
      return res.status(404).json({
        success: false,
        message: "Support message not found.",
      });
    }

    const supportUser =
      (supportMessage.userId && (await User.findById(supportMessage.userId).select("_id firstName lastName email avatar role"))) ||
      (await User.findOne({ email: supportMessage.email }).select("_id firstName lastName email avatar role"));

    if (!supportUser) {
      return res.status(404).json({
        success: false,
        message: "No platform account found for this support email.",
      });
    }

    if (!supportMessage.userId) {
      supportMessage.userId = supportUser._id;
    }

    const adminId = req.user.id;
    let conversation = supportMessage.conversationId
      ? await Conversation.findById(supportMessage.conversationId)
      : null;
    const conversationParticipantIds = Array.isArray(conversation?.participants)
      ? conversation.participants.map((participantId) => String(participantId))
      : [];

    if (
      conversation &&
      (!conversationParticipantIds.includes(String(adminId)) ||
        !conversationParticipantIds.includes(String(supportUser._id)))
    ) {
      conversation = null;
      supportMessage.conversationId = null;
    }

    if (!conversation) {
      conversation = await Conversation.findOne({
        orderId: null,
        serviceRequestId: null,
        participants: { $all: [adminId, supportUser._id] },
        $expr: { $eq: [{ $size: "$participants" }, 2] },
      });
    }

    if (!conversation) {
      conversation = await Conversation.create({
        orderId: null,
        gigId: null,
        serviceRequestId: null,
        participants: [adminId, supportUser._id],
        blockedBy: null,
        lastMessage: "",
        lastMessageAt: null,
      });

      emitToUser(String(supportUser._id), "chat:created", {
        conversationId: String(conversation._id),
      });
      emitToUser(String(adminId), "chat:created", {
        conversationId: String(conversation._id),
      });
    }

    let createdTicketMessage = null;
    if (!supportMessage.conversationId) {
      const ticketText = [
        `Support ticket: ${supportMessage.subject}`,
        supportMessage.message,
      ]
        .filter(Boolean)
        .join("\n\n");

      const existingTicketMessage = await Message.findOne({
        conversationId: conversation._id,
        text: ticketText,
        messageType: "system",
      }).select("_id");

      if (!existingTicketMessage) {
        createdTicketMessage = await Message.create({
          conversationId: conversation._id,
          orderId: null,
          senderId: adminId,
          receiverId: supportUser._id,
          text: ticketText,
          messageType: "system",
        });

        conversation.lastMessage = `Support ticket: ${supportMessage.subject}`;
        conversation.lastMessageAt = new Date();
        await conversation.save({ validateBeforeSave: false });
      }

      conversation.deletedFor = (conversation.deletedFor || []).filter(
        (id) => ![String(adminId), String(supportUser._id)].includes(String(id))
      );
      await conversation.save({ validateBeforeSave: false });
      supportMessage.conversationId = conversation._id;
    }

    await supportMessage.save({ validateBeforeSave: false });

    if (createdTicketMessage) {
      const normalizedTicketMessage = normalizeChatMessage(createdTicketMessage);
      const conversationIdStr = String(conversation._id);
      emitToUser(String(supportUser._id), "chat:message:new", normalizedTicketMessage);
      emitToUser(String(adminId), "chat:message:new", normalizedTicketMessage);
      emitToUser(String(supportUser._id), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "message",
        title: "Support opened your ticket",
        description: supportMessage.subject || "The admin team opened a support conversation.",
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "chat_message",
          conversationId: conversationIdStr,
          senderId: String(adminId),
          targetPath: `/messages?conversationId=${conversationIdStr}`,
        },
      });
    }
    emitConversationUpdated(String(supportUser._id), conversation, conversation.lastMessage);
    emitConversationUpdated(String(adminId), conversation, conversation.lastMessage);

    const [hydratedConversation, messages] = await Promise.all([
      hydrateConversation(conversation._id),
      Message.find({ conversationId: conversation._id, hiddenFor: { $ne: adminId } })
        .populate("senderId", "_id firstName lastName avatar role")
        .populate("receiverId", "_id firstName lastName avatar role")
        .sort({ createdAt: 1 })
        .limit(100)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      message: "Support conversation prepared successfully.",
      data: {
        supportMessage: normalizeSupportMessage({
          ...supportMessage.toObject(),
          userId: supportUser,
        }),
        conversation: normalizeConversation(hydratedConversation, adminId),
        messages: messages.map(normalizeChatMessage),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const updateSupportMessageStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const nextStatus = String(req.body.status || "").trim().toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid support message id.",
      });
    }

    if (!["solved", "ignored"].includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: "Valid status is required.",
      });
    }

    const item = await SupportMessage.findById(id);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Support message not found.",
      });
    }

    item.status = nextStatus;
    item.resolvedBy = req.user?.id || null;
    item.resolvedAt = new Date();
    await item.save();

    return res.status(200).json({
      success: true,
      message: "Support message updated successfully.",
      data: normalizeSupportMessage(item),
    });
  } catch (error) {
    return next(error);
  }
};

const deleteSupportMessages = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const uniqueIds = Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
    const invalidIds = uniqueIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));

    if (uniqueIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one support message to delete.",
      });
    }

    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "One or more support message ids are invalid.",
      });
    }

    const result = await SupportMessage.deleteMany({
      _id: { $in: uniqueIds },
    });

    return res.status(200).json({
      success: true,
      message: "Support messages deleted successfully.",
      data: {
        deletedCount: result.deletedCount || 0,
        ids: uniqueIds,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createSupportMessage,
  deleteSupportMessages,
  listSupportMessages,
  startSupportConversation,
  updateSupportMessageStatus,
};
