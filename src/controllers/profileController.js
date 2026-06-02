const mongoose = require("mongoose");
const User = require("../models/User");
const Gig = require("../models/Gig");
const Order = require("../models/Order");
const cloudinary = require("../config/cloudinary");
const bcrypt = require("bcryptjs");
const { emitToRole, emitToUser, isUserOnline } = require("../socket");

const PAYOUT_STATUS = {
  UNVERIFIED: "unverified",
  PENDING: "pending",
  VERIFIED: "verified",
  REJECTED: "rejected",
};

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));
const calculateClientPrice = (baseAmount) => roundMoney(Number(baseAmount) || 0);

const serializeUser = (userDoc) => {
  return {
    id: userDoc._id,
    firstName: userDoc.firstName,
    lastName: userDoc.lastName,
    email: userDoc.email,
    role: userDoc.role,
    avatar: userDoc.avatar,
    phone: userDoc.phone || "",
    address: userDoc.address || "",
    preferredLanguage: userDoc.preferredLanguage || "English (US)",
    locationLat: typeof userDoc.locationLat === "number" ? userDoc.locationLat : null,
    locationLng: typeof userDoc.locationLng === "number" ? userDoc.locationLng : null,
    businessBio: userDoc.businessBio || "",
    experienceLevel: userDoc.experienceLevel || "",
    serviceCity: userDoc.serviceCity || "",
    serviceLocationLat: typeof userDoc.serviceLocationLat === "number" ? userDoc.serviceLocationLat : null,
    serviceLocationLng: typeof userDoc.serviceLocationLng === "number" ? userDoc.serviceLocationLng : null,
    payoutVerificationStatus: userDoc.payoutVerificationStatus || PAYOUT_STATUS.UNVERIFIED,
    walletBalance: Number(userDoc.walletBalance) || 0,
    totalEarnings: Number(userDoc.totalEarnings) || 0,
    totalWithdrawn: Number(userDoc.totalWithdrawn) || 0,
    averageRating: Number(userDoc.averageRating) || 0,
    reviewCount: Number(userDoc.reviewCount) || 0,
    sellerLevel: userDoc.sellerLevel || "New",
    savedServiceIds: Array.isArray(userDoc.savedServiceIds)
      ? userDoc.savedServiceIds.map((item) => String(item))
      : [],
    payoutInfo: {
      accountHolderName: userDoc?.payoutInfo?.accountHolderName || "",
      bankAccountNumber: userDoc?.payoutInfo?.bankAccountNumber || "",
      routingNumber: userDoc?.payoutInfo?.routingNumber || "",
      bankName: userDoc?.payoutInfo?.bankName || "",
      accountType: userDoc?.payoutInfo?.accountType || "",
      nidFrontImageUrl: userDoc?.payoutInfo?.nidFrontImageUrl || "",
      nidBackImageUrl: userDoc?.payoutInfo?.nidBackImageUrl || "",
      submittedAt: userDoc?.payoutInfo?.submittedAt || null,
      reviewedAt: userDoc?.payoutInfo?.reviewedAt || null,
      rejectionReason: userDoc?.payoutInfo?.rejectionReason || "",
    },
  };
};

const buildSavedServiceCard = (gigDoc) => {
  if (!gigDoc) return null;
  const provider = gigDoc.providerId || {};
  const packages = Array.isArray(gigDoc.packages) ? gigDoc.packages : [];
  const validPrices = packages
    .map((item) => calculateClientPrice(item?.price))
    .filter((price) => price > 0);
  const startingPrice = validPrices.length ? roundMoney(Math.min(...validPrices)) : 0;
  const avgPackagePrice = validPrices.length
    ? roundMoney(validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length)
    : 0;

  return {
    id: String(gigDoc._id),
    title: gigDoc.title || "",
    categoryName: gigDoc.categoryName || "",
    categorySlug: gigDoc.categorySlug || "",
    images: Array.isArray(gigDoc.images) ? gigDoc.images : [],
    videos: Array.isArray(gigDoc.videos) ? gigDoc.videos : [],
    baseCity: gigDoc.baseCity || "",
    startingPrice,
    avgPackagePrice,
    provider: {
      id: provider._id ? String(provider._id) : "",
      name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || "Provider",
      avatar: provider.avatar || "",
      rating: Number(provider.averageRating) || 0,
      sellerLevel: provider.sellerLevel || "New",
      level: provider.sellerLevel || "New",
    },
  };
};

const getPublicProviderLocation = (providerDoc = {}) => {
  const serviceCity = String(providerDoc?.serviceCity || "").trim();
  if (serviceCity) return serviceCity;

  const address = String(providerDoc?.address || "").trim();
  if (address) return address;

  const lat = typeof providerDoc?.serviceLocationLat === "number" ? providerDoc.serviceLocationLat : null;
  const lng = typeof providerDoc?.serviceLocationLng === "number" ? providerDoc.serviceLocationLng : null;
  if (lat !== null && lng !== null) {
    return `Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}`;
  }

  return "Location unavailable";
};

