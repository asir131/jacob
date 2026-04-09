const cloudinary = require("../config/cloudinary");
const Gig = require("../models/Gig");
const Order = require("../models/Order");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { emitToUser } = require("../socket");
const { ensureConversationForOrder } = require("./chatController");

const uploadBufferToCloudinary = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );
    stream.end(buffer);
  });
};

const uploadDeliveryImages = async (files = []) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const uploads = await Promise.all(
    files.slice(0, 4).map((file) => uploadBufferToCloudinary(file.buffer, "jacob/order-deliveries"))
  );
  return uploads
    .map((item) => item?.secure_url)
    .filter((url) => typeof url === "string" && url.trim());
};

const parsePage = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const buildOrderSummary = (order) => {
  if (!order) return null;
  const client = order.clientId || {};
  const provider = order.providerId || {};
  const gig = order.gigId || {};

  return {
    id: order._id,
    orderNumber: order.orderNumber,
    conversationId: order.conversationId || null,
    orderName: gig.title || "Service order",
    categoryName: String(order.categoryName || gig.categoryName || "").trim(),
    status: order.status,
    packageName: order.packageName,
    packageTitle: order.packageTitle,
    packagePrice: Number(order.packagePrice) || 0,
    scheduledDate: order.scheduledDate,
    scheduledTime: order.scheduledTime || "",
    serviceAddress: order.serviceAddress || "",
    specialInstructions: order.specialInstructions || "",
    deliveryNote: order.deliveryNote || "",
    deliveryImages: Array.isArray(order.deliveryImages) ? order.deliveryImages : [],
    revisionRequestNote: order.revisionRequestNote || "",
    revisionResponseNote: order.revisionResponseNote || "",
    revisionRequestedAt: order.revisionRequestedAt || null,
    revisionRespondedAt: order.revisionRespondedAt || null,
    createdAt: order.createdAt,
    requirementSubmittedAt: order.requirementSubmittedAt || order.createdAt || null,
    orderStartedAt: order.orderStartedAt || null,
    deliveryPendingAt: order.deliveryPendingAt || null,
    completedAt: order.completedAt || null,
    client: {
      id: client._id || "",
      name: `${client.firstName || ""} ${client.lastName || ""}`.trim() || "Client",
      email: client.email || "",
      phone: client.phone || "",
      address: client.address || "",
      locationLat: typeof client.locationLat === "number" ? client.locationLat : null,
      locationLng: typeof client.locationLng === "number" ? client.locationLng : null,
      avatar: client.avatar || "",
    },
    provider: {
      id: provider._id || "",
      name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || "Provider",
      email: provider.email || "",
      phone: provider.phone || "",
      address: provider.address || "",
      avatar: provider.avatar || "",
      completedOrders: Number(provider.completedOrders) || 0,
    },
    gig: {
      id: gig._id || "",
      title: gig.title || "",
      categoryName: gig.categoryName || "",
      images: Array.isArray(gig.images) ? gig.images : [],
    },
  };
};

const createOrderNumber = () => {
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `ORD-${Date.now()}-${random}`;
};

const ensureOrderNumber = (order) => {
  if (!order) return;
  if (!String(order.orderNumber || "").trim()) {
    order.orderNumber = createOrderNumber();
  }
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

const sendSystemOrderMessage = async ({ order, senderId, receiverId, text }) => {
  if (!order || !senderId || !receiverId || !String(text || "").trim()) return null;

  const conversation = await ensureConversationForOrder({
    orderId: order._id,
    clientId: order.clientId,
    providerId: order.providerId,
  });
  if (!conversation?._id) return null;

  if (!order.conversationId) {
    order.conversationId = conversation._id;
    await order.save({ validateBeforeSave: false });
  }

  const message = await Message.create({
    conversationId: conversation._id,
    orderId: order._id,
    senderId,
    receiverId,
    text: String(text).trim(),
  });

  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: {
      lastMessage: String(text).trim(),
      lastMessageAt: new Date(),
    },
  });

  const hydrated = await Message.findById(message._id)
    .populate("senderId", "_id firstName lastName avatar")
    .populate("receiverId", "_id firstName lastName avatar")
    .lean();
  const normalized = normalizeMessage(hydrated);
  const conversationId = String(conversation._id);

  emitToUser(String(receiverId), "chat:message:new", normalized);
  emitToUser(String(senderId), "chat:message:new", normalized);
  emitToUser(String(receiverId), "chat:conversation:updated", {
    conversationId,
    lastMessage: String(text).trim(),
    lastMessageAt: normalized.createdAt,
  });
  emitToUser(String(senderId), "chat:conversation:updated", {
    conversationId,
    lastMessage: String(text).trim(),
    lastMessageAt: normalized.createdAt,
  });

  return {
    conversationId,
    message: normalized,
  };
};

