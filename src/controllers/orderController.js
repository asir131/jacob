const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const crypto = require("crypto");
const Gig = require("../models/Gig");
const Order = require("../models/Order");
const User = require("../models/User");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const ServiceRequest = require("../models/ServiceRequest");
const { emitToUser } = require("../socket");
const { ensureConversationForOrder } = require("./chatController");
const WithdrawalRequest = require("../models/WithdrawalRequest");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const WEB_APP_URL = process.env.CLIENT_APP_URL || process.env.FRONTEND_URL || "http://localhost:3000";
const MOBILE_APP_URL = process.env.MOBILE_APP_URL || "jaco://booking-details";
const ADMIN_FEE_RATE = 0.1;

const buildClientCheckoutRedirectUrl = (baseUrl, params = {}) => {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    searchParams.append(key, String(value));
  });

  const queryString = searchParams.toString();
  if (!queryString) return baseUrl;
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${queryString}`;
};

const resolveClientCheckoutRedirects = (req, order) => {
  const clientPlatform = String(req.headers["x-client-platform"] || "").toLowerCase();
  const isMobileCheckout = clientPlatform === "mobile";

  if (isMobileCheckout) {
    const mobileBaseUrl = MOBILE_APP_URL || "jaco://booking-details";
    return {
      successUrl: buildClientCheckoutRedirectUrl(mobileBaseUrl, {
        id: order._id?.toString(),
        role: "client",
        checkout: "success",
        session_id: "{CHECKOUT_SESSION_ID}",
      }),
      cancelUrl: buildClientCheckoutRedirectUrl(mobileBaseUrl, {
        id: order._id?.toString(),
        role: "client",
        checkout: "cancel",
      }),
    };
  }

  const orderPath = `/client/orders/${order.orderNumber || order._id.toString()}`;
  return {
    successUrl: `${WEB_APP_URL}${orderPath}?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${WEB_APP_URL}${orderPath}`,
  };
};

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

const formatAddress = (area = "", district = "", zip = "") =>
  [area || "Area unavailable", district || "District unavailable", zip || "ZIP N/A"].join(", ");

const resolveAddressFromCoordinates = async (lat, lng) => {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "";

  try {
    const response = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    if (!response.ok) return "";

    const data = await response.json();
    const formatted = formatAddress(
      String(data?.locality || data?.city || "").trim(),
      String(data?.principalSubdivision || "").trim(),
      String(data?.postcode || "").trim()
    );

    return formatted === "Area unavailable, District unavailable, ZIP N/A" ? "" : formatted;
  } catch {
    return "";
  }
};

const geocodeAddress = async (address = "") => {
  const query = String(address || "").trim();
  if (!query) return null;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "jacob-backend/1.0",
        },
      }
    );
    if (!response.ok) return null;

    const [result] = await response.json();
    const lat = Number(result?.lat);
    const lng = Number(result?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng };
  } catch {
    return null;
  }
};

const calculateDistanceKm = (fromLat, fromLng, toLat, toLng) => {
  const lat1 = Number(fromLat);
  const lng1 = Number(fromLng);
  const lat2 = Number(toLat);
  const lng2 = Number(toLng);

  if (![lat1, lng1, lat2, lng2].every((value) => Number.isFinite(value))) {
    return null;
  }

  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Number((earthRadiusKm * c).toFixed(1));
};

const normalizePoint = (lat, lng) => {
  const normalizedLat = Number(lat);
  const normalizedLng = Number(lng);
  if (!Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLng)) return null;
  return { lat: normalizedLat, lng: normalizedLng };
};

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));
const calculateAdminFeeAmount = (baseAmount) => roundMoney((Number(baseAmount) || 0) * ADMIN_FEE_RATE);
const calculateClientPaymentAmount = (baseAmount) =>
  roundMoney((Number(baseAmount) || 0) + calculateAdminFeeAmount(baseAmount));
const buildPackagePricing = (baseAmount) => {
  const normalizedBaseAmount = roundMoney(baseAmount);
  const adminFeeAmount = calculateAdminFeeAmount(normalizedBaseAmount);

  return {
    baseAmount: normalizedBaseAmount,
    adminFeeAmount,
    clientPaymentAmount: calculateClientPaymentAmount(normalizedBaseAmount),
  };
};

const resolveRepeatRootId = (order) => {
  if (!order) return null;
  return order.repeatRootOrderId?._id || order.repeatRootOrderId || order._id || null;
};

const attachRepeatCounts = async (orders = []) => {
  if (!Array.isArray(orders) || orders.length === 0) return [];

  const rootIds = Array.from(
    new Set(
      orders
        .map((order) => String(resolveRepeatRootId(order) || ""))
        .filter((value) => mongoose.Types.ObjectId.isValid(value))
    )
  );

  if (!rootIds.length) {
    return orders.map((order) => ({ ...order, repeatOrderCount: Number(order?.repeatOrderCount) || 1 }));
  }

  const rootObjectIds = rootIds.map((id) => new mongoose.Types.ObjectId(id));
  const counts = await Order.aggregate([
    {
      $match: {
        $or: [{ _id: { $in: rootObjectIds } }, { repeatRootOrderId: { $in: rootObjectIds } }],
      },
    },
    {
      $project: {
        rootId: { $ifNull: ["$repeatRootOrderId", "$_id"] },
      },
    },
    {
      $group: {
        _id: "$rootId",
        count: { $sum: 1 },
      },
    },
  ]);

  const countMap = new Map(counts.map((entry) => [String(entry._id), Number(entry.count) || 1]));
  return orders.map((order) => {
    const rootId = String(resolveRepeatRootId(order) || "");
    return {
      ...order,
      repeatOrderCount: countMap.get(rootId) || Number(order?.repeatOrderCount) || 1,
    };
  });
};

const buildOrderSummary = (order) => {
  if (!order) return null;
  const client = order.clientId || {};
  const provider = order.providerId || {};
  const gig = order.gigId || {};
  const repeatRootOrderId = resolveRepeatRootId(order);
  const repeatIteration = Math.max(1, Number(order.repeatIteration) || 1);
  const repeatOrderCount = Math.max(repeatIteration, Number(order.repeatOrderCount) || 1);

  return {
    id: order._id,
    orderNumber: order.orderNumber,
    conversationId: order.conversationId || null,
    repeatRootOrderId,
    repeatSourceOrderId: order.repeatSourceOrderId?._id || order.repeatSourceOrderId || null,
    repeatIteration,
    repeatOrderCount,
    orderName: order.packageTitle || order.categoryName || gig.title || "Service order",
    categoryName: String(order.categoryName || gig.categoryName || "").trim(),
      status: order.status,
      revisionType:
        order.status === "after_sell_revision_requested" || order.status === "under_after_sell_revision"
          ? "after_sell"
          : "delivery",
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
      clientRating: Number.isFinite(Number(order.clientRating)) ? Number(order.clientRating) : null,
      clientReview: order.clientReview || "",
      revisionRequestedAt: order.revisionRequestedAt || null,
      revisionRespondedAt: order.revisionRespondedAt || null,
      createdAt: order.createdAt,
    requirementSubmittedAt: order.requirementSubmittedAt || order.createdAt || null,
    orderStartedAt: order.orderStartedAt || null,
    deliveryPendingAt: order.deliveryPendingAt || null,
    completedAt: order.completedAt || null,
    paymentStatus: order.paymentStatus || "unpaid",
    paymentProvider: order.paymentProvider || "stripe",
    paymentCurrency: order.paymentCurrency || "usd",
    paymentAmount: Number(order.paymentAmount) || Number(order.packagePrice) || 0,
    platformFeeAmount: Number(order.platformFeeAmount) || 0,
    providerEarningsAmount: Number(order.providerEarningsAmount) || Number(order.packagePrice) || 0,
    paidAt: order.paidAt || null,
    isRequestedOrder: !gig._id || !gig.title,
    canRequestRepeatOrder: order.status === "completed",
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
      averageRating: Number(provider.averageRating) || 0,
      reviewCount: Number(provider.reviewCount) || 0,
      completedOrders: Number(provider.completedOrders) || 0,
      walletBalance: Number(provider.walletBalance) || 0,
      totalEarnings: Number(provider.totalEarnings) || 0,
      sellerLevel: provider.sellerLevel || "New",
    },
    gig: {
      id: gig._id || "",
      title: gig.title || "",
      categoryName: gig.categoryName || "",
      images: Array.isArray(gig.images) ? gig.images : [],
    },
    };
  };

const buildDashboardRequestCard = (order) => {
  const summary = buildOrderSummary(order);
  if (!summary) return null;

  return {
    id: summary.id,
    orderNumber: summary.orderNumber,
    title: summary.orderName,
    category: summary.categoryName || "General",
    customer: summary.client?.name || "Client",
    address: String(order?.clientAddressSnapshot || summary.client?.address || "Location not set"),
    time: summary.createdAt || new Date().toISOString(),
    avatar: summary.client?.avatar || "",
    clientId: summary.client?.id || "",
    status: summary.status,
  };
};

const formatShortDay = (date) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);

const formatShortMonth = (date) =>
  new Intl.DateTimeFormat("en-US", { month: "short" }).format(date).toUpperCase();

const createDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildAdminOrderPreview = (order) => {
  const summary = buildOrderSummary(order);
  if (!summary) return null;

  return {
    id: String(summary.id || ""),
    orderNumber: summary.orderNumber || "",
    orderName: summary.orderName || "Service order",
    categoryName: summary.categoryName || "",
    status: summary.status || "",
    paymentStatus: summary.paymentStatus || "",
    paymentAmount: roundMoney(summary.paymentAmount || 0),
    platformFeeAmount: roundMoney(summary.platformFeeAmount || 0),
    providerEarningsAmount: roundMoney(summary.providerEarningsAmount || 0),
    scheduledDate: summary.scheduledDate || null,
    scheduledTime: summary.scheduledTime || "",
    serviceAddress: summary.serviceAddress || "",
    createdAt: summary.createdAt || null,
    completedAt: summary.completedAt || null,
    paidAt: summary.paidAt || null,
    client: summary.client,
    provider: summary.provider,
    gig: summary.gig,
  };
};

const getAdminDashboard = async (req, res, next) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyRevenueStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [
      orderCounts,
      verifiedProviders,
      newUsersLast30Days,
      totalUsers,
      recentOrdersRaw,
      paidOrdersForRevenue,
      recentMessages,
      recentServiceRequests,
      recentOrderActivity,
    ] = await Promise.all([
      Order.aggregate([
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            completedOrders: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
            weeklyOrders: {
              $sum: {
                $cond: [{ $gte: ["$createdAt", sevenDaysAgo] }, 1, 0],
              },
            },
            totalRevenue: {
              $sum: {
                $cond: [
                  { $eq: ["$paymentStatus", "paid"] },
                  { $ifNull: ["$paymentAmount", 0] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      User.countDocuments({ role: "provider", payoutVerificationStatus: "verified" }),
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      User.countDocuments(),
      Order.find({})
        .populate("gigId", "_id title categoryName images")
        .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
        .populate("providerId", "_id firstName lastName email phone address avatar averageRating reviewCount sellerLevel")
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      Order.find({
        paymentStatus: "paid",
        $or: [{ paidAt: { $gte: monthlyRevenueStart } }, { createdAt: { $gte: monthlyRevenueStart } }],
      })
        .select("paymentAmount paidAt createdAt")
        .lean(),
      Message.find({ createdAt: { $gte: sevenDaysAgo } }).select("createdAt senderId receiverId").lean(),
      ServiceRequest.find({ createdAt: { $gte: sevenDaysAgo } }).select("createdAt clientId acceptedProviderId").lean(),
      Order.find({ createdAt: { $gte: sevenDaysAgo } }).select("createdAt clientId providerId").lean(),
    ]);

    const counts = orderCounts[0] || {};
    const monthlyRevenueMap = new Map();
    const pieRevenueMap = new Map();
    const weeklyRevenueMap = new Map();
    const dailyActiveUsersMap = new Map();

    for (let index = 0; index < 12; index += 1) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - (11 - index), 1);
      const monthKey = `${monthDate.getFullYear()}-${monthDate.getMonth()}`;
      monthlyRevenueMap.set(monthKey, {
        name: formatShortMonth(monthDate),
        revenue: 0,
      });
    }

    for (let index = 0; index < 7; index += 1) {
      const dayDate = new Date(sevenDaysAgo);
      dayDate.setDate(sevenDaysAgo.getDate() + index);
      const dayKey = createDateKey(dayDate);
      weeklyRevenueMap.set(dayKey, {
        name: formatShortDay(dayDate),
        revenue: 0,
      });
      dailyActiveUsersMap.set(dayKey, {
        name: formatShortDay(dayDate),
        users: new Set(),
      });
    }

    paidOrdersForRevenue.forEach((order) => {
      const sourceDate = new Date(order.paidAt || order.createdAt || now);
      const amount = roundMoney(order.paymentAmount || 0);
      const monthKey = `${sourceDate.getFullYear()}-${sourceDate.getMonth()}`;
      const monthEntry = monthlyRevenueMap.get(monthKey);
      if (monthEntry) {
        monthEntry.revenue = roundMoney(monthEntry.revenue + amount);
        monthlyRevenueMap.set(monthKey, monthEntry);
      }

      const dayKey = createDateKey(sourceDate);
      const dayEntry = weeklyRevenueMap.get(dayKey);
      if (dayEntry) {
        dayEntry.revenue = roundMoney(dayEntry.revenue + amount);
        weeklyRevenueMap.set(dayKey, dayEntry);
      }
    });

    const registerActiveUser = (dateValue, userId) => {
      if (!userId) return;
      const date = new Date(dateValue || now);
      const dayKey = createDateKey(date);
      const entry = dailyActiveUsersMap.get(dayKey);
      if (!entry) return;
      entry.users.add(String(userId));
      dailyActiveUsersMap.set(dayKey, entry);
    };

    recentMessages.forEach((message) => {
      registerActiveUser(message.createdAt, message.senderId);
      registerActiveUser(message.createdAt, message.receiverId);
    });

    recentServiceRequests.forEach((request) => {
      registerActiveUser(request.createdAt, request.clientId);
      registerActiveUser(request.createdAt, request.acceptedProviderId);
    });

    recentOrderActivity.forEach((order) => {
      registerActiveUser(order.createdAt, order.clientId);
      registerActiveUser(order.createdAt, order.providerId);
    });

    const monthlyRevenue = Array.from(monthlyRevenueMap.values());
    const weeklyRevenue = Array.from(weeklyRevenueMap.values());
    const dailyTraffic = Array.from(dailyActiveUsersMap.values()).map((entry) => ({
      name: entry.name,
      users: entry.users.size,
    }));
    const maxActiveUsers = dailyTraffic.reduce((max, item) => Math.max(max, item.users), 0);
    const pieRevenue = monthlyRevenue
      .filter((item) => item.revenue > 0)
      .slice(-6)
      .map((item) => {
        pieRevenueMap.set(item.name, item.revenue);
        return { name: item.name, value: item.revenue };
      });

    const recentOrdersWithRepeatCounts = await attachRepeatCounts(recentOrdersRaw);
    const recentOrders = recentOrdersWithRepeatCounts
      .map(buildAdminOrderPreview)
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      message: "Admin dashboard fetched successfully.",
      data: {
        summary: {
          totalRevenue: roundMoney(counts.totalRevenue || 0),
          totalBookings: Number(counts.totalBookings || 0),
          verifiedProviders: Number(verifiedProviders || 0),
          weeklyOrders: Number(counts.weeklyOrders || 0),
          newUsersLast30Days: Number(newUsersLast30Days || 0),
          completedOrders: Number(counts.completedOrders || 0),
          totalUsers: Number(totalUsers || 0),
          currentMonthRevenue: roundMoney(
            paidOrdersForRevenue.reduce((sum, order) => {
              const sourceDate = new Date(order.paidAt || order.createdAt || now);
              if (sourceDate < currentMonthStart) return sum;
              return sum + (Number(order.paymentAmount) || 0);
            }, 0)
          ),
          maxActiveUsers,
        },
        charts: {
          monthlyRevenue,
          weeklyRevenue,
          dailyTraffic,
          pieRevenue,
        },
        recentOrders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminOrderDetail = async (req, res, next) => {
  try {
    const rawId = String(req.params.id || "").trim();
    const query = rawId.startsWith("ORD-") ? { orderNumber: rawId } : { _id: rawId };

    const order = await Order.findOne(query)
      .populate("gigId", "_id title categoryName images")
      .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
      .populate("providerId", "_id firstName lastName email phone address avatar averageRating reviewCount sellerLevel walletBalance totalEarnings")
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

    const [orderWithRepeatCount] = await attachRepeatCounts([
      {
        ...order,
        providerId: {
          ...(order.providerId || {}),
          completedOrders,
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      message: "Admin order detail fetched successfully.",
      data: {
        order: buildOrderSummary(orderWithRepeatCount),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const resolveSellerLevel = (completedOrderCount = 0) => {
  const total = Number(completedOrderCount) || 0;
  if (total >= 11) return "Top Rated";
  if (total >= 8) return "Level 3";
  if (total >= 5) return "Level 2";
  if (total >= 2) return "Level 1";
  return "New";
};

const refreshProviderPerformanceStats = async (providerId) => {
  if (!providerId) return;

  const providerObjectId = new mongoose.Types.ObjectId(String(providerId));
  const [stats, completedOrderCount] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          providerId: providerObjectId,
          status: "completed",
          paymentStatus: "paid",
          clientRating: { $ne: null },
        },
      },
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$clientRating" },
          reviewCount: { $sum: 1 },
        },
      },
    ]),
    Order.countDocuments({
      providerId,
      status: "completed",
      paymentStatus: "paid",
    }),
  ]);

  const averageRating = Number(stats?.[0]?.averageRating || 0);
  const reviewCount = Number(stats?.[0]?.reviewCount || 0);
  const sellerLevel = resolveSellerLevel(completedOrderCount);

  await User.findByIdAndUpdate(providerId, {
    $set: {
      averageRating,
      reviewCount,
      sellerLevel,
    },
  });

  return {
    averageRating,
    reviewCount,
    sellerLevel,
  };
};

const formatOrderStatusLabel = (status = "") => {
  const normalized = String(status || "").trim().toLowerCase();
  const labels = {
    pending: "Pending",
    accepted: "In Progress",
    accepting_delivery: "In Progress",
    revision_requested: "Under Review",
    under_revision: "Under Review",
    after_sell_revision_requested: "Under Review",
    under_after_sell_revision: "Under Review",
    done_after_sell_revision: "Completed",
    completed: "Completed",
    declined: "Cancelled",
  };

  return labels[normalized] || "Pending";
};

const getProviderDashboard = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view provider dashboard data.",
      });
    }

    const providerId = req.user.id;
    const providerObjectId = new mongoose.Types.ObjectId(String(providerId));

    const [
      providerProfile,
      totalOrders,
      pendingOrders,
      activeOrders,
      completedOrders,
      monthlyEarnings,
      pendingRequestDocs,
    ] = await Promise.all([
      User.findById(providerId).select("_id walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel").lean(),
      Order.countDocuments({ providerId }),
      Order.countDocuments({ providerId, status: "pending" }),
      Order.countDocuments({
        providerId,
        status: {
          $in: [
            "accepted",
            "accepting_delivery",
            "revision_requested",
            "under_revision",
            "after_sell_revision_requested",
            "under_after_sell_revision",
          ],
        },
      }),
      Order.countDocuments({ providerId, status: "completed" }),
      Order.aggregate([
        {
          $match: {
            providerId: providerObjectId,
            status: "completed",
            paymentStatus: "paid",
            paidAt: {
              $gte: new Date(new Date().getFullYear(), 0, 1),
              $lt: new Date(new Date().getFullYear() + 1, 0, 1),
            },
          },
        },
        {
          $group: {
            _id: { $month: "$paidAt" },
            earnings: { $sum: "$providerEarningsAmount" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.find({ providerId, status: "pending" })
        .populate("gigId", "_id title categoryName")
        .populate("clientId", "_id firstName lastName avatar address locationLat locationLng")
        .sort({ createdAt: -1 })
        .limit(2)
        .lean(),
    ]);

    const averageRating = Number(providerProfile?.averageRating || 0);
    const reviewCount = Number(providerProfile?.reviewCount || 0);
    const totalEarnings = Number(providerProfile?.totalEarnings || 0);
    const walletBalance = Number(providerProfile?.walletBalance || 0);
    const totalWithdrawn = Number(providerProfile?.totalWithdrawn || 0);
    const sellerLevel = String(providerProfile?.sellerLevel || "New");
    const completionRate = totalOrders > 0 ? Number(((completedOrders / totalOrders) * 100).toFixed(1)) : 0;

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const earningsMap = new Map(monthlyEarnings.map((entry) => [Number(entry._id), Number(entry.earnings || 0)]));
    const earningsAnalytics = monthNames.map((name, index) => ({
      name,
      earnings: earningsMap.get(index + 1) || 0,
    }));

    return res.status(200).json({
      success: true,
      message: "Provider dashboard summary fetched successfully.",
      data: {
        revenue: {
          totalEarnings,
          walletBalance,
          totalWithdrawn,
        },
        sellerLevel,
        orders: {
          totalOrders,
          pendingOrders,
          activeOrders,
          completedOrders,
          completionRate,
        },
        ratings: {
          averageRating,
          reviewCount,
        },
        earningsAnalytics,
      pendingRequests: pendingRequestDocs.map(buildDashboardRequestCard).filter(Boolean),
    },
  });
  } catch (error) {
    return next(error);
  }
};

const getProviderRevenueHistory = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view revenue history.",
      });
    }

    const page = parsePage(req.query.page, 1);
    const limit = Math.min(20, parsePage(req.query.limit, 8));
    const skip = (page - 1) * limit;
    const query = {
      providerId: req.user.id,
      status: "completed",
      paymentStatus: "paid",
    };

    const [orders, totalItems, totals] = await Promise.all([
      Order.find(query)
        .populate("gigId", "_id title categoryName images")
        .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
        .populate("providerId", "_id firstName lastName email phone address avatar")
        .sort({ paidAt: -1, completedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
      Order.aggregate([
        { $match: { providerId: new mongoose.Types.ObjectId(String(req.user.id)), status: "completed", paymentStatus: "paid" } },
        {
          $group: {
            _id: null,
            totalEarnings: { $sum: "$providerEarningsAmount" },
            totalPaid: { $sum: "$paymentAmount" },
            totalPlatformFees: { $sum: "$platformFeeAmount" },
          },
        },
      ]),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const safePage = Math.min(page, totalPages);
    const summary = totals[0] || {};

    return res.status(200).json({
      success: true,
      message: "Provider revenue history fetched successfully.",
      data: {
        items: orders.map(buildOrderSummary),
        summary: {
          totalEarnings: roundMoney(summary.totalEarnings || 0),
          totalPaid: roundMoney(summary.totalPaid || 0),
          totalPlatformFees: roundMoney(summary.totalPlatformFees || 0),
          paidOrders: totalItems,
        },
        pagination: {
          page: safePage,
          limit,
          totalItems,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getProviderRatings = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view ratings.",
      });
    }

    const page = parsePage(req.query.page, 1);
    const limit = Math.min(20, parsePage(req.query.limit, 8));
    const skip = (page - 1) * limit;
    const query = {
      providerId: req.user.id,
      status: "completed",
      paymentStatus: "paid",
      clientRating: { $ne: null },
    };

    const [orders, totalItems, stats] = await Promise.all([
      Order.find(query)
        .populate("gigId", "_id title categoryName images")
        .populate("clientId", "_id firstName lastName email phone address avatar locationLat locationLng")
        .populate("providerId", "_id firstName lastName email phone address avatar")
        .sort({ completedAt: -1, paidAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
      Order.aggregate([
        {
          $match: {
            providerId: new mongoose.Types.ObjectId(String(req.user.id)),
            status: "completed",
            paymentStatus: "paid",
            clientRating: { $ne: null },
          },
        },
        {
          $group: {
            _id: null,
            averageRating: { $avg: "$clientRating" },
            reviewCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const safePage = Math.min(page, totalPages);
    const summary = stats[0] || {};

    return res.status(200).json({
      success: true,
      message: "Provider ratings fetched successfully.",
      data: {
        items: orders.map(buildOrderSummary),
        summary: {
          averageRating: Number((Number(summary.averageRating) || 0).toFixed(1)),
          reviewCount: Number(summary.reviewCount || 0),
        },
        pagination: {
          page: safePage,
          limit,
          totalItems,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getClientDashboard = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can view client dashboard data.",
      });
    }

    const clientId = req.user.id;
    const clientObjectId = new mongoose.Types.ObjectId(String(clientId));
    const activeStatuses = [
      "pending",
      "accepted",
      "accepting_delivery",
      "revision_requested",
      "under_revision",
      "after_sell_revision_requested",
      "under_after_sell_revision",
    ];
    const underReviewStatuses = [
      "revision_requested",
      "under_revision",
      "after_sell_revision_requested",
      "under_after_sell_revision",
    ];
    const inProgressStatuses = ["accepted", "accepting_delivery"];

    const [
      totalOrders,
      pendingOrders,
      inProgressOrders,
      underReviewOrders,
      completedOrders,
      recentOrderDocs,
      unreadMessageStats,
    ] = await Promise.all([
      Order.countDocuments({ clientId }),
      Order.countDocuments({ clientId, status: "pending" }),
      Order.countDocuments({ clientId, status: { $in: inProgressStatuses } }),
      Order.countDocuments({ clientId, status: { $in: underReviewStatuses } }),
      Order.countDocuments({ clientId, status: "completed" }),
      Order.find({ clientId })
        .populate("gigId", "_id title categoryName images")
        .populate("providerId", "_id firstName lastName avatar")
        .sort({ createdAt: -1 })
        .limit(3)
        .lean(),
      Message.aggregate([
        {
          $match: {
            receiverId: clientObjectId,
            readAt: null,
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "senderId",
            foreignField: "_id",
            as: "sender",
          },
        },
        { $unwind: "$sender" },
        {
          $match: {
            "sender.role": "provider",
          },
        },
        {
          $group: {
            _id: "$conversationId",
          },
        },
        {
          $count: "count",
        },
      ]),
    ]);

    const activeOrders = pendingOrders + inProgressOrders + underReviewOrders;
    const completedRate = totalOrders > 0 ? Number(((completedOrders / totalOrders) * 100).toFixed(1)) : 0;
    const inboxCount = Number(unreadMessageStats?.[0]?.count || 0);

    const recentOrders = recentOrderDocs.map((order) => {
      const summary = buildOrderSummary(order);
      const providerName = summary?.provider?.name || "Provider";
      const providerAvatar = summary?.provider?.avatar || "";
      const totalAmount = Number(summary?.paymentAmount || 0) || Number(summary?.packagePrice || 0);
      const timeLabel = summary?.scheduledDate
        ? new Date(summary.scheduledDate).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";

      return {
        id: summary?.id || String(order._id),
        orderNumber: summary?.orderNumber || "",
        orderName: summary?.orderName || "Service order",
        categoryName: summary?.categoryName || "General",
        status: summary?.status || "pending",
        statusLabel: formatOrderStatusLabel(summary?.status),
        amount: totalAmount,
        provider: {
          id: summary?.provider?.id || "",
          name: providerName,
          avatar: providerAvatar,
        },
        location: String(summary?.serviceAddress || summary?.client?.address || "Location not set"),
        scheduledDate: summary?.scheduledDate || null,
        scheduledTime: summary?.scheduledTime || "",
        scheduledLabel: timeLabel,
        conversationId: summary?.conversationId || null,
        paymentStatus: summary?.paymentStatus || "unpaid",
      };
    });

    return res.status(200).json({
      success: true,
      message: "Client dashboard summary fetched successfully.",
      data: {
        orders: {
          totalOrders,
          activeOrders,
          pendingOrders,
          inProgressOrders,
          underReviewOrders,
          completedOrders,
          completionRate: completedRate,
        },
        inbox: {
          unreadMessages: inboxCount,
        },
        recentOrders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const submitClientOrderReview = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can submit order reviews.",
      });
    }

    const rating = Number(req.body.rating);
    const review = String(req.body.review || "").trim();
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Please select a rating between 1 and 5.",
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

    if (order.status !== "completed" || order.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "You can only review after payment is completed.",
      });
    }

    order.clientRating = rating;
    order.clientReview = review;
    await order.save();
    await refreshProviderPerformanceStats(order.providerId);

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "New client review",
      description: `You received a ${rating}-star review for ${order.gigId?.title || "your order"}.`,
      data: {
        notificationType: "order_review_submitted",
        orderId: order._id.toString(),
        targetPath: `/provider/orders/${order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Review submitted successfully.",
      data: {
        order: buildOrderSummary(order),
      },
    });
  } catch (error) {
    return next(error);
  }
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

