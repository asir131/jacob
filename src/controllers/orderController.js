const cloudinary = require("../config/cloudinary");
const Gig = require("../models/Gig");
const Order = require("../models/Order");
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
      query.status = status;
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

    if (!["accepted", "accepting_delivery"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: "This order is not in a deliverable state.",
      });
    }

    const deliveryNote = String(req.body.deliveryNote || "").trim();
    if (!deliveryNote) {
      return res.status(400).json({
        success: false,
        message: "Delivery note is required.",
      });
    }

    const uploadedImages = await uploadDeliveryImages(req.files || []);

    order.deliveryNote = deliveryNote;
    order.deliveryImages = uploadedImages;
    order.deliveryPendingAt = new Date();
    order.status = "accepting_delivery";
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
  getProviderOrderDetail,
  acceptProviderOrder,
  declineProviderOrder,
  submitProviderDelivery,
  finalizeClientOrder,
};