const createOrder = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can create orders.",
      });
    }

    const {
      gigId,
      packageName,
      packageTitle,
      packagePrice,
      scheduledDate,
      scheduledTime,
      serviceAddress,
      specialInstructions = "",
    } = req.body;

    if (
      !gigId ||
      !packageName ||
      !packageTitle ||
      !scheduledDate ||
      !scheduledTime ||
      !String(serviceAddress || "").trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required booking fields.",
      });
    }

    const gig = await Gig.findById(gigId)
      .select("_id title providerId categoryName")
      .lean();

    if (!gig || String(gig.providerId) === String(req.user.id)) {
      return res.status(404).json({
        success: false,
        message: "Service not found for booking.",
      });
    }

    const order = await Order.create({
      orderNumber: createOrderNumber(),
      gigId: gig._id,
      clientId: req.user.id,
      providerId: gig.providerId,
      packageName: String(packageName).trim(),
      packageTitle: String(packageTitle).trim(),
      categoryName: String(gig.categoryName || "").trim(),
      packagePrice: Number(packagePrice) || 0,
      scheduledDate: new Date(scheduledDate),
      scheduledTime: String(scheduledTime).trim(),
      serviceAddress: String(serviceAddress).trim(),
      specialInstructions: String(specialInstructions || "").trim(),
      requirementSubmittedAt: new Date(),
      status: "pending",
    });

    emitToUser(String(gig.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "New order received",
      description: `${req.user.firstName || "A client"} placed a new ${gig.categoryName || "service"} order.`,
      data: {
        notificationType: "order_created",
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        gigId: gig._id.toString(),
        targetPath: "/provider/orders",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Order created successfully.",
      data: {
        order: buildOrderSummary({
          ...order.toObject(),
          gigId: { _id: gig._id, title: gig.title, categoryName: gig.categoryName },
        }),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listProviderOrders = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view provider orders.",
      });
    }

    const page = parsePage(req.query.page, 1);
    const limit = Math.min(20, parsePage(req.query.limit, 8));
    const skip = (page - 1) * limit;
    const status = String(req.query.status || "").trim().toLowerCase();
    const search = String(req.query.search || "").trim();

    const query = {
      providerId: req.user.id,
    };

    if (status && status !== "all") {
      if (status === "request_revision") {
        query.status = "revision_requested";
      } else {
        query.status = status;
      }
    }

    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: "i" } },
        { packageTitle: { $regex: search, $options: "i" } },
        { serviceAddress: { $regex: search, $options: "i" } },
      ];
    }

    const [orders, totalItems] = await Promise.all([
      Order.find(query)
        .populate("gigId", "_id title categoryName images")
        .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
        .populate("providerId", "_id firstName lastName email phone address avatar")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Provider orders fetched successfully.",
      data: {
        items: orders.map(buildOrderSummary),
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

const listClientOrders = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can view client orders.",
      });
    }

    const page = parsePage(req.query.page, 1);
    const limit = Math.min(20, parsePage(req.query.limit, 8));
    const skip = (page - 1) * limit;
    const status = String(req.query.status || "").trim().toLowerCase();
    const search = String(req.query.search || "").trim();

    const query = {
      clientId: req.user.id,
    };

    if (status && status !== "all") {
      if (status === "payment_pending") {
        query.status = "accepting_delivery";
      } else if (status === "cancelled") {
        query.status = "declined";
      } else {
        query.status = status;
      }
    }

    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: "i" } },
        { packageTitle: { $regex: search, $options: "i" } },
        { serviceAddress: { $regex: search, $options: "i" } },
      ];
    }

    const [orders, totalItems] = await Promise.all([
      Order.find(query)
        .populate("gigId", "_id title categoryName images")
        .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
        .populate("providerId", "_id firstName lastName email phone address avatar")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Client orders fetched successfully.",
      data: {
        items: orders.map(buildOrderSummary),
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

const getClientOrderDetail = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can view client order details.",
      });
    }

    const rawId = String(req.params.id || "").trim();
    const query = {
      clientId: req.user.id,
    };

    if (rawId.startsWith("ORD-")) {
      query.orderNumber = rawId;
    } else {
      query._id = rawId;
    }

    const order = await Order.findOne(query)
      .populate("gigId", "_id title categoryName images")
      .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
      .populate("providerId", "_id firstName lastName email phone address avatar")
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    const providerId = order?.providerId?._id || order?.providerId;
    let completedOrders = 0;
    if (providerId) {
      completedOrders = await Order.countDocuments({
        providerId,
        status: "completed",
      });
    }

    const normalizedOrder = buildOrderSummary({
      ...order,
      providerId: {
        ...(order.providerId || {}),
        completedOrders,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Client order fetched successfully.",
      data: {
        order: normalizedOrder,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getProviderOrderDetail = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view order details.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      providerId: req.user.id,
    })
      .populate("gigId", "_id title categoryName images")
      .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
      .populate("providerId", "_id firstName lastName email phone address avatar")
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order fetched successfully.",
      data: {
        order: buildOrderSummary(order),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const acceptProviderOrder = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can accept orders.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      providerId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending orders can be accepted.",
      });
    }

    order.status = "accepted";
    order.orderStartedAt = new Date();
    ensureOrderNumber(order);
    const conversation = await ensureConversationForOrder({
      orderId: order._id,
      clientId: order.clientId,
      providerId: order.providerId,
    });
    if (conversation?._id) {
      order.conversationId = conversation._id;
    }
    await order.save();

    emitToUser(String(order.clientId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "Provider accepted your order",
      description: `Your order for ${order.gigId?.title || "service"} is now in progress.`,
      data: {
        notificationType: "order_accepted",
        orderId: order._id.toString(),
        conversationId: conversation?._id ? String(conversation._id) : "",
        targetPath: conversation?._id
          ? `/messages?conversationId=${String(conversation._id)}&orderId=${order._id.toString()}`
          : `/client/orders/${order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    if (conversation?._id) {
      const payload = {
        conversationId: String(conversation._id),
        orderId: order._id.toString(),
        targetPath: `/messages?conversationId=${String(conversation._id)}&orderId=${order._id.toString()}`,
      };
      emitToUser(String(order.clientId), "chat:created", payload);
      emitToUser(String(order.providerId), "chat:created", payload);
    }

    return res.status(200).json({
      success: true,
      message: "Order accepted successfully.",
      data: {
        order,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const declineProviderOrder = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can decline orders.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      providerId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending orders can be declined.",
      });
    }

    order.status = "declined";
    ensureOrderNumber(order);
    await order.save();

    emitToUser(String(order.clientId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
      title: "Order declined",
      description: `Your order for ${order.gigId?.title || "service"} was declined by the provider.`,
      data: {
        notificationType: "order_declined",
        orderId: order._id.toString(),
        targetPath: "/client/orders",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Order declined successfully.",
      data: {
        order,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const submitProviderDelivery = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can submit delivery.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      providerId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (!["accepted", "accepting_delivery", "under_revision"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: "This order is not in a deliverable state.",
      });
    }

    const incomingDeliveryNote = String(req.body.deliveryNote || "").trim();
    const deliveryNote = incomingDeliveryNote || String(order.deliveryNote || "").trim();
    if (!deliveryNote) {
      return res.status(400).json({
        success: false,
        message: "Delivery note is required.",
      });
    }

    const uploadedImages = await uploadDeliveryImages(req.files || []);
    const nextImages =
      Array.isArray(uploadedImages) && uploadedImages.length
        ? uploadedImages
        : Array.isArray(order.deliveryImages)
          ? order.deliveryImages
          : [];

    order.deliveryNote = deliveryNote;
    order.deliveryImages = nextImages;
    order.deliveryPendingAt = new Date();
    order.status = "accepting_delivery";
    order.revisionResponseNote = "";
    ensureOrderNumber(order);
    await order.save();

    emitToUser(String(order.clientId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "Delivery submitted",
      description: `Provider submitted delivery for ${order.gigId?.title || "your order"}.`,
      data: {
        notificationType: "order_delivery_submitted",
        orderId: order._id.toString(),
        targetPath: `/client/orders/${order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Delivery submitted successfully.",
      data: {
        order,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const requestClientRevision = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can request revision.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      clientId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "accepting_delivery") {
      return res.status(400).json({
        success: false,
        message: "Revision can only be requested after delivery submission.",
      });
    }

    const note = String(req.body.note || "").trim();
    if (!note) {
      return res.status(400).json({
        success: false,
        message: "Revision note is required.",
      });
    }

    order.status = "revision_requested";
    order.revisionRequestNote = note;
    order.revisionRequestedAt = new Date();
    order.revisionResponseNote = "";
    order.revisionRespondedAt = null;
    await order.save();

    const chat = await sendSystemOrderMessage({
      order,
      senderId: order.clientId,
      receiverId: order.providerId,
      text: `Revision requested: ${note}`,
    });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
      title: "Client requested revision",
      description: `Revision requested for ${order.gigId?.title || "an order"}.`,
      data: {
        notificationType: "order_revision_requested",
        orderId: order._id.toString(),
        targetPath: `/provider/orders/${order._id.toString()}`,
        conversationId: chat?.conversationId || "",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Revision requested successfully.",
      data: { order: buildOrderSummary(order) },
    });
  } catch (error) {
    return next(error);
  }
};

const respondProviderRevision = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can respond to revision requests.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      providerId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "revision_requested") {
      return res.status(400).json({
        success: false,
        message: "No revision request available for this order.",
      });
    }

    const action = String(req.body.action || "").trim().toLowerCase();
    const note = String(req.body.note || "").trim();
    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be accept or decline.",
      });
    }

    if (action === "accept") {
      order.status = "under_revision";
      order.revisionResponseNote = note || "Provider accepted revision request.";
      order.revisionRespondedAt = new Date();
    } else {
      order.status = "accepting_delivery";
      order.revisionResponseNote = note || "Provider declined revision request.";
      order.revisionRespondedAt = new Date();
    }
    await order.save();

    const text =
      action === "accept"
        ? `Provider accepted revision request.${note ? ` Note: ${note}` : ""}`
        : `Provider declined revision request.${note ? ` Note: ${note}` : ""}`;
    const chat = await sendSystemOrderMessage({
      order,
      senderId: order.providerId,
      receiverId: order.clientId,
      text,
    });

    emitToUser(String(order.clientId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: action === "accept" ? "system" : "warning",
      title: action === "accept" ? "Revision accepted by provider" : "Revision declined by provider",
      description:
        action === "accept"
          ? `Provider is working on your revision for ${order.gigId?.title || "order"}.`
          : `Provider declined revision for ${order.gigId?.title || "order"}. You can continue with payment.`,
      data: {
        notificationType: action === "accept" ? "order_revision_accepted" : "order_revision_declined",
        orderId: order._id.toString(),
        targetPath: `/client/orders/${order.orderNumber || order._id.toString()}`,
        conversationId: chat?.conversationId || "",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: action === "accept" ? "Revision accepted." : "Revision declined.",
      data: { order: buildOrderSummary(order) },
    });
  } catch (error) {
    return next(error);
  }
};

