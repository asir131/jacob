const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const Conversation = require("../models/Conversation");
const Gig = require("../models/Gig");
const Message = require("../models/Message");
const Order = require("../models/Order");
const User = require("../models/User");
const CustomOrderProposal = require("../models/CustomOrderProposal");
const ServiceRequest = require("../models/ServiceRequest");
const { emitToUser, emitToRole } = require("../socket");

const uploadBufferToCloudinary = (buffer, folder, resourceType = "auto") => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );
    stream.end(buffer);
  });
};

const uploadChatAttachments = async (files = []) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const uploads = await Promise.all(
    files.slice(0, 4).map(async (file) => {
      const result = await uploadBufferToCloudinary(file.buffer, "jacob/chat-attachments", "auto");
      return {
        url: result?.secure_url || "",
        fileName: String(file.originalname || "").trim(),
        mimeType: String(file.mimetype || "").trim(),
        resourceType: String(result?.resource_type || "raw").trim(),
      };
    })
  );

  return uploads.filter((item) => item.url);
};

const createOrderNumber = () => {
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `ORD-${Date.now()}-${random}`;
};

const resolveRepeatRootId = (order) => {
  if (!order) return null;
  return order.repeatRootOrderId?._id || order.repeatRootOrderId || order._id || null;
};

const countRepeatChainOrders = async (rootOrderId) => {
  if (!mongoose.Types.ObjectId.isValid(String(rootOrderId || ""))) {
    return 1;
  }

  const rootObjectId = new mongoose.Types.ObjectId(String(rootOrderId));
  return Order.countDocuments({
    $or: [{ _id: rootObjectId }, { repeatRootOrderId: rootObjectId }],
  });
};

const buildCustomOrderProposalSummary = (proposal) => {
  if (!proposal) return null;
  return {
    id: proposal._id,
    conversationId: proposal.conversationId || null,
    serviceRequestId: proposal.serviceRequestId || null,
    gigId: proposal.gigId?._id || proposal.gigId || null,
    clientId: proposal.clientId?._id || proposal.clientId || null,
    providerId: proposal.providerId?._id || proposal.providerId || null,
    proposalType: proposal.proposalType || "custom",
    sourceOrderId: proposal.sourceOrderId?._id || proposal.sourceOrderId || null,
    repeatRootOrderId: proposal.repeatRootOrderId?._id || proposal.repeatRootOrderId || null,
    repeatIteration: Number(proposal.repeatIteration) || 1,
    title: proposal.title || "",
    description: proposal.description || "",
    price: Number(proposal.price) || 0,
    serviceAddress: proposal.serviceAddress || "",
    scheduledDate: proposal.scheduledDate || null,
    scheduledTime: proposal.scheduledTime || "",
    status: proposal.status || "pending",
    respondedAt: proposal.respondedAt || null,
    createdOrderId: proposal.createdOrderId || null,
    createdAt: proposal.createdAt || null,
    updatedAt: proposal.updatedAt || null,
  };
};