const formatStripeFormData = (payload = {}) => {
  const formData = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    formData.append(key, String(value));
  });
  return formData;
};

const stripeRequest = async (path, payload) => {
  if (!STRIPE_SECRET_KEY) {
    throw new Error("Stripe secret key is not configured.");
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formatStripeFormData(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Stripe request failed.";
    throw new Error(message);
  }
  return data;
};

const stripeGetRequest = async (path) => {
  if (!STRIPE_SECRET_KEY) {
    throw new Error("Stripe secret key is not configured.");
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Stripe request failed.";
    throw new Error(message);
  }
  return data;
};

const finalizePaidOrder = async ({ order, session, clientRating = null, clientReview = "" }) => {
  if (!order) return null;

  const alreadyPaid = order.paymentStatus === "paid" && order.status === "completed";
  const baseAmount = roundMoney(order.packagePrice);
  const platformFeeAmount =
    Number(order.platformFeeAmount) > 0
      ? roundMoney(order.platformFeeAmount)
      : calculateAdminFeeAmount(baseAmount);
  const providerEarningsAmount =
    Number(order.providerEarningsAmount) > 0
      ? roundMoney(order.providerEarningsAmount)
      : baseAmount;
  const paymentAmount =
    Number(order.paymentAmount) > 0
      ? roundMoney(order.paymentAmount)
      : roundMoney(providerEarningsAmount + platformFeeAmount);

  if (!alreadyPaid) {
    order.paymentStatus = "paid";
    order.paymentProvider = "stripe";
    order.stripeCheckoutSessionId = session?.id || order.stripeCheckoutSessionId || "";
    order.stripePaymentIntentId = String(session?.payment_intent?.id || session?.payment_intent || order.stripePaymentIntentId || "");
    order.paymentCurrency = String(session?.currency || order.paymentCurrency || "usd");
    order.paymentAmount = paymentAmount;
    order.platformFeeAmount = platformFeeAmount;
    order.providerEarningsAmount = providerEarningsAmount;
    order.paidAt = new Date();
    order.status = "completed";
    order.completedAt = new Date();
    if (Number.isFinite(Number(clientRating)) && Number(clientRating) > 0) {
      order.clientRating = Number(clientRating);
    }
    if (String(clientReview || "").trim()) {
      order.clientReview = String(clientReview).trim();
    }
    ensureOrderNumber(order);
    await order.save();

    await User.findByIdAndUpdate(order.providerId, {
      $inc: {
        walletBalance: providerEarningsAmount,
        totalEarnings: providerEarningsAmount,
      },
    });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "Payment received",
      description: `Client paid for ${order.gigId?.title || "your order"}. Your full package earnings have been credited.`,
      data: {
        notificationType: "order_paid",
        orderId: order._id.toString(),
        providerEarningsAmount,
        platformFeeAmount,
        targetPath: `/provider/orders/${order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    emitToUser(String(order.clientId), "notification:new", {
      id: `NTF-${Date.now()}-client`,
      type: "success",
      title: "Payment completed",
      description: `Your payment for ${order.gigId?.title || "the order"} was successful.`,
      data: {
        notificationType: "order_payment_completed",
        orderId: order._id.toString(),
        targetPath: `/client/orders/${order.orderNumber || order._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    order,
    providerEarningsAmount,
    platformFeeAmount,
    alreadyPaid,
  };
};

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
      .select("_id title providerId categoryName baseCity locationLat locationLng travelRadiusKm packages")
      .lean();

    if (!gig || String(gig.providerId) === String(req.user.id)) {
      return res.status(404).json({
        success: false,
        message: "Service not found for booking.",
      });
    }

    const normalizedPackageName = String(packageName).trim().toLowerCase();
    const selectedGigPackage = Array.isArray(gig?.packages)
      ? gig.packages.find((item) => String(item?.name || "").trim().toLowerCase() === normalizedPackageName)
      : null;
    const basePackagePrice = Number(selectedGigPackage?.price);
    if (!selectedGigPackage || !Number.isFinite(basePackagePrice) || basePackagePrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Selected package is invalid for this gig.",
      });
    }

    const pricing = buildPackagePricing(basePackagePrice);

    const [clientProfile, providerProfile] = await Promise.all([
      User.findById(req.user.id).select("_id address locationLat locationLng").lean(),
      User.findById(gig.providerId).select("_id locationLat locationLng serviceLocationLat serviceLocationLng").lean(),
    ]);
    const clientAddressSnapshot =
      String(clientProfile?.address || "").trim() ||
      (await resolveAddressFromCoordinates(clientProfile?.locationLat, clientProfile?.locationLng));
    const providerPoint =
      normalizePoint(gig?.locationLat, gig?.locationLng) ||
      normalizePoint(providerProfile?.serviceLocationLat, providerProfile?.serviceLocationLng) ||
      normalizePoint(providerProfile?.locationLat, providerProfile?.locationLng);
    const clientPoint =
      (await geocodeAddress(clientAddressSnapshot)) ||
      normalizePoint(clientProfile?.locationLat, clientProfile?.locationLng);
    const providerTravelRadiusKm = Number(gig?.travelRadiusKm);
    const effectiveTravelRadiusKm =
      Number.isFinite(providerTravelRadiusKm) && providerTravelRadiusKm > 0 ? providerTravelRadiusKm : null;

    if (effectiveTravelRadiusKm !== null && (!providerPoint || !clientPoint)) {
      return res.status(400).json({
        success: false,
        message: "Client or provider location is missing for radius validation.",
      });
    }

    if (providerPoint && clientPoint && effectiveTravelRadiusKm !== null) {
      const distanceKm = calculateDistanceKm(
        providerPoint.lat,
        providerPoint.lng,
        clientPoint.lat,
        clientPoint.lng
      );

      if (typeof distanceKm === "number" && distanceKm > effectiveTravelRadiusKm) {
        return res.status(403).json({
          success: false,
          message: `You are outside this provider's ${(effectiveTravelRadiusKm / 1.60934).toFixed(1)} mile service radius.`,
        });
      }
    }

    const order = await Order.create({
      orderNumber: createOrderNumber(),
      gigId: gig._id,
      clientId: req.user.id,
      providerId: gig.providerId,
      packageName: String(packageName).trim(),
      packageTitle: String(selectedGigPackage?.title || packageTitle || packageName).trim(),
      categoryName: String(gig.categoryName || "").trim(),
      packagePrice: pricing.baseAmount,
      scheduledDate: new Date(scheduledDate),
      scheduledTime: String(scheduledTime).trim(),
      serviceAddress: String(serviceAddress).trim(),
      clientAddressSnapshot,
      specialInstructions: String(specialInstructions || "").trim(),
      requirementSubmittedAt: new Date(),
      status: "pending",
      paymentStatus: "unpaid",
      paymentProvider: "stripe",
      paymentAmount: pricing.clientPaymentAmount,
      platformFeeAmount: pricing.adminFeeAmount,
      providerEarningsAmount: pricing.baseAmount,
      paymentCurrency: "usd",
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
        if (status === "active") {
          query.status = {
            $in: [
              "accepted",
              "accepting_delivery",
              "revision_requested",
              "under_revision",
              "after_sell_revision_requested",
              "under_after_sell_revision",
            ],
          };
        } else if (status === "request_revision") {
          query.status = { $in: ["revision_requested", "after_sell_revision_requested"] };
        } else if (status === "under_revision") {
          query.status = { $in: ["under_revision", "under_after_sell_revision"] };
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
    const ordersWithRepeatCounts = await attachRepeatCounts(orders);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Provider orders fetched successfully.",
      data: {
        items: ordersWithRepeatCounts.map(buildOrderSummary),
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
        if (status === "active") {
          query.status = {
            $in: [
              "pending",
              "accepted",
              "accepting_delivery",
              "revision_requested",
              "under_revision",
              "after_sell_revision_requested",
              "under_after_sell_revision",
            ],
          };
        } else if (status === "payment_pending") {
          query.status = "accepting_delivery";
        } else if (status === "cancelled") {
          query.status = "declined";
        } else if (status === "request_revision") {
          query.status = { $in: ["revision_requested", "after_sell_revision_requested"] };
        } else if (status === "under_revision") {
          query.status = { $in: ["under_revision", "under_after_sell_revision"] };
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
    const ordersWithRepeatCounts = await attachRepeatCounts(orders);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Client orders fetched successfully.",
      data: {
        items: ordersWithRepeatCounts.map(buildOrderSummary),
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
      .populate("providerId", "_id firstName lastName email phone address avatar averageRating reviewCount")
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

    const [orderWithRepeatCount] = await attachRepeatCounts([{
      ...order,
      providerId: {
        ...(order.providerId || {}),
        completedOrders,
      },
    }]);

    const normalizedOrder = buildOrderSummary(orderWithRepeatCount);

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

    const [orderWithRepeatCount] = await attachRepeatCounts([order]);

    return res.status(200).json({
      success: true,
      message: "Order fetched successfully.",
      data: {
        order: buildOrderSummary(orderWithRepeatCount),
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

      if (!["accepted", "accepting_delivery", "under_revision", "under_after_sell_revision"].includes(order.status)) {
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
      order.status = order.status === "under_after_sell_revision" ? "completed" : "accepting_delivery";
      order.revisionResponseNote = "";
      if (order.status === "completed") {
        order.completedAt = new Date();
      }
      ensureOrderNumber(order);
      await order.save();
      if (order.status === "completed") {
        await refreshProviderPerformanceStats(order.providerId);
      }

      emitToUser(String(order.clientId), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "system",
        title: order.status === "completed" ? "After-sale revision completed" : "Delivery submitted",
        description: order.status === "completed"
          ? `Provider completed the after-sale revision for ${order.gigId?.title || "your order"}.`
          : `Provider submitted delivery for ${order.gigId?.title || "your order"}.`,
        data: {
          notificationType: order.status === "completed" ? "order_after_sell_revision_completed" : "order_delivery_submitted",
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

      const isAfterSellRevision = order.status === "completed" && order.paymentStatus === "paid";
      const isDeliveryRevision = order.status === "accepting_delivery";

      if (!isAfterSellRevision && !isDeliveryRevision) {
        return res.status(400).json({
          success: false,
          message: "Revision can only be requested after delivery submission or after payment completion.",
        });
      }

    const note = String(req.body.note || "").trim();
    if (!note) {
      return res.status(400).json({
        success: false,
        message: "Revision note is required.",
      });
    }

      order.status = isAfterSellRevision ? "after_sell_revision_requested" : "revision_requested";
      order.revisionRequestNote = note;
      order.revisionRequestedAt = new Date();
      order.revisionResponseNote = "";
      order.revisionRespondedAt = null;
      await order.save();

      const chat = await sendSystemOrderMessage({
        order,
        senderId: order.clientId,
        receiverId: order.providerId,
        text: `${isAfterSellRevision ? "After-sale revision requested" : "Revision requested"}: ${note}`,
      });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
        title: isAfterSellRevision ? "Client requested after-sale revision" : "Client requested revision",
        description: `Revision requested for ${order.gigId?.title || "an order"}.`,
        data: {
          notificationType: isAfterSellRevision ? "order_after_sell_revision_requested" : "order_revision_requested",
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

      if (!["revision_requested", "after_sell_revision_requested"].includes(order.status)) {
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

      const isAfterSellRevision = order.status === "after_sell_revision_requested";

      if (action === "accept") {
        order.status = isAfterSellRevision ? "under_after_sell_revision" : "under_revision";
        order.revisionResponseNote = note || "Provider accepted revision request.";
        order.revisionRespondedAt = new Date();
      } else {
        order.status = isAfterSellRevision ? "completed" : "accepting_delivery";
        order.revisionResponseNote = note || "Provider declined revision request.";
        order.revisionRespondedAt = new Date();
      }
    await order.save();

      const text =
        action === "accept"
          ? `${isAfterSellRevision ? "Provider accepted after-sale revision request." : "Provider accepted revision request."}${note ? ` Note: ${note}` : ""}`
          : `${isAfterSellRevision ? "Provider declined after-sale revision request." : "Provider declined revision request."}${note ? ` Note: ${note}` : ""}`;
    const chat = await sendSystemOrderMessage({
      order,
      senderId: order.providerId,
      receiverId: order.clientId,
      text,
    });

      emitToUser(String(order.clientId), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: action === "accept" ? "system" : "warning",
        title: action === "accept"
          ? (isAfterSellRevision ? "After-sale revision accepted" : "Revision accepted by provider")
          : (isAfterSellRevision ? "After-sale revision declined" : "Revision declined by provider"),
        description:
          action === "accept"
            ? `Provider is working on your revision for ${order.gigId?.title || "order"}.`
            : isAfterSellRevision
              ? `Provider declined after-sale revision for ${order.gigId?.title || "order"}.`
              : `Provider declined revision for ${order.gigId?.title || "order"}. You can continue with payment.`,
        data: {
          notificationType: action === "accept"
            ? (isAfterSellRevision ? "order_after_sell_revision_accepted" : "order_revision_accepted")
            : (isAfterSellRevision ? "order_after_sell_revision_declined" : "order_revision_declined"),
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

      if (!["revision_requested", "under_revision", "after_sell_revision_requested", "under_after_sell_revision"].includes(order.status)) {
        return res.status(400).json({
          success: false,
          message: "This order has no active revision request.",
        });
      }

      order.status = order.status === "after_sell_revision_requested" || order.status === "under_after_sell_revision"
        ? "completed"
        : "accepting_delivery";
      order.revisionResponseNote = "Client cancelled revision request.";
      order.revisionRespondedAt = new Date();
      await order.save();

      const chat = await sendSystemOrderMessage({
        order,
        senderId: order.clientId,
        receiverId: order.providerId,
        text:
          order.status === "completed"
            ? "Client cancelled after-sale revision request and order remains completed."
            : "Client cancelled revision request and moved back to delivery acceptance.",
      });

    emitToUser(String(order.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
        title: order.status === "completed" ? "After-sale revision cancelled" : "Revision request cancelled",
        description: order.status === "completed"
          ? "Client cancelled after-sale revision request. Order remains completed."
          : "Client cancelled revision request. Order is back to delivery acceptance.",
        data: {
          notificationType: order.status === "completed" ? "order_after_sell_revision_cancelled" : "order_revision_cancelled",
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

const createClientCheckoutSession = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can start checkout.",
      });
    }

    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Stripe is not configured on the server.",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      clientId: req.user.id,
    }).populate("gigId", "_id title categoryName");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.status !== "accepting_delivery") {
      return res.status(400).json({
        success: false,
        message: "Payment is only available when delivery is pending approval.",
      });
    }

    const amount = Math.max(Number(order.paymentAmount) || Number(order.packagePrice) || 0, 0);
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Order amount is invalid.",
      });
    }

    const metadata = {
      orderId: String(order._id),
      orderNumber: String(order.orderNumber || ""),
      clientId: String(order.clientId),
      providerId: String(order.providerId),
      packageTitle: String(order.packageTitle || ""),
      packageName: String(order.packageName || ""),
    };

    const { successUrl, cancelUrl } = resolveClientCheckoutRedirects(req, order);

    const session = await stripeRequest("/v1/checkout/sessions", {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(order._id),
      customer_email: req.user.email || undefined,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": `${order.gigId?.title || "Service order"} - ${order.packageTitle || order.packageName || "Package"}`,
      "line_items[0][price_data][unit_amount]": Math.round(amount * 100),
      "line_items[0][quantity]": 1,
      "metadata[orderId]": metadata.orderId,
      "metadata[orderNumber]": metadata.orderNumber,
      "metadata[clientId]": metadata.clientId,
      "metadata[providerId]": metadata.providerId,
      "metadata[packageTitle]": metadata.packageTitle,
      "metadata[packageName]": metadata.packageName,
    });

    order.paymentStatus = "pending";
    order.stripeCheckoutSessionId = session.id || "";
    order.paymentAmount = amount;
    order.paymentCurrency = "usd";
    await order.save({ validateBeforeSave: false });

    return res.status(200).json({
      success: true,
      message: "Checkout session created.",
      data: {
        checkoutUrl: session.url || "",
        sessionId: session.id || "",
      },
    });
  } catch (error) {
    return next(error);
  }
};

const confirmClientCheckoutPayment = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can confirm payments.",
      });
    }

    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Stripe is not configured on the server.",
      });
    }

    const sessionId = String(req.body.sessionId || req.query.sessionId || "").trim();
    const clientRating = req.body.clientRating !== undefined && req.body.clientRating !== null
      ? Number(req.body.clientRating)
      : null;
    const clientReview = String(req.body.clientReview || "").trim();
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Stripe session ID is required.",
      });
    }

    const session = await stripeGetRequest(`/v1/checkout/sessions/${sessionId}?expand[]=payment_intent`);
    if (session.payment_status !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Payment has not been completed yet.",
      });
    }

    const orderId = String(session?.metadata?.orderId || session?.client_reference_id || "");
    const order = await Order.findOne({
      _id: orderId,
      clientId: req.user.id,
    }).populate("gigId", "_id title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    if (order.paymentStatus === "paid" && order.status === "completed") {
      return res.status(200).json({
        success: true,
        message: "Payment already confirmed.",
        data: { order: buildOrderSummary(order) },
      });
    }
    const finalized = await finalizePaidOrder({
      order,
      session,
      clientRating,
      clientReview,
    });

    if (Number.isFinite(Number(clientRating)) && Number(clientRating) > 0) {
      await refreshProviderPerformanceStats(order.providerId);
    }

    return res.status(200).json({
      success: true,
      message: "Payment confirmed and order completed.",
      data: {
        order: buildOrderSummary(finalized?.order || order),
        providerEarningsAmount: finalized?.providerEarningsAmount || 0,
        platformFeeAmount: finalized?.platformFeeAmount || 0,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminTransactions = async (req, res, next) => {
  try {
    const page = parsePage(req.query.page, 1);
    const limit = Math.min(parsePage(req.query.limit, 10), 100);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const query = {};

    if (status === "completed") {
      query.paymentStatus = "paid";
    } else if (status === "pending") {
      query.paymentStatus = { $in: ["unpaid", "pending"] };
    } else if (status === "failed") {
      query.paymentStatus = "failed";
    }

    const searchRegex = search ? new RegExp(search, "i") : null;

    const [orders, totals, pendingWithdrawals] = await Promise.all([
      Order.find(query)
        .populate("clientId", "_id firstName lastName email")
        .populate("providerId", "_id firstName lastName email")
        .populate("gigId", "_id title categoryName")
        .sort({ paidAt: -1, createdAt: -1 })
        .lean(),
      Order.aggregate([
        {
          $match: {
            paymentStatus: "paid",
          },
        },
        {
          $group: {
            _id: null,
            totalAdminFees: { $sum: "$platformFeeAmount" },
            totalProviderEarnings: { $sum: "$providerEarningsAmount" },
            paidTransactions: { $sum: 1 },
          },
        },
      ]),
      WithdrawalRequest.aggregate([
        {
          $match: {
            status: { $in: ["pending", "approved"] },
          },
        },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amount" },
          },
        },
      ]),
    ]);

    const filteredItems = orders
      .map((order) => {
        const summary = buildOrderSummary(order);
        const paymentStatusLabel =
          summary?.paymentStatus === "paid"
            ? "Completed"
            : summary?.paymentStatus === "failed"
              ? "Failed"
              : "Pending";

        return {
          id: summary?.orderNumber || String(order._id),
          orderId: String(order._id),
          user: summary?.client?.name || "Client",
          provider: summary?.provider?.name || "Provider",
          service: summary?.orderName || summary?.gig?.title || "Service order",
          amount: roundMoney(summary?.platformFeeAmount || 0),
          totalPaid: roundMoney(summary?.paymentAmount || 0),
          providerEarnings: roundMoney(summary?.providerEarningsAmount || summary?.packagePrice || 0),
          date: summary?.paidAt || summary?.createdAt || null,
          timestamp: new Date(summary?.paidAt || summary?.createdAt || 0).getTime(),
          status: paymentStatusLabel,
          method: String(summary?.paymentProvider || "stripe").toUpperCase(),
        };
      })
      .filter((item) => {
        if (!searchRegex) return true;
        return (
          searchRegex.test(item.id) ||
          searchRegex.test(item.user) ||
          searchRegex.test(item.provider) ||
          searchRegex.test(item.service)
        );
      });

    const totalItems = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const safePage = Math.min(page, totalPages);
    const startIndex = (safePage - 1) * limit;
    const items = filteredItems.slice(startIndex, startIndex + limit);
    const totalsSummary = totals[0] || {};
    const pendingWithdrawalAmount = Number(pendingWithdrawals?.[0]?.totalAmount || 0);

    return res.status(200).json({
      success: true,
      message: "Admin transactions fetched successfully.",
      data: {
        items,
        summary: {
          totalAdminFees: roundMoney(totalsSummary.totalAdminFees || 0),
          totalProviderEarnings: roundMoney(totalsSummary.totalProviderEarnings || 0),
          paidTransactions: Number(totalsSummary.paidTransactions || 0),
          pendingPayouts: roundMoney(pendingWithdrawalAmount),
        },
        pagination: {
          page: safePage,
          limit,
          totalItems,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

const handleStripeWebhook = async (req, res) => {
  try {
    const signature = String(req.headers["stripe-signature"] || "");
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

    if (!webhookSecret) {
      return res.status(500).json({ success: false, message: "Stripe webhook secret is not configured." });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const parts = signature.split(",").reduce((acc, item) => {
      const [key, value] = item.split("=");
      if (key && value) acc[key.trim()] = value.trim();
      return acc;
    }, {});
    const timestamp = parts.t;
    const v1 = parts.v1;

    if (!timestamp || !v1) {
      return res.status(400).json({ success: false, message: "Invalid Stripe signature." });
    }

    const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
    const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const providedBuffer = Buffer.from(v1, "hex");

    if (expectedBuffer.length !== providedBuffer.length) {
      return res.status(400).json({ success: false, message: "Stripe webhook signature verification failed." });
    }

    const isValid = crypto.timingSafeEqual(expectedBuffer, providedBuffer);

    if (!isValid) {
      return res.status(400).json({ success: false, message: "Stripe webhook signature verification failed." });
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      if (session.payment_status === "paid") {
        const orderId = String(session?.metadata?.orderId || session?.client_reference_id || "");
        const order = await Order.findOne({
          $or: [
            { _id: orderId },
            { stripeCheckoutSessionId: session.id },
          ],
        }).populate("gigId", "_id title");

        if (order) {
          await finalizePaidOrder({ order, session });
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error.message);
    return res.status(500).json({ success: false, message: "Webhook processing failed." });
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
    await refreshProviderPerformanceStats(order.providerId);

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
  getAdminDashboard,
  getAdminOrderDetail,
  listProviderOrders,
  getProviderDashboard,
  getProviderRevenueHistory,
  getProviderRatings,
  getClientDashboard,
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
  getAdminTransactions,
  createClientCheckoutSession,
  confirmClientCheckoutPayment,
  submitClientOrderReview,
  handleStripeWebhook,
  finalizeClientOrder,
};