const mapAdminPresenceStatus = (userId) => (isUserOnline(userId) ? "active" : "inactive");

const mapProviderVerificationStatus = (userDoc = {}) => {
  const verificationStatus = String(userDoc?.payoutVerificationStatus || "").toLowerCase();
  if (verificationStatus === PAYOUT_STATUS.VERIFIED) return "verified";
  if (verificationStatus === PAYOUT_STATUS.REJECTED) return "disable";
  return "pending";
};

const formatAdminLocation = (userDoc = {}) => {
  const address = String(userDoc?.address || "").trim();
  if (address) return address;

  const serviceCity = String(userDoc?.serviceCity || "").trim();
  if (serviceCity) return serviceCity;

  const lat = typeof userDoc?.locationLat === "number" ? userDoc.locationLat : null;
  const lng = typeof userDoc?.locationLng === "number" ? userDoc.locationLng : null;
  if (lat !== null && lng !== null) {
    return `Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}`;
  }

  return "Location unavailable";
};

const splitAdminName = (name = "") => {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  const parts = cleanName.split(" ").filter(Boolean);
  if (parts.length <= 1) {
    return {
      firstName: parts[0] || "Admin",
      lastName: "",
    };
  }

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
};

const serializeAdminAccount = (userDoc = {}) => ({
  id: String(userDoc._id || ""),
  name: `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || userDoc.email || "Admin",
  firstName: userDoc.firstName || "",
  lastName: userDoc.lastName || "",
  email: userDoc.email || "",
  avatar: userDoc.avatar || "",
  role: userDoc.role || "admin",
  createdAt: userDoc.createdAt || null,
  updatedAt: userDoc.updatedAt || null,
});

const normalizeAdminEmailName = (name = "") => {
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/@admin\.com$/i, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

  return normalized || "admin";
};

const getPublicProviderProfile = async (req, res, next) => {
  try {
    const { providerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(providerId)) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    const provider = await User.findOne({ _id: providerId, role: "provider" })
      .select(
        "_id firstName lastName email avatar phone address businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng averageRating reviewCount sellerLevel createdAt"
      )
      .lean();

    if (!provider) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    const [gigDocs, reviewDocs, orderStats] = await Promise.all([
      Gig.find({ providerId, status: "published" })
        .sort({ publishedAt: -1, createdAt: -1 })
        .lean(),
      Order.find({
        providerId,
        status: "completed",
        paymentStatus: "paid",
        clientRating: { $ne: null },
      })
        .populate("clientId", "_id firstName lastName avatar")
        .populate("gigId", "_id title categoryName")
        .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      Order.find({ providerId }).select("_id status scheduledDate completedAt createdAt").lean(),
    ]);

    const gigs = gigDocs.map((gig) => {
      const packages = Array.isArray(gig.packages) ? gig.packages : [];
      const validPrices = packages
        .map((item) => Number(item?.price) || 0)
        .filter((price) => price > 0);
      const startingPrice = validPrices.length
        ? Number(Math.min(...validPrices).toFixed(2))
        : 0;
      const avgPackagePrice = validPrices.length
        ? Number((validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length).toFixed(2))
        : 0;

      return {
        id: gig._id,
        title: gig.title || "",
        categoryName: gig.categoryName || "",
        categorySlug: gig.categorySlug || "",
        expertType: gig.expertType === "team" ? "team" : "solo",
        images: Array.isArray(gig.images) ? gig.images : [],
        videos: Array.isArray(gig.videos) ? gig.videos : [],
        startingPrice,
        avgPackagePrice,
        provider: {
          id: provider._id,
          name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || "Provider",
          avatar: provider.avatar || "",
          rating: Number(provider.averageRating) || 0,
          sellerLevel: provider.sellerLevel || "New",
          level: provider.sellerLevel || "New",
        },
      };
    });

    const reviews = reviewDocs.map((order) => {
      const client = order.clientId || {};
      return {
        id: order._id,
        orderId: order._id,
        gigId: order.gigId?._id || null,
        gigName: order.gigId?.title || order.gigId?.categoryName || "Service order",
        rating: Number(order.clientRating) || 0,
        review: order.clientReview || "",
        createdAt: order.completedAt || order.updatedAt || order.createdAt || null,
        client: {
          id: client._id || "",
          name: `${client.firstName || ""} ${client.lastName || ""}`.trim() || "Client",
          avatar: client.avatar || "",
        },
      };
    });

    const totalOrders = orderStats.length;
    const completedOrders = orderStats.filter((order) => String(order.status || "") === "completed" && order.completedAt).length;
    const respondedOrders = orderStats.filter((order) =>
      [
        "accepted",
        "accepting_delivery",
        "revision_requested",
        "under_revision",
        "after_sell_revision_requested",
        "under_after_sell_revision",
        "done_after_sell_revision",
        "completed",
        "declined",
      ].includes(String(order.status || ""))
    ).length;
    const onTimeCompletedOrders = orderStats.filter((order) => {
      if (String(order.status || "") !== "completed" || !order.completedAt || !order.scheduledDate) {
        return false;
      }
      const completedAt = new Date(order.completedAt).getTime();
      const scheduledDate = new Date(order.scheduledDate).getTime();
      return Number.isFinite(completedAt) && Number.isFinite(scheduledDate) && completedAt <= scheduledDate;
    }).length;

    const completionRate = totalOrders > 0 ? Number(((completedOrders / totalOrders) * 100).toFixed(1)) : 0;
    const responseRate = totalOrders > 0 ? Number(((respondedOrders / totalOrders) * 100).toFixed(1)) : 0;
    const deliveredOnTimeRate = completedOrders > 0 ? Number(((onTimeCompletedOrders / completedOrders) * 100).toFixed(1)) : 0;
    const recommendRate = completionRate;
    const providerName = `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || "Provider";
    const providerLocation = getPublicProviderLocation(provider);
    const experienceLevel = String(provider.experienceLevel || "").trim();
    const sellerLevel = String(provider.sellerLevel || "New");
    const averageRating = Number(provider.averageRating) || 0;
    const reviewCount = Number(provider.reviewCount) || 0;

    return res.status(200).json({
      success: true,
      message: "Provider public profile fetched successfully.",
      data: {
        provider: {
          id: provider._id,
          name: providerName,
          firstName: provider.firstName || "",
          lastName: provider.lastName || "",
          avatar: provider.avatar || "",
          email: provider.email || "",
          phone: provider.phone || "",
          address: provider.address || "",
          bio: provider.businessBio || "",
          experienceLevel,
          sellerLevel,
          level: sellerLevel,
          rating: averageRating,
          reviewCount,
          completedOrders,
          totalOrders,
          completionRate,
          recommendRate,
          location: providerLocation,
          joinedAt: provider.createdAt || null,
        },
        gigs,
        reviews,
        performance: {
          responseRate,
          deliveredOnTime: deliveredOnTimeRate,
          orderCompletion: completionRate,
        },
        skills: [...new Set(gigs.map((gig) => gig.categoryName).filter(Boolean))],
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listAdminCustomers = async (req, res, next) => {
  try {
    const customers = await User.find({ role: "client" })
      .select("_id firstName lastName email avatar address phone locationLat locationLng createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const customerIds = customers.map((item) => item._id);
    const orderStats = await Order.aggregate([
      {
        $match: {
          clientId: { $in: customerIds },
        },
      },
      {
        $group: {
          _id: "$clientId",
          totalOrders: { $sum: 1 },
          totalSpent: {
            $sum: {
              $cond: [{ $eq: ["$paymentStatus", "paid"] }, { $ifNull: ["$paymentAmount", 0] }, 0],
            },
          },
        },
      },
    ]);

    const orderStatsMap = new Map(orderStats.map((item) => [String(item._id), item]));
    const data = customers.map((customer) => {
      const stats = orderStatsMap.get(String(customer._id));
      return {
        id: String(customer._id),
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.email || "Customer",
        firstName: customer.firstName || "",
        lastName: customer.lastName || "",
        email: customer.email || "",
        avatar: customer.avatar || "",
        phone: customer.phone || "",
        location: formatAdminLocation(customer),
        totalSpent: roundMoney(stats?.totalSpent || 0),
        totalOrders: Number(stats?.totalOrders || 0),
        status: mapAdminPresenceStatus(customer._id),
        joinedAt: customer.createdAt || null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Admin customers fetched successfully.",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminCustomerDetails = async (req, res, next) => {
  try {
    const { customerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(404).json({
        success: false,
        message: "Customer not found.",
      });
    }

    const customer = await User.findOne({ _id: customerId, role: "client" })
      .select("_id firstName lastName email avatar address phone locationLat locationLng preferredLanguage savedServiceIds createdAt")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found.",
      });
    }

    const orders = await Order.find({ clientId: customerId })
      .populate("providerId", "_id firstName lastName avatar email")
      .populate("gigId", "_id title categoryName")
      .sort({ createdAt: -1 })
      .lean();

    const totalSpent = roundMoney(
      orders.reduce((sum, order) => {
        if (String(order.paymentStatus || "") !== "paid") return sum;
        return sum + (Number(order.paymentAmount) || 0);
      }, 0)
    );

    const formattedOrders = orders.map((order) => ({
      id: String(order._id),
      orderNumber: order.orderNumber || "",
      service: order.packageTitle || order.gigId?.title || order.categoryName || "Service order",
      categoryName: order.categoryName || order.gigId?.categoryName || "",
      provider: {
        id: order.providerId?._id ? String(order.providerId._id) : "",
        name:
          `${order.providerId?.firstName || ""} ${order.providerId?.lastName || ""}`.trim() ||
          order.providerId?.email ||
          "Provider",
        avatar: order.providerId?.avatar || "",
        email: order.providerId?.email || "",
      },
      amount: roundMoney(order.paymentAmount || 0),
      paymentStatus: order.paymentStatus || "",
      status: order.status || "",
      serviceAddress: order.serviceAddress || "",
      scheduledDate: order.scheduledDate || null,
      scheduledTime: order.scheduledTime || "",
      createdAt: order.createdAt || null,
    }));

    return res.status(200).json({
      success: true,
      message: "Admin customer details fetched successfully.",
      data: {
        customer: {
          id: String(customer._id),
          name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.email || "Customer",
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          email: customer.email || "",
          avatar: customer.avatar || "",
          phone: customer.phone || "",
          location: formatAdminLocation(customer),
          address: customer.address || "",
          preferredLanguage: customer.preferredLanguage || "English (US)",
          savedServicesCount: Array.isArray(customer.savedServiceIds) ? customer.savedServiceIds.length : 0,
          totalOrders: formattedOrders.length,
          totalSpent,
          status: mapAdminPresenceStatus(customer._id),
          joinedAt: customer.createdAt || null,
          locationLat: typeof customer.locationLat === "number" ? customer.locationLat : null,
          locationLng: typeof customer.locationLng === "number" ? customer.locationLng : null,
        },
        orders: formattedOrders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listAdminProviders = async (req, res, next) => {
  try {
    const providers = await User.find({ role: "provider" })
      .select(
        "_id firstName lastName email avatar address phone serviceCity locationLat locationLng serviceLocationLat serviceLocationLng averageRating payoutVerificationStatus createdAt"
      )
      .sort({ createdAt: -1 })
      .lean();

    const providerIds = providers.map((item) => item._id);
    const gigs = await Gig.find({ providerId: { $in: providerIds } })
      .select("providerId categoryName categorySlug status")
      .lean();

    const categoriesByProviderId = new Map();
    gigs.forEach((gig) => {
      const key = String(gig.providerId);
      const next = categoriesByProviderId.get(key) || new Set();
      if (gig.categoryName) {
        next.add(String(gig.categoryName));
      } else if (gig.categorySlug) {
        next.add(String(gig.categorySlug));
      }
      categoriesByProviderId.set(key, next);
    });

    const data = providers.map((provider) => ({
      id: String(provider._id),
      name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || provider.email || "Provider",
      firstName: provider.firstName || "",
      lastName: provider.lastName || "",
      email: provider.email || "",
      avatar: provider.avatar || "",
      phone: provider.phone || "",
      location: formatAdminLocation(provider),
      categories: Array.from(categoriesByProviderId.get(String(provider._id)) || []),
      status: mapProviderVerificationStatus(provider),
      rating: Number(provider.averageRating) || 0,
      joinedAt: provider.createdAt || null,
      onlineStatus: mapAdminPresenceStatus(provider._id),
    }));

    return res.status(200).json({
      success: true,
      message: "Admin providers fetched successfully.",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminProviderDetails = async (req, res, next) => {
  try {
    const { providerId } = req.params;

    req.params.providerId = providerId;

    const provider = await User.findOne({ _id: providerId, role: "provider" })
      .select(
        "_id firstName lastName email avatar phone address businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng locationLat locationLng averageRating reviewCount sellerLevel createdAt payoutVerificationStatus totalEarnings totalWithdrawn walletBalance"
      )
      .lean();

    if (!provider) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    const [gigDocs, reviewDocs, orderStats] = await Promise.all([
      Gig.find({ providerId })
        .sort({ publishedAt: -1, createdAt: -1 })
        .lean(),
      Order.find({
        providerId,
        status: "completed",
        paymentStatus: "paid",
        clientRating: { $ne: null },
      })
        .populate("clientId", "_id firstName lastName avatar")
        .populate("gigId", "_id title categoryName")
        .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      Order.find({ providerId }).select("_id status scheduledDate completedAt createdAt").lean(),
    ]);

    const gigs = gigDocs.map((gig) => {
      const packages = Array.isArray(gig.packages) ? gig.packages : [];
      const validPrices = packages
        .map((item) => Number(item?.price) || 0)
        .filter((price) => price > 0);
      return {
        id: String(gig._id),
        title: gig.title || "",
        categoryName: gig.categoryName || "",
        categorySlug: gig.categorySlug || "",
        status: gig.status || "",
        images: Array.isArray(gig.images) ? gig.images : [],
        videos: Array.isArray(gig.videos) ? gig.videos : [],
        startingPrice: validPrices.length ? Number(Math.min(...validPrices).toFixed(2)) : 0,
        avgPackagePrice: validPrices.length
          ? Number((validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length).toFixed(2))
          : 0,
      };
    });

    const reviews = reviewDocs.map((order) => ({
      id: String(order._id),
      gigName: order.gigId?.title || order.gigId?.categoryName || "Service order",
      rating: Number(order.clientRating) || 0,
      review: order.clientReview || "",
      createdAt: order.completedAt || order.updatedAt || order.createdAt || null,
      client: {
        id: order.clientId?._id ? String(order.clientId._id) : "",
        name: `${order.clientId?.firstName || ""} ${order.clientId?.lastName || ""}`.trim() || "Client",
        avatar: order.clientId?.avatar || "",
      },
    }));

    const totalOrders = orderStats.length;
    const completedOrders = orderStats.filter((order) => String(order.status || "") === "completed" && order.completedAt).length;
    const respondedOrders = orderStats.filter((order) =>
      [
        "accepted",
        "accepting_delivery",
        "revision_requested",
        "under_revision",
        "after_sell_revision_requested",
        "under_after_sell_revision",
        "done_after_sell_revision",
        "completed",
        "declined",
      ].includes(String(order.status || ""))
    ).length;
    const onTimeCompletedOrders = orderStats.filter((order) => {
      if (String(order.status || "") !== "completed" || !order.completedAt || !order.scheduledDate) return false;
      const completedAt = new Date(order.completedAt).getTime();
      const scheduledDate = new Date(order.scheduledDate).getTime();
      return Number.isFinite(completedAt) && Number.isFinite(scheduledDate) && completedAt <= scheduledDate;
    }).length;

    const completionRate = totalOrders > 0 ? Number(((completedOrders / totalOrders) * 100).toFixed(1)) : 0;
    const responseRate = totalOrders > 0 ? Number(((respondedOrders / totalOrders) * 100).toFixed(1)) : 0;
    const deliveredOnTime = completedOrders > 0 ? Number(((onTimeCompletedOrders / completedOrders) * 100).toFixed(1)) : 0;

    return res.status(200).json({
      success: true,
      message: "Admin provider details fetched successfully.",
      data: {
        provider: {
          id: String(provider._id),
          name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || provider.email || "Provider",
          firstName: provider.firstName || "",
          lastName: provider.lastName || "",
          email: provider.email || "",
          avatar: provider.avatar || "",
          phone: provider.phone || "",
          address: provider.address || "",
          bio: provider.businessBio || "",
          experienceLevel: provider.experienceLevel || "",
          sellerLevel: provider.sellerLevel || "New",
          rating: Number(provider.averageRating) || 0,
          reviewCount: Number(provider.reviewCount) || 0,
          totalOrders,
          completedOrders,
          completionRate,
          location: getPublicProviderLocation(provider),
          joinedAt: provider.createdAt || null,
          status: mapProviderVerificationStatus(provider),
          onlineStatus: mapAdminPresenceStatus(provider._id),
          walletBalance: roundMoney(provider.walletBalance || 0),
          totalEarnings: roundMoney(provider.totalEarnings || 0),
          totalWithdrawn: roundMoney(provider.totalWithdrawn || 0),
          locationLat: typeof provider.locationLat === "number" ? provider.locationLat : null,
          locationLng: typeof provider.locationLng === "number" ? provider.locationLng : null,
          serviceLocationLat: typeof provider.serviceLocationLat === "number" ? provider.serviceLocationLat : null,
          serviceLocationLng: typeof provider.serviceLocationLng === "number" ? provider.serviceLocationLng : null,
        },
        gigs,
        reviews,
        performance: {
          responseRate,
          deliveredOnTime,
          orderCompletion: completionRate,
        },
        skills: [...new Set(gigs.map((gig) => gig.categoryName).filter(Boolean))],
      },
    });
  } catch (error) {
    return next(error);
  }
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

const uploadAvatar = async (req, res, next) => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Cloudinary is not configured in environment variables.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image file is required.",
      });
    }

    const result = await uploadBufferToCloudinary(req.file.buffer, "jacob/profile-avatars");

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { avatar: result.secure_url },
      { new: true }
    ).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel payoutInfo savedServiceIds");

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile image uploaded successfully.",
      data: {
        avatarUrl: result.secure_url,
        user: serializeUser(updatedUser),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const {
      firstName,
      lastName,
      phone,
      address,
      role,
      preferredLanguage,
      locationLat,
      locationLng,
      businessBio,
      experienceLevel,
      serviceCity,
      serviceLocationLat,
      serviceLocationLng,
    } = req.body;

    const updates = {};

    if (typeof firstName === "string") updates.firstName = firstName.trim();
    if (typeof lastName === "string") updates.lastName = lastName.trim();
    if (typeof phone === "string") updates.phone = phone.trim();
    if (typeof address === "string") updates.address = address.trim();
    if (typeof role === "string" && ["client", "provider"].includes(role)) {
      updates.role = role;
    }
    if (typeof preferredLanguage === "string") {
      updates.preferredLanguage = preferredLanguage.trim() || "English (US)";
    }
    if (locationLat === null || typeof locationLat === "number") updates.locationLat = locationLat;
    if (locationLng === null || typeof locationLng === "number") updates.locationLng = locationLng;
    if (typeof businessBio === "string") updates.businessBio = businessBio.trim();
    if (typeof experienceLevel === "string") updates.experienceLevel = experienceLevel.trim();
    if (typeof serviceCity === "string") updates.serviceCity = serviceCity.trim();
    if (serviceLocationLat === null || typeof serviceLocationLat === "number") {
      updates.serviceLocationLat = serviceLocationLat;
    }
    if (serviceLocationLng === null || typeof serviceLocationLng === "number") {
      updates.serviceLocationLng = serviceLocationLng;
    }

    if ("firstName" in updates && !updates.firstName) {
      return res.status(400).json({
        success: false,
        message: "First name is required.",
      });
    }

    if ("lastName" in updates && !updates.lastName) {
      return res.status(400).json({
        success: false,
        message: "Last name is required.",
      });
    }

    const updatedUser = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel payoutInfo savedServiceIds");

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      data: {
        user: serializeUser(updatedUser),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getMyProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select(
      "_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel payoutInfo savedServiceIds"
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile fetched successfully.",
      data: {
        user: serializeUser(user),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const saveService = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can save services.",
      });
    }

    const { gigId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(gigId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service id.",
      });
    }

    const gig = await Gig.findOne({ _id: gigId, status: "published" }).select("_id");
    if (!gig) {
      return res.status(404).json({
        success: false,
        message: "Service not found.",
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $addToSet: { savedServiceIds: gig._id } },
      { new: true }
    ).select(
      "_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel payoutInfo savedServiceIds"
    );

    return res.status(200).json({
      success: true,
      message: "Service saved successfully.",
      data: {
        user: serializeUser(user),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const removeSavedService = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can remove saved services.",
      });
    }

    const { gigId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(gigId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service id.",
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $pull: { savedServiceIds: gigId } },
      { new: true }
    ).select(
      "_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn averageRating reviewCount sellerLevel payoutInfo savedServiceIds"
    );

    return res.status(200).json({
      success: true,
      message: "Saved service removed.",
      data: {
        user: serializeUser(user),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getMySavedServices = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can view saved services.",
      });
    }

    const user = await User.findById(req.user.id).select("savedServiceIds").lean();
    const savedServiceIds = Array.isArray(user?.savedServiceIds) ? user.savedServiceIds : [];

    if (savedServiceIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Saved services fetched successfully.",
        data: {
          items: [],
        },
      });
    }

    const gigs = await Gig.find({
      _id: { $in: savedServiceIds },
      status: "published",
    })
      .populate("providerId", "_id firstName lastName avatar averageRating sellerLevel")
      .lean();

    const orderMap = new Map(savedServiceIds.map((id, index) => [String(id), index]));
    const items = gigs
      .map(buildSavedServiceCard)
      .filter(Boolean)
      .sort((left, right) => (orderMap.get(String(left.id)) ?? 0) - (orderMap.get(String(right.id)) ?? 0));

    return res.status(200).json({
      success: true,
      message: "Saved services fetched successfully.",
      data: {
        items,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const submitPayoutInfo = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "provider") {
      return res.status(403).json({
        success: false,
        message: "Only providers can submit payout info.",
      });
    }

    const {
      accountHolderName = "",
      bankAccountNumber = "",
      routingNumber = "",
      bankName = "",
      accountType = "",
    } = req.body;

    const cleanAccountHolderName = String(accountHolderName).trim();
    const cleanBankAccountNumber = String(bankAccountNumber).trim();
    const cleanRoutingNumber = String(routingNumber).trim();
    const cleanBankName = String(bankName).trim();
    const normalizedAccountType = ["checking", "savings"].includes(String(accountType).trim().toLowerCase())
      ? String(accountType).trim().toLowerCase()
      : "";

    if (!cleanAccountHolderName || !cleanBankAccountNumber || !cleanRoutingNumber || !cleanBankName || !normalizedAccountType) {
      return res.status(400).json({
        success: false,
        message: "All payout fields are required.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Cloudinary is not configured in environment variables.",
      });
    }

    const frontFile = Array.isArray(req.files?.nidFront) ? req.files.nidFront[0] : null;
    const backFile = Array.isArray(req.files?.nidBack) ? req.files.nidBack[0] : null;

    const existingFront = user?.payoutInfo?.nidFrontImageUrl || "";
    const existingBack = user?.payoutInfo?.nidBackImageUrl || "";

    if (!frontFile && !existingFront) {
      return res.status(400).json({
        success: false,
        message: "NID front image is required.",
      });
    }

    if (!backFile && !existingBack) {
      return res.status(400).json({
        success: false,
        message: "NID back image is required.",
      });
    }

    const [frontUpload, backUpload] = await Promise.all([
      frontFile ? uploadBufferToCloudinary(frontFile.buffer, "jacob/provider-verification/nid-front") : Promise.resolve(null),
      backFile ? uploadBufferToCloudinary(backFile.buffer, "jacob/provider-verification/nid-back") : Promise.resolve(null),
    ]);

    user.payoutInfo = {
      ...(user.payoutInfo || {}),
      accountHolderName: cleanAccountHolderName,
      bankAccountNumber: cleanBankAccountNumber,
      routingNumber: cleanRoutingNumber,
      bankName: cleanBankName,
      accountType: normalizedAccountType,
      nidFrontImageUrl: frontUpload?.secure_url || existingFront,
      nidBackImageUrl: backUpload?.secure_url || existingBack,
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: "",
    };

    user.payoutVerificationStatus = PAYOUT_STATUS.PENDING;
    user.isVerified = false;
    await user.save();

    emitToRole("superAdmin", "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "system",
      title: "Provider verification requested",
      description: `${user.firstName || "A provider"} submitted payout + NID verification.`,
      data: {
        notificationType: "provider_verification_request",
        providerId: user._id.toString(),
        providerName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
        targetPath: `/provider-verifications?providerId=${user._id.toString()}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Payout info submitted. Verification request sent to admin.",
      data: {
        user: serializeUser(user),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listProviderVerifications = async (req, res, next) => {
  try {
    const { status = "pending" } = req.query;
    const allowedStatus = [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.VERIFIED, PAYOUT_STATUS.REJECTED, "all"];
    const normalizedStatus = String(status).toLowerCase();

    const query = { role: "provider" };
    if (allowedStatus.includes(normalizedStatus) && normalizedStatus !== "all") {
      query.payoutVerificationStatus = normalizedStatus;
    }

    const providers = await User.find(query)
      .select("_id firstName lastName email avatar payoutVerificationStatus walletBalance totalEarnings totalWithdrawn payoutInfo createdAt updatedAt")
      .sort({ "payoutInfo.submittedAt": -1, updatedAt: -1 })
      .lean();

    const data = providers.map((provider) => ({
      id: provider._id,
      firstName: provider.firstName || "",
      lastName: provider.lastName || "",
      email: provider.email,
      avatar: provider.avatar || "",
      payoutVerificationStatus: provider.payoutVerificationStatus || PAYOUT_STATUS.UNVERIFIED,
      payoutInfo: {
        accountHolderName: provider?.payoutInfo?.accountHolderName || "",
        bankAccountNumber: provider?.payoutInfo?.bankAccountNumber || "",
        routingNumber: provider?.payoutInfo?.routingNumber || "",
        bankName: provider?.payoutInfo?.bankName || "",
        accountType: provider?.payoutInfo?.accountType || "",
        nidFrontImageUrl: provider?.payoutInfo?.nidFrontImageUrl || "",
        nidBackImageUrl: provider?.payoutInfo?.nidBackImageUrl || "",
        submittedAt: provider?.payoutInfo?.submittedAt || null,
        reviewedAt: provider?.payoutInfo?.reviewedAt || null,
        rejectionReason: provider?.payoutInfo?.rejectionReason || "",
      },
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    }));

    return res.status(200).json({
      success: true,
      message: "Provider verification list fetched successfully.",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getProviderVerificationDetails = async (req, res, next) => {
  try {
    const { providerId } = req.params;

    const provider = await User.findOne({ _id: providerId, role: "provider" })
      .select("_id firstName lastName email avatar payoutVerificationStatus walletBalance totalEarnings totalWithdrawn payoutInfo createdAt updatedAt")
      .populate("payoutInfo.reviewedBy", "firstName lastName email role")
      .lean();

    if (!provider) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Provider verification details fetched successfully.",
      data: {
        id: provider._id,
        firstName: provider.firstName || "",
        lastName: provider.lastName || "",
        email: provider.email,
        avatar: provider.avatar || "",
        payoutVerificationStatus: provider.payoutVerificationStatus || PAYOUT_STATUS.UNVERIFIED,
        payoutInfo: {
          accountHolderName: provider?.payoutInfo?.accountHolderName || "",
          bankAccountNumber: provider?.payoutInfo?.bankAccountNumber || "",
          routingNumber: provider?.payoutInfo?.routingNumber || "",
          bankName: provider?.payoutInfo?.bankName || "",
          accountType: provider?.payoutInfo?.accountType || "",
          nidFrontImageUrl: provider?.payoutInfo?.nidFrontImageUrl || "",
          nidBackImageUrl: provider?.payoutInfo?.nidBackImageUrl || "",
          submittedAt: provider?.payoutInfo?.submittedAt || null,
          reviewedAt: provider?.payoutInfo?.reviewedAt || null,
          rejectionReason: provider?.payoutInfo?.rejectionReason || "",
          reviewedBy: provider?.payoutInfo?.reviewedBy || null,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

const approveProviderVerification = async (req, res, next) => {
  try {
    const { providerId } = req.params;

    const provider = await User.findOne({ _id: providerId, role: "provider" });
    if (!provider) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    provider.payoutVerificationStatus = PAYOUT_STATUS.VERIFIED;
    provider.isVerified = true;
    provider.payoutInfo = {
      ...(provider.payoutInfo || {}),
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
      rejectionReason: "",
    };

    await provider.save();

    emitToUser(String(provider._id), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "Your account is verified",
      description: "Admin approved your payout + NID verification request.",
      data: {
        notificationType: "provider_verification_approved",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Provider verified successfully.",
      data: {
        user: serializeUser(provider),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const rejectProviderVerification = async (req, res, next) => {
  try {
    const { providerId } = req.params;
    const { rejectionReason = "" } = req.body;

    const provider = await User.findOne({ _id: providerId, role: "provider" });
    if (!provider) {
      return res.status(404).json({
        success: false,
        message: "Provider not found.",
      });
    }

    provider.payoutVerificationStatus = PAYOUT_STATUS.REJECTED;
    provider.isVerified = false;
    provider.payoutInfo = {
      ...(provider.payoutInfo || {}),
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
      rejectionReason: String(rejectionReason || "").trim(),
    };

    await provider.save();

    emitToUser(String(provider._id), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
      title: "Verification rejected",
      description:
        provider?.payoutInfo?.rejectionReason || "Admin rejected your payout verification. Please update info and verify again.",
      data: {
        notificationType: "provider_verification_rejected",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Provider verification rejected.",
      data: {
        user: serializeUser(provider),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const createAdminAccount = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only super admin can create admin accounts.",
      });
    }

    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");
    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Admin name is required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters.",
      });
    }

    const email = `${normalizeAdminEmailName(name)}@admin.com`;
    const existingAdmin = await User.findOne({ email });
    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: "An admin with this generated email already exists.",
      });
    }

    const { firstName, lastName } = splitAdminName(name);
    const admin = await User.create({
      firstName,
      lastName,
      email,
      password: await bcrypt.hash(password, 10),
      role: "admin",
      isVerified: true,
    });

    return res.status(201).json({
      success: true,
      message: "Admin account created successfully.",
      data: {
        admin: serializeAdminAccount(admin),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listAdminAccounts = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only super admin can view admin accounts.",
      });
    }

    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(20, Math.max(1, Math.floor(Number(req.query.limit) || 8)));
    const skip = (page - 1) * limit;
    const query = { role: "admin" };

    const [admins, totalItems] = await Promise.all([
      User.find(query)
        .select("_id firstName lastName email avatar role createdAt updatedAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const safePage = Math.min(page, totalPages);

    return res.status(200).json({
      success: true,
      message: "Admin accounts fetched successfully.",
      data: {
        items: admins.map(serializeAdminAccount),
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

const updateAdminAccount = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only super admin can update admin accounts.",
      });
    }

    const { adminId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(404).json({
        success: false,
        message: "Admin account not found.",
      });
    }

    const admin = await User.findOne({ _id: adminId, role: "admin" });
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin account not found.",
      });
    }

    const name = String(req.body.name || "").trim();
    const newPassword = String(req.body.newPassword || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (name) {
      const { firstName, lastName } = splitAdminName(name);
      admin.firstName = firstName;
      admin.lastName = lastName;
    }

    if (newPassword || confirmPassword) {
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: "New password must be at least 8 characters.",
        });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: "New password and confirm password do not match.",
        });
      }

      admin.password = await bcrypt.hash(newPassword, 10);
    }

    await admin.save();

    return res.status(200).json({
      success: true,
      message: "Admin account updated successfully.",
      data: {
        admin: serializeAdminAccount(admin),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required.",
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const isCurrentMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getMyProfile,
  getPublicProviderProfile,
  listAdminCustomers,
  getAdminCustomerDetails,
  listAdminProviders,
  getAdminProviderDetails,
  uploadAvatar,
  updateProfile,
  changePassword,
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
  saveService,
  removeSavedService,
  getMySavedServices,
  submitPayoutInfo,
  listProviderVerifications,
  getProviderVerificationDetails,
  approveProviderVerification,
  rejectProviderVerification,
};