const normalizeConversation = (conversation, currentUserId) => {
  if (!conversation) return null;
  const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
  const otherUser = participants.find((user) => String(user?._id || user) !== String(currentUserId));
  const order = conversation.orderId || null;
  const gig = conversation.gigId || null;
  const serviceRequest = conversation.serviceRequestId || null;
  return {
    id: conversation._id,
    orderId: order?._id || conversation.orderId || null,
    gigId: gig?._id || order?.gigId?._id || order?.gigId || conversation.gigId || null,
    serviceRequestId: serviceRequest?._id || conversation.serviceRequestId || null,
    orderNumber: order?.orderNumber || "",
    orderName: order?.gigId?.title || gig?.title || serviceRequest?.categoryName || "",
    orderStatus: order?.status || "",
    packageTitle: order?.packageTitle || "",
    categoryName:
      order?.categoryName || order?.gigId?.categoryName || gig?.categoryName || serviceRequest?.categoryName || "",
    blockedBy: conversation.blockedBy || null,
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
  messageType: message.messageType || "text",
  attachments: Array.isArray(message.attachments)
    ? message.attachments.map((item) => ({
        url: item?.url || "",
        fileName: item?.fileName || "",
        mimeType: item?.mimeType || "",
        resourceType: item?.resourceType || "raw",
      }))
    : [],
  customOrderProposal: buildCustomOrderProposalSummary(message.customOrderProposalId),
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
      blockedBy: null,
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

const ensureConversationForParticipants = async ({ clientId, providerId, gigId = null, serviceRequestId = null }) => {
  if (!clientId || !providerId) return null;

  let conversation = await Conversation.findOne({
    orderId: null,
    serviceRequestId: serviceRequestId || null,
    participants: { $all: [clientId, providerId] },
    $expr: { $eq: [{ $size: "$participants" }, 2] },
  });

  if (!conversation) {
    conversation = await Conversation.create({
      orderId: null,
      gigId: gigId || null,
      serviceRequestId: serviceRequestId || null,
      participants: [clientId, providerId],
      blockedBy: null,
      lastMessage: "",
      lastMessageAt: null,
    });
  }

  return conversation;
};

const hydrateConversation = async (conversationId) =>
  Conversation.findById(conversationId)
    .populate("participants", "_id firstName lastName email avatar role")
    .populate("gigId", "_id title categoryName")
    .populate("serviceRequestId", "_id requestNumber categoryName categorySlug serviceAddress")
    .populate({
      path: "orderId",
      select: "_id orderNumber gigId packageTitle categoryName status",
      populate: { path: "gigId", select: "title categoryName" },
    })
    .select("_id participants gigId serviceRequestId orderId blockedBy lastMessage lastMessageAt updatedAt createdAt")
    .lean();

const persistConversationMessage = async ({
  conversation,
  senderId,
  receiverId,
  text = "",
  attachments = [],
  messageType = "text",
  customOrderProposalId = null,
}) => {
  const message = await Message.create({
    conversationId: conversation._id,
    orderId: conversation.orderId || null,
    senderId,
    receiverId,
    text,
    attachments,
    messageType,
    customOrderProposalId,
  });

  const lastMessage = text
    ? text
    : messageType === "custom_order_proposal"
      ? "Sent a custom order request"
      : (attachments[0]?.mimeType || "").startsWith("image/")
        ? "Sent an image"
        : attachments.length > 0
          ? "Sent an attachment"
          : "";
  conversation.lastMessage = lastMessage;
  conversation.lastMessageAt = new Date();
  await conversation.save({ validateBeforeSave: false });

  const hydrated = await Message.findById(message._id)
    .populate("senderId", "_id firstName lastName avatar")
    .populate("receiverId", "_id firstName lastName avatar")
    .populate("customOrderProposalId")
    .lean();

  return {
    normalized: normalizeMessage(hydrated),
    lastMessage,
  };
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
      .populate("gigId", "_id title categoryName")
      .populate({
        path: "orderId",
        select: "_id orderNumber gigId packageTitle categoryName",
        populate: { path: "gigId", select: "title categoryName" },
      })
      .select("_id participants gigId orderId blockedBy lastMessage lastMessageAt updatedAt createdAt")
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

    const hydrated = await hydrateConversation(conversation._id);

    return res.status(200).json({
      success: true,
      message: "Conversation prepared successfully.",
      data: normalizeConversation(hydrated, req.user.id),
    });
  } catch (error) {
    return next(error);
  }
};

const startServiceRequestNegotiationConversation = async ({
  serviceRequestId,
  clientId,
  providerId,
  categoryName = "",
  requestNumber = "",
}) => {
  if (!serviceRequestId || !clientId || !providerId) return null;

  const conversation = await ensureConversationForParticipants({
    clientId,
    providerId,
    serviceRequestId,
  });

  if (!conversation.serviceRequestId) {
    conversation.serviceRequestId = serviceRequestId;
  }

  if (!conversation.lastMessage) {
    conversation.lastMessage = `Accepted request ${requestNumber || categoryName || "service request"} for negotiation.`;
    conversation.lastMessageAt = new Date();
  }

  await conversation.save({ validateBeforeSave: false });
  return conversation;
};

const startCustomOrderConversation = async (req, res, next) => {
  try {
    if (!req.user?.id || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Only clients can request custom orders." });
    }

    const { providerId, gigId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(providerId || ""))) {
      return res.status(400).json({ success: false, message: "Valid provider id is required." });
    }
    if (!mongoose.Types.ObjectId.isValid(String(gigId || ""))) {
      return res.status(400).json({ success: false, message: "Valid gig id is required." });
    }

    const [provider, gig, client] = await Promise.all([
      User.findOne({ _id: providerId, role: "provider" }).select("_id firstName lastName"),
      Gig.findById(gigId).select("_id title categoryName providerId"),
      User.findById(req.user.id).select("_id firstName lastName"),
    ]);

    if (!provider) {
      return res.status(404).json({ success: false, message: "Provider not found." });
    }
    if (!gig || String(gig.providerId) !== String(provider._id)) {
      return res.status(404).json({ success: false, message: "Service not found for this provider." });
    }

    const conversation = await ensureConversationForParticipants({
      clientId: req.user.id,
      providerId: provider._id,
      gigId: gig._id,
    });
    if (!conversation.gigId) {
      conversation.gigId = gig._id;
      await conversation.save({ validateBeforeSave: false });
    }

    const openingText = `Hi, I'd like to create a custom order for ${gig.title || gig.categoryName || "this service"}.`;
    const { normalized } = await persistConversationMessage({
      conversation,
      senderId: req.user.id,
      receiverId: provider._id,
      text: openingText,
      messageType: "system",
    });

    const conversationId = String(conversation._id);
    const targetPath = `/messages?conversationId=${conversationId}`;

    emitToUser(String(provider._id), "chat:message:new", normalized);
    emitToUser(String(req.user.id), "chat:message:new", normalized);
    emitToUser(String(provider._id), "chat:conversation:updated", {
      conversationId,
      lastMessage: openingText,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId,
      lastMessage: openingText,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(provider._id), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "Client wants a custom order",
      description: `${client?.firstName || "A client"} wants to discuss a custom order for ${gig.title || "your service"}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "custom_order_interest",
        conversationId,
        targetPath,
      },
    });

    const hydratedConversation = await hydrateConversation(conversation._id);

    return res.status(201).json({
      success: true,
      message: "Custom order conversation started.",
      data: {
        conversation: normalizeConversation(hydratedConversation, req.user.id),
        message: normalized,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const startRepeatOrderConversation = async (req, res, next) => {
  try {
    if (!req.user?.id || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Only clients can request to place an order again." });
    }

    const { sourceOrderId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(sourceOrderId || ""))) {
      return res.status(400).json({ success: false, message: "Valid source order id is required." });
    }

    const sourceOrder = await Order.findOne({
      _id: sourceOrderId,
      clientId: req.user.id,
      status: "completed",
    })
      .populate("gigId", "_id title categoryName")
      .populate("providerId", "_id firstName lastName")
      .populate("clientId", "_id firstName lastName");

    if (!sourceOrder) {
      return res.status(404).json({ success: false, message: "Completed order not found." });
    }

    const conversation = await ensureConversationForOrder({
      orderId: sourceOrder._id,
      clientId: sourceOrder.clientId?._id || sourceOrder.clientId,
      providerId: sourceOrder.providerId?._id || sourceOrder.providerId,
    });

    const rootOrderId = resolveRepeatRootId(sourceOrder);
    const nextRepeatIteration = (await countRepeatChainOrders(rootOrderId)) + 1;
    const orderTitle = sourceOrder.packageTitle || sourceOrder.gigId?.title || sourceOrder.categoryName || "this order";
    const openingText = `Hi, I'd like to place this order again. This would be repeat #${nextRepeatIteration} for ${orderTitle}.`;

    const { normalized } = await persistConversationMessage({
      conversation,
      senderId: req.user.id,
      receiverId: sourceOrder.providerId?._id || sourceOrder.providerId,
      text: openingText,
      messageType: "system",
    });

    const conversationId = String(conversation._id);
    const targetPath = `/messages?conversationId=${conversationId}&sourceOrderId=${sourceOrder._id.toString()}&proposalType=repeat_order`;

    emitToUser(String(sourceOrder.providerId?._id || sourceOrder.providerId), "chat:message:new", normalized);
    emitToUser(String(req.user.id), "chat:message:new", normalized);
    emitToUser(String(sourceOrder.providerId?._id || sourceOrder.providerId), "chat:conversation:updated", {
      conversationId,
      lastMessage: openingText,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId,
      lastMessage: openingText,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(sourceOrder.providerId?._id || sourceOrder.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "Client wants to order again",
      description: `${sourceOrder.clientId?.firstName || "A client"} wants to place ${orderTitle} again.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "repeat_order_interest",
        conversationId,
        sourceOrderId: sourceOrder._id.toString(),
        repeatIteration: nextRepeatIteration,
        targetPath,
      },
    });

    const hydratedConversation = await hydrateConversation(conversation._id);

    return res.status(201).json({
      success: true,
      message: "Repeat order conversation started.",
      data: {
        conversation: normalizeConversation(hydratedConversation, req.user.id),
        message: normalized,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const createCustomOrderProposal = async (req, res, next) => {
  try {
    if (!req.user?.id || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Only providers can send custom order requests." });
    }

    const { conversationId } = req.params;
    const {
      gigId,
      proposalType = "custom",
      sourceOrderId = null,
      title,
      description = "",
      price,
      serviceAddress,
      scheduledDate,
      scheduledTime,
    } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants orderId blockedBy serviceRequestId");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const participants = (conversation.participants || []).map((item) => String(item));
    if (!participants.includes(String(req.user.id))) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (conversation.blockedBy && String(conversation.blockedBy) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "You can't send proposal in this conversation." });
    }
    if (!["custom", "repeat_order"].includes(String(proposalType || ""))) {
      return res.status(400).json({ success: false, message: "Invalid proposal type." });
    }
    const isRepeatOrderProposal = String(proposalType) === "repeat_order";
    if (conversation.orderId && !isRepeatOrderProposal) {
      return res.status(400).json({ success: false, message: "Custom order request is only available before an order starts." });
    }

    const receiverId = participants.find((item) => item !== String(req.user.id));
    if (!receiverId) {
      return res.status(400).json({ success: false, message: "Client not found in conversation." });
    }
    const hasGigId = mongoose.Types.ObjectId.isValid(String(gigId || ""));
    const serviceRequest =
      conversation.serviceRequestId && mongoose.Types.ObjectId.isValid(String(conversation.serviceRequestId))
        ? await ServiceRequest.findById(conversation.serviceRequestId).select("_id categoryName categorySlug")
        : null;

    let gig = null;
    if (hasGigId) {
      gig = await Gig.findOne({ _id: gigId, providerId: req.user.id }).select("_id title categoryName");
      if (!gig) {
        return res.status(404).json({ success: false, message: "Service not found." });
      }
    } else if (!serviceRequest) {
      return res.status(400).json({ success: false, message: "Valid service id is required." });
    }

    let sourceOrder = null;
    let repeatRootOrderId = null;
    let repeatIteration = 1;
    if (isRepeatOrderProposal) {
      if (!mongoose.Types.ObjectId.isValid(String(sourceOrderId || ""))) {
        return res.status(400).json({ success: false, message: "Valid source order id is required for repeat orders." });
      }

      sourceOrder = await Order.findOne({
        _id: sourceOrderId,
        providerId: req.user.id,
        clientId: receiverId,
        status: "completed",
      }).select("_id gigId packageTitle categoryName repeatRootOrderId repeatIteration");

      if (!sourceOrder) {
        return res.status(404).json({ success: false, message: "Completed source order not found." });
      }

      if (gig && String(sourceOrder.gigId || "") !== String(gig._id)) {
        return res.status(400).json({ success: false, message: "Repeat order must use the same service as the original order." });
      }

      repeatRootOrderId = resolveRepeatRootId(sourceOrder);
      repeatIteration = (await countRepeatChainOrders(repeatRootOrderId)) + 1;
    }

    const normalizedPrice = Number(price);
    const proposalTitle = String(title || "").trim();
    const proposalDescription = String(description || "").trim();
    const proposalAddress = String(serviceAddress || "").trim();
    const proposalTime = String(scheduledTime || "").trim();
    const proposalDateValue = new Date(String(scheduledDate || ""));

    if (!proposalTitle || !proposalAddress || !proposalTime || !Number.isFinite(normalizedPrice) || normalizedPrice <= 0 || Number.isNaN(proposalDateValue.getTime())) {
      return res.status(400).json({ success: false, message: "All custom order proposal fields are required." });
    }

    const proposal = await CustomOrderProposal.create({
      conversationId: conversation._id,
      serviceRequestId: serviceRequest?._id || null,
      gigId: gig?._id || null,
      clientId: receiverId,
      providerId: req.user.id,
      proposalType: isRepeatOrderProposal ? "repeat_order" : "custom",
      sourceOrderId: sourceOrder?._id || null,
      repeatRootOrderId: repeatRootOrderId || null,
      repeatIteration,
      title: proposalTitle,
      description: proposalDescription,
      price: normalizedPrice,
      serviceAddress: proposalAddress,
      scheduledDate: proposalDateValue,
      scheduledTime: proposalTime,
      status: "pending",
    });

    const text = isRepeatOrderProposal
      ? `Repeat order request #${repeatIteration}: ${proposalTitle}`
      : `Custom order request: ${proposalTitle}`;
    const { normalized } = await persistConversationMessage({
      conversation,
      senderId: req.user.id,
      receiverId,
      text,
      messageType: "custom_order_proposal",
      customOrderProposalId: proposal._id,
    });

    const conversationIdStr = String(conversation._id);
    const targetPath = `/messages?conversationId=${conversationIdStr}`;

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
      type: "system",
      title: isRepeatOrderProposal ? "New repeat order offer" : "New custom order request",
      description: isRepeatOrderProposal
        ? `${req.user.firstName || "A provider"} sent you a repeat order offer for ${gig?.title || serviceRequest?.categoryName || "a service"}.`
        : `${req.user.firstName || "A provider"} sent you a custom order request for ${gig?.title || serviceRequest?.categoryName || "a service"}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: isRepeatOrderProposal ? "repeat_order_proposal_created" : "custom_order_proposal_created",
        conversationId: conversationIdStr,
        proposalId: String(proposal._id),
        sourceOrderId: sourceOrder?._id?.toString() || "",
        repeatIteration,
        targetPath,
      },
    });
    if (serviceRequest) {
      emitToRole("superAdmin", "notification:new", {
        id: `NTF-${Date.now()}-admin`,
        type: "system",
        title: "Provider sent a custom offer",
        description: `${req.user.firstName || "A provider"} sent a custom order proposal for ${serviceRequest.requestNumber || serviceRequest.categoryName || "a service request"}.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "admin_custom_order_proposal_created",
          conversationId: conversationIdStr,
          proposalId: String(proposal._id),
          requestId: String(serviceRequest._id),
          requestNumber: serviceRequest.requestNumber || "",
          targetPath: `/service-requests?requestId=${String(serviceRequest._id)}`,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: isRepeatOrderProposal ? "Repeat order request sent." : "Custom order request sent.",
      data: normalized,
    });
  } catch (error) {
    return next(error);
  }
};

const respondToCustomOrderProposal = async (req, res, next) => {
  try {
    if (!req.user?.id || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Only clients can respond to custom order requests." });
    }

    const { proposalId } = req.params;
    const { action } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(proposalId)) {
      return res.status(400).json({ success: false, message: "Invalid custom order request id." });
    }
    if (!["accept", "decline"].includes(String(action || ""))) {
      return res.status(400).json({ success: false, message: "Action must be accept or decline." });
    }

    const proposal = await CustomOrderProposal.findById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: "Custom order request not found." });
    }
    if (String(proposal.clientId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (proposal.status !== "pending") {
      return res.status(400).json({ success: false, message: "This custom order request is already handled." });
    }

    const conversation = await Conversation.findById(proposal.conversationId).select("_id participants orderId serviceRequestId");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const provider = await User.findById(proposal.providerId).select("_id firstName lastName");
    const gig = proposal.gigId ? await Gig.findById(proposal.gigId).select("_id title categoryName") : null;
    const serviceRequest =
      proposal.serviceRequestId || conversation?.serviceRequestId
        ? await ServiceRequest.findById(proposal.serviceRequestId || conversation?.serviceRequestId).select(
            "_id categoryName categorySlug requestNumber serviceAddress"
          )
        : null;
    const sourceOrder = proposal.sourceOrderId
      ? await Order.findById(proposal.sourceOrderId).select("_id repeatRootOrderId repeatIteration packageTitle categoryName")
      : null;
    const isRepeatOrderProposal = proposal.proposalType === "repeat_order";

    proposal.status = action === "accept" ? "accepted" : "declined";
    proposal.respondedAt = new Date();

    let createdOrder = null;
    let text = isRepeatOrderProposal
      ? `Repeat order request declined: ${proposal.title}`
      : `Custom order request declined: ${proposal.title}`;

    if (action === "accept") {
      const repeatRootOrderId = proposal.repeatRootOrderId || resolveRepeatRootId(sourceOrder);
      const repeatIteration = Number(proposal.repeatIteration) || (sourceOrder?.repeatIteration ? Number(sourceOrder.repeatIteration) + 1 : 2);

      createdOrder = await Order.create({
        orderNumber: createOrderNumber(),
        gigId: proposal.gigId || null,
        clientId: proposal.clientId,
        providerId: proposal.providerId,
        conversationId: conversation._id,
        repeatRootOrderId: repeatRootOrderId || null,
        repeatSourceOrderId: proposal.sourceOrderId || null,
        repeatIteration,
        packageName: isRepeatOrderProposal ? "repeat_order" : "custom_order",
        packageTitle: proposal.title,
        categoryName: gig?.categoryName || serviceRequest?.categoryName || "Custom Order",
        packagePrice: Number(proposal.price) || 0,
        scheduledDate: proposal.scheduledDate,
        scheduledTime: proposal.scheduledTime,
        serviceAddress: proposal.serviceAddress,
        specialInstructions: proposal.description || "",
        requirementSubmittedAt: new Date(),
        orderStartedAt: new Date(),
        status: "accepted",
        paymentStatus: "unpaid",
        paymentProvider: "stripe",
        paymentAmount: Number(proposal.price) || 0,
        paymentCurrency: "usd",
        providerEarningsAmount: Number(proposal.price) || 0,
        platformFeeAmount: 0,
      });

      if (!conversation.orderId) {
        conversation.orderId = createdOrder._id;
        await conversation.save({ validateBeforeSave: false });
      }

      if (serviceRequest) {
        serviceRequest.linkedOrderId = createdOrder._id;
        serviceRequest.linkedOrderNumber = createdOrder.orderNumber;
        serviceRequest.status = "accepted";
        serviceRequest.acceptedProviderId = proposal.providerId;
        serviceRequest.acceptedAt = serviceRequest.acceptedAt || new Date();
        serviceRequest.acceptedVia = "admin_invitation";
        await serviceRequest.save({ validateBeforeSave: false });
      }

      proposal.createdOrderId = createdOrder._id;
      text = isRepeatOrderProposal
        ? `Repeat order accepted #${repeatIteration}: ${proposal.title}`
        : `Custom order accepted: ${proposal.title}`;
    }

    await proposal.save();

    const { normalized } = await persistConversationMessage({
      conversation,
      senderId: req.user.id,
      receiverId: proposal.providerId,
      text,
      messageType: "system",
      customOrderProposalId: proposal._id,
    });

    const conversationIdStr = String(conversation._id);
    const targetPath = action === "accept" && createdOrder
      ? `/provider/orders/${createdOrder._id.toString()}`
      : `/messages?conversationId=${conversationIdStr}`;

    emitToUser(String(proposal.providerId), "chat:message:new", normalized);
    emitToUser(String(req.user.id), "chat:message:new", normalized);
    emitToUser(String(proposal.providerId), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage: text,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage: text,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(proposal.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: action === "accept" ? "success" : "warning",
      title:
        action === "accept"
          ? isRepeatOrderProposal
            ? "Repeat order accepted"
            : "Custom order accepted"
          : isRepeatOrderProposal
            ? "Repeat order declined"
            : "Custom order declined",
      description:
        action === "accept"
          ? `${req.user.firstName || "Client"} accepted your ${isRepeatOrderProposal ? "repeat order" : "custom order"} request for ${proposal.title}.`
          : `${req.user.firstName || "Client"} declined your ${isRepeatOrderProposal ? "repeat order" : "custom order"} request for ${proposal.title}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: action === "accept"
          ? isRepeatOrderProposal
            ? "repeat_order_proposal_accepted"
            : "custom_order_proposal_accepted"
          : isRepeatOrderProposal
            ? "repeat_order_proposal_declined"
            : "custom_order_proposal_declined",
        conversationId: conversationIdStr,
        proposalId: String(proposal._id),
        orderId: createdOrder?._id?.toString() || "",
        sourceOrderId: proposal.sourceOrderId?.toString() || "",
        targetPath,
      },
    });
    if (action === "accept" && createdOrder) {
      emitToUser(String(req.user.id), "notification:new", {
        id: `NTF-${Date.now()}-client`,
        type: "success",
        title: isRepeatOrderProposal ? "Repeat order started" : "Custom order started",
        description: `Your ${isRepeatOrderProposal ? "repeat" : "custom"} order for ${proposal.title} has started.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: isRepeatOrderProposal ? "repeat_order_started" : "custom_order_started",
          conversationId: conversationIdStr,
          proposalId: String(proposal._id),
          orderId: createdOrder._id.toString(),
          sourceOrderId: proposal.sourceOrderId?.toString() || "",
          targetPath: `/client/orders/${createdOrder.orderNumber || createdOrder._id.toString()}`,
        },
      });
    }
    if (serviceRequest) {
      emitToRole("superAdmin", "notification:new", {
        id: `NTF-${Date.now()}-admin-proposal-response`,
        type: action === "accept" ? "success" : "warning",
        title: action === "accept" ? "Client accepted custom offer" : "Client declined custom offer",
        description: `${req.user.firstName || "Client"} ${action}ed the proposal for ${serviceRequest.requestNumber || serviceRequest.categoryName || proposal.title}.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: action === "accept" ? "admin_custom_order_proposal_accepted" : "admin_custom_order_proposal_declined",
          conversationId: conversationIdStr,
          proposalId: String(proposal._id),
          requestId: String(serviceRequest._id),
          requestNumber: serviceRequest.requestNumber || "",
          orderId: createdOrder?._id?.toString() || "",
          targetPath: `/service-requests?requestId=${String(serviceRequest._id)}`,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: action === "accept"
        ? isRepeatOrderProposal
          ? "Repeat order accepted."
          : "Custom order accepted."
        : isRepeatOrderProposal
          ? "Repeat order declined."
          : "Custom order declined.",
      data: {
        message: normalized,
        order: createdOrder
          ? {
              id: createdOrder._id,
              orderNumber: createdOrder.orderNumber,
            }
          : null,
      },
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
      Message.find({
        conversationId,
        hiddenFor: { $ne: req.user.id },
      })
        .populate("senderId", "_id firstName lastName avatar")
        .populate("receiverId", "_id firstName lastName avatar")
        .populate("customOrderProposalId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Message.countDocuments({
        conversationId,
        hiddenFor: { $ne: req.user.id },
      }),
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
    const attachments = await uploadChatAttachments(req.files || []);
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }
    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, message: "Message text or attachments are required." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants orderId blockedBy");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const participants = conversation.participants.map((id) => String(id));
    if (!participants.includes(String(req.user.id)) && req.user.role !== "superAdmin") {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (conversation.blockedBy && req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "You can't send message to this user anymore.",
      });
    }

    const receiverId = participants.find((id) => id !== String(req.user.id));
    if (!receiverId) {
      return res.status(400).json({ success: false, message: "Receiver not found in conversation." });
    }

    const { normalized, lastMessage } = await persistConversationMessage({
      conversation,
      senderId: req.user.id,
      receiverId,
      text,
      attachments,
    });
    const senderName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || "Someone";
    const previewSource = text || lastMessage;
    const messagePreview = previewSource.length > 120 ? `${previewSource.slice(0, 117)}...` : previewSource;
    const orderId = conversation.orderId ? String(conversation.orderId) : "";
    const conversationIdStr = String(conversation._id);
    const targetPath = orderId
      ? `/messages?conversationId=${conversationIdStr}&orderId=${orderId}`
      : `/messages?conversationId=${conversationIdStr}`;

    emitToUser(String(receiverId), "chat:message:new", normalized);
    emitToUser(String(req.user.id), "chat:message:new", normalized);
    emitToUser(String(receiverId), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage,
      lastMessageAt: conversation.lastMessageAt,
    });
    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: conversationIdStr,
      lastMessage,
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

const clearConversationHistory = async (req, res, next) => {
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

    const result = await Message.updateMany(
      { conversationId, hiddenFor: { $ne: req.user.id } },
      {
        $addToSet: {
          hiddenFor: req.user.id,
        },
      }
    );

    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: String(conversation._id),
      historyCleared: true,
    });

    const otherParticipant = conversation.participants.find((id) => String(id) !== String(req.user.id));
    if (otherParticipant) {
      emitToUser(String(otherParticipant), "chat:conversation:updated", {
        conversationId: String(conversation._id),
        historyCleared: true,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Conversation history cleared.",
      data: {
        modifiedCount: Number(result?.modifiedCount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const blockConversationUser = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants blockedBy");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    const allowed = conversation.participants.some((id) => String(id) === String(req.user.id));
    if (!allowed && req.user.role !== "superAdmin") {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    conversation.blockedBy = req.user.id;
    await conversation.save({ validateBeforeSave: false });

    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: String(conversation._id),
      blockedBy: String(req.user.id),
    });

    const otherParticipant = conversation.participants.find((id) => String(id) !== String(req.user.id));
    if (otherParticipant) {
      emitToUser(String(otherParticipant), "chat:conversation:updated", {
        conversationId: String(conversation._id),
        blockedBy: String(req.user.id),
      });
      emitToUser(String(otherParticipant), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "chat_blocked",
        title: "Conversation blocked",
        description: "You can't send message to this user anymore.",
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "chat_blocked",
          conversationId: String(conversation._id),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "User blocked successfully.",
      data: {
        conversationId: String(conversation._id),
        blockedBy: String(req.user.id),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const unblockConversationUser = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, message: "Invalid conversation id." });
    }

    const conversation = await Conversation.findById(conversationId).select("_id participants blockedBy");
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    if (!conversation.blockedBy || String(conversation.blockedBy) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "You can only unblock a conversation you blocked." });
    }

    conversation.blockedBy = null;
    await conversation.save({ validateBeforeSave: false });

    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: String(conversation._id),
      blockedBy: null,
    });

    const otherParticipant = conversation.participants.find((id) => String(id) !== String(req.user.id));
    if (otherParticipant) {
      emitToUser(String(otherParticipant), "chat:conversation:updated", {
        conversationId: String(conversation._id),
        blockedBy: null,
      });
      emitToUser(String(otherParticipant), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "chat_unblocked",
        title: "Conversation unblocked",
        description: "You can send messages again.",
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "chat_unblocked",
          conversationId: String(conversation._id),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "User unblocked successfully.",
      data: {
        conversationId: String(conversation._id),
        blockedBy: null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const markConversationMessagesAsRead = async (req, res, next) => {
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

    const result = await Message.updateMany(
      {
        conversationId,
        receiverId: req.user.id,
        readAt: null,
      },
      {
        $set: {
          readAt: new Date(),
        },
      }
    );

    emitToUser(String(req.user.id), "chat:conversation:updated", {
      conversationId: String(conversation._id),
      unreadMessagesMarkedRead: true,
    });

    return res.status(200).json({
      success: true,
      message: "Conversation messages marked as read.",
      data: {
        modifiedCount: Number(result?.modifiedCount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const markAllProviderMessagesAsRead = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const result = await Message.updateMany(
      {
        receiverId: req.user.id,
        readAt: null,
      },
      {
        $set: {
          readAt: new Date(),
        },
      }
    );

    emitToUser(String(req.user.id), "chat:conversation:updated", {
      allConversationsMarkedRead: true,
    });

    return res.status(200).json({
      success: true,
      message: "All provider messages marked as read.",
      data: {
        modifiedCount: Number(result?.modifiedCount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  ensureConversationForOrder,
  ensureConversationForParticipants,
  startServiceRequestNegotiationConversation,
  getConversations,
  ensureConversationByOrder,
  startCustomOrderConversation,
  startRepeatOrderConversation,
  getConversationMessages,
  sendMessage,
  createCustomOrderProposal,
  respondToCustomOrderProposal,
  markConversationMessagesAsRead,
  markAllProviderMessagesAsRead,
  clearConversationHistory,
  blockConversationUser,
  unblockConversationUser,
};