const cancelClientRevisionRequest = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can cancel revision request.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      clientId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (!["revision_requested", "under_revision"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: "This order has no active revision request.",
      });
    }

    order.status = "accepting_delivery";
    order.revisionResponseNote = "Client cancelled revision request.";
    order.revisionRespondedAt = new Date();
    await order.save();

    const chat = await sendSystemOrderMessage({
      order,
      senderId: order.clientId,
      receiverId: order.providerId,
      text: "Client cancelled revision request and moved back to delivery acceptance.",
    });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "Revision request cancelled",
      description: "Client cancelled revision request. Order is back to delivery acceptance.",
      data: {
        notificationType: "order_revision_cancelled",
        orderId: order._id.toString(),
        targetPath: `/provider/orders/${order._id.toString()}`,
        conversationId: chat?.conversationId || "",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Revision request cancelled successfully.",
      data: { order: buildOrderSummary(order) },
    });
  } catch (error) {
    return next(error);
  }
};

const sendClientResolutionMessage = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can send resolution messages.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      clientId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    const text = String(req.body.text || "").trim();
    const fallbackText = `Client wants to discuss revision for ${order.gigId?.title || "this order"}.`;
    const finalText = text || fallbackText;

    const chat = await sendSystemOrderMessage({
      order,
      senderId: order.clientId,
      receiverId: order.providerId,
      text: finalText,
    });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "New resolution message",
      description: finalText.length > 120 ? `${finalText.slice(0, 117)}...` : finalText,
      data: {
        notificationType: "order_resolution_message",
        orderId: order._id.toString(),
        targetPath: chat?.conversationId
          ? `/messages?conversationId=${chat.conversationId}&orderId=${order._id.toString()}`
          : `/messages?orderId=${order._id.toString()}`,
        conversationId: chat?.conversationId || "",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Resolution message sent.",
      data: {
        conversationId: chat?.conversationId || "",
      },
    });
  } catch (error) {
    return next(error);
  }
};

const finalizeClientOrder = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can finalize orders.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      clientId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "accepting_delivery") {
      return res.status(400).json({
        success: false,
        message: "Order is not ready for finalization.",
      });
    }

    order.status = "completed";
    order.completedAt = new Date();
    ensureOrderNumber(order);
    await order.save();

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "Order finalized",
      description: `Client finalized ${order.gigId?.title || "the order"} after delivery.`,
      data: {
        notificationType: "order_finalized",
        orderId: order._id.toString(),
        targetPath: `/provider/orders/${order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Order finalized successfully.",
      data: {
        order,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createOrder,
  listProviderOrders,
  listClientOrders,
  getProviderOrderDetail,
  getClientOrderDetail,
  acceptProviderOrder,
  declineProviderOrder,
  submitProviderDelivery,
  requestClientRevision,
  respondProviderRevision,
  cancelClientRevisionRequest,
  sendClientResolutionMessage,
  finalizeClientOrder,
};
