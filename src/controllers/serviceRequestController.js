const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const Category = require("../models/Category");
const ServiceRequest = require("../models/ServiceRequest");
const Order = require("../models/Order");
const User = require("../models/User");
const { emitToRole, emitToUser } = require("../socket");
const { ensureConversationForOrder } = require("./chatController");
const slugify = require("../utils/slugify");

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

const uploadRequestImages = async (files = []) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const uploads = await Promise.all(
    files.slice(0, 4).map((file) => uploadBufferToCloudinary(file.buffer, "jacob/service-requests"))
  );
  return uploads.map((item) => item?.secure_url).filter((url) => typeof url === "string" && url.trim());
};

const toFiniteNumber = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createRequestNumber = () => {
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `REQ-${Date.now()}-${random}`;
};

const createOrderNumber = () => {
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `ORD-${Date.now()}-${random}`;
};

const createNotificationId = (suffix = "") => `NTF-${Date.now()}${suffix ? `-${suffix}` : ""}`;

const normalizePoint = (lat, lng) => {
  const nextLat = toFiniteNumber(lat);
  const nextLng = toFiniteNumber(lng);
  if (nextLat === null || nextLng === null) return null;
  return { lat: nextLat, lng: nextLng };
};

const haversineDistanceKm = (a, b) => {
  if (!a || !b) return null;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  return Number((2 * earthRadiusKm * Math.asin(Math.sqrt(h))).toFixed(2));
};

const geocodeAddress = async (address = "") => {
  const query = String(address || "").trim();
  if (!query) return null;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "Jacob/1.0",
          Accept: "application/json",
        },
      }
    );
    if (!response.ok) return null;
    const results = await response.json();
    const first = Array.isArray(results) ? results[0] : null;
    if (!first) return null;

    const lat = toFiniteNumber(first.lat);
    const lng = toFiniteNumber(first.lon);
    if (lat === null || lng === null) return null;

    return {
      lat,
      lng,
      formattedAddress: String(first.display_name || query).trim() || query,
    };
  } catch {
    return null;
  }
};

const resolveAddressFromCoordinates = async (lat, lng) => {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "";

  try {
    const response = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    if (!response.ok) return "";

    const data = await response.json();
    return formatAddress(
      String(data?.locality || data?.city || "").trim(),
      String(data?.principalSubdivision || "").trim(),
      String(data?.postcode || "").trim()
    );
  } catch {
    return "";
  }
};

const buildRequestSummary = (request, viewerId = null) => {
  if (!request) return null;
  const client = request.clientId || {};
  const provider = request.acceptedProviderId || {};
  const category = request.categoryId || {};
  const linkedOrder = request.linkedOrderId || null;
  const distanceKm = typeof request.distanceKm === "number" ? request.distanceKm : null;

  return {
    id: request._id,
    requestNumber: request.requestNumber,
    categoryId: category._id || request.categoryId || null,
    categorySlug: request.categorySlug || "",
    categoryName: request.categoryName || category.name || "",
    requestSource: request.requestSource || "existing_category",
    requestType: request.requestSource === "custom_category" ? "custom" : "matched",
    customCategoryName: request.customCategoryName || "",
    customCategoryDescription: request.customCategoryDescription || "",
    customCategoryApprovalStatus: request.customCategoryApprovalStatus || "not_requested",
    customCategoryRequestedAt: request.customCategoryRequestedAt || null,
    customCategoryReviewedAt: request.customCategoryReviewedAt || null,
    customCategoryRejectionReason: request.customCategoryRejectionReason || "",
    pendingAdminCategoryApproval:
      request.requestSource === "custom_category" &&
      String(request.customCategoryApprovalStatus || "not_requested") !== "approved",
    serviceAddress: request.serviceAddress || "",
    serviceLocationLat: typeof request.serviceLocationLat === "number" ? request.serviceLocationLat : null,
    serviceLocationLng: typeof request.serviceLocationLng === "number" ? request.serviceLocationLng : null,
    description: request.description || "",
    preferredDate: request.preferredDate || null,
    preferredTime: request.preferredTime || "",
    budget: Number(request.budget) || 0,
    imageUrls: Array.isArray(request.imageUrls) ? request.imageUrls : [],
    status: request.status || "open",
    acceptedAt: request.acceptedAt || null,
    ignoredByViewer: Boolean(
      viewerId &&
        Array.isArray(request.ignoredByProviderIds) &&
        request.ignoredByProviderIds.some((id) => String(id) === String(viewerId))
    ),
    distanceKm,
    client: {
      id: client._id || "",
      name: `${client.firstName || ""} ${client.lastName || ""}`.trim() || "Client",
      email: client.email || "",
      avatar: client.avatar || "",
      phone: client.phone || "",
      address: client.address || "",
      locationLat: typeof client.locationLat === "number" ? client.locationLat : null,
      locationLng: typeof client.locationLng === "number" ? client.locationLng : null,
    },
    acceptedProvider: provider?._id
      ? {
          id: provider._id || "",
          name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || "Provider",
          avatar: provider.avatar || "",
          sellerLevel: provider.sellerLevel || "New",
          rating: Number(provider.averageRating) || 0,
        }
      : null,
    linkedOrderId: request.linkedOrderId || null,
    linkedOrderNumber: request.linkedOrderNumber || "",
    linkedOrderStatus: linkedOrder?.status || "",
    linkedOrderPaymentStatus: linkedOrder?.paymentStatus || "",
    linkedOrderCompletedAt: linkedOrder?.completedAt || null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
};

const createOrderFromServiceRequest = async ({ request, providerId }) => {
  const existingOrderId = request.linkedOrderId ? String(request.linkedOrderId) : "";
  if (existingOrderId) {
    const existingOrder = await Order.findById(existingOrderId);
    if (existingOrder) return existingOrder;
  }

  const clientProfile = await User.findById(request.clientId)
    .select("_id address locationLat locationLng")
    .lean();

  const clientAddressSnapshot =
    String(clientProfile?.address || "").trim() ||
    String(request.serviceAddress || "").trim() ||
    (await resolveAddressFromCoordinates(clientProfile?.locationLat, clientProfile?.locationLng)) ||
    "";

  const order = await Order.create({
    orderNumber: createOrderNumber(),
    gigId: null,
    clientId: request.clientId,
    providerId,
    conversationId: null,
    packageName: String(request.categorySlug || "custom-request").trim(),
    packageTitle: String(request.categoryName || request.categorySlug || "Custom Request").trim(),
    categoryName: String(request.categoryName || request.categorySlug || "Custom Request").trim(),
    packagePrice: Number(request.budget) || 0,
    scheduledDate: request.preferredDate ? new Date(request.preferredDate) : new Date(),
    scheduledTime: String(request.preferredTime || "").trim(),
    serviceAddress: String(request.serviceAddress || "").trim(),
    clientAddressSnapshot,
    specialInstructions: String(request.description || "").trim(),
    requirementSubmittedAt: new Date(request.createdAt || Date.now()),
    status: "accepted",
    paymentStatus: "unpaid",
    paymentProvider: "stripe",
    paymentAmount: Number(request.budget) || 0,
    paymentCurrency: "usd",
  });

  const conversation = await ensureConversationForOrder({
    orderId: order._id,
    clientId: request.clientId,
    providerId,
  });

  if (conversation && !order.conversationId) {
    order.conversationId = conversation._id;
    await order.save({ validateBeforeSave: false });
  }

  request.linkedOrderId = order._id;
  request.linkedOrderNumber = order.orderNumber;
  request.acceptedProviderId = providerId;
  request.acceptedAt = new Date();
  request.status = "accepted";
  await request.save({ validateBeforeSave: false });

  return order;
};

const resolveProviderCoordinates = (provider = {}) => {
  const direct = normalizePoint(provider.serviceLocationLat, provider.serviceLocationLng);
  if (direct) return direct;
  return normalizePoint(provider.locationLat, provider.locationLng);
};

const resolveRequestCoordinates = async ({ serviceAddress, serviceLocationLat, serviceLocationLng }) => {
  const direct = normalizePoint(serviceLocationLat, serviceLocationLng);
  if (direct) return direct;
  return geocodeAddress(serviceAddress);
};

const createServiceRequest = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can create service requests.",
      });
    }

    const requestCustomCategory = String(req.body.requestCustomCategory || "").trim().toLowerCase() === "true";
    const categorySlugInput = String(req.body.categorySlug || "").trim().toLowerCase();
    const categoryNameInput = String(req.body.categoryName || "").trim();
    const customCategoryName = String(req.body.customCategoryName || "").trim();
    const customCategoryDescription = String(req.body.customCategoryDescription || "").trim();
    const serviceAddress = String(req.body.serviceAddress || "").trim();
    const description = String(req.body.description || "").trim();
    const preferredTime = String(req.body.preferredTime || "").trim();
    const budget = Number(req.body.budget || 0);
    const preferredDate = String(req.body.preferredDate || "").trim();

    if (!serviceAddress || !description || !preferredTime || !Number.isFinite(budget) || budget <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please fill all required request fields.",
      });
    }

    let category = null;
    let categorySlug = categorySlugInput;
    let categoryName = categoryNameInput;
    let requestSource = "existing_category";
    let customCategoryApprovalStatus = "not_requested";

    if (requestCustomCategory) {
      categoryName = customCategoryName || categoryNameInput;
      categorySlug = slugify(categoryName);
      requestSource = "custom_category";
      customCategoryApprovalStatus = "pending";

      if (!categoryName || !categorySlug) {
        return res.status(400).json({
          success: false,
          message: "Please enter the custom category you want to request.",
        });
      }
    } else {
      if (!categorySlugInput) {
        return res.status(400).json({
          success: false,
          message: "Please choose an existing service category.",
        });
      }

      category =
        (await Category.findOne({ slug: categorySlugInput, status: "approved" }).lean()) ||
        (await Category.findOne({ slug: categorySlugInput }).lean());

      if (!category) {
        return res.status(404).json({
          success: false,
          message: "Selected category was not found.",
        });
      }

      categorySlug = String(category.slug || categorySlugInput).trim().toLowerCase();
      categoryName = String(category.name || categoryNameInput || categorySlug).trim();
    }

    const clientProfile = await User.findById(req.user.id)
      .select("_id firstName lastName email avatar address locationLat locationLng")
      .lean();
    const requestCoordinates =
      (await resolveRequestCoordinates({
        serviceAddress,
        serviceLocationLat: req.body.serviceLocationLat,
        serviceLocationLng: req.body.serviceLocationLng,
      })) ||
      normalizePoint(clientProfile?.locationLat, clientProfile?.locationLng);

    const imageUrls = await uploadRequestImages(req.files || []);
    const serviceRequest = await ServiceRequest.create({
      requestNumber: createRequestNumber(),
      clientId: req.user.id,
      categoryId: category?._id || null,
      categorySlug,
      categoryName,
      requestSource,
      customCategoryName: requestCustomCategory ? categoryName : "",
      customCategoryDescription: requestCustomCategory ? customCategoryDescription : "",
      customCategoryApprovalStatus,
      customCategoryRequestedAt: requestCustomCategory ? new Date() : null,
      serviceAddress,
      serviceLocationLat: requestCoordinates?.lat ?? null,
      serviceLocationLng: requestCoordinates?.lng ?? null,
      description,
      preferredDate: preferredDate ? new Date(preferredDate) : null,
      preferredTime,
      budget,
      imageUrls,
      status: "open",
    });

    const notifiedProviders = await notifyNearbyProvidersForRequest({
      request: serviceRequest.toObject(),
      clientProfile,
    });

    emitToRole("superAdmin", "notification:new", {
      id: createNotificationId(String(serviceRequest._id)),
      type: "system",
      title: requestCustomCategory ? "New custom category request" : "New service request",
      description: requestCustomCategory
        ? `${clientProfile?.firstName || "A client"} requested a new category: ${serviceRequest.categoryName || "Custom category"}.`
        : `${clientProfile?.firstName || "A client"} requested ${serviceRequest.categoryName || "a service"}.`,
      data: {
        notificationType: requestCustomCategory ? "custom_category_request_created" : "service_request_created",
        requestId: String(serviceRequest._id),
        requestNumber: serviceRequest.requestNumber,
        categorySlug: serviceRequest.categorySlug,
        categoryName: serviceRequest.categoryName,
        providerName: `${clientProfile?.firstName || ""} ${clientProfile?.lastName || ""}`.trim() || clientProfile?.email || "Client",
        targetPath: `/service-requests?requestId=${String(serviceRequest._id)}`,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: requestCustomCategory
        ? "Custom category request submitted successfully. Admin review is pending."
        : "Service request created successfully.",
      data: {
        request: buildRequestSummary({
          ...serviceRequest.toObject(),
          clientId: clientProfile || null,
          categoryId: category || null,
        }),
        notifiedProviders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const listClientServiceRequests = async (req, res, next) => {
  try {
    if (!req.user || !["client", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only clients can view their service requests.",
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(24, Number(req.query.limit) || 6));
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const skip = (page - 1) * limit;

    const filters = { clientId: req.user.id };
    if (status !== "all" && ["open", "accepted", "cancelled"].includes(status)) {
      filters.status = status;
    }
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filters.$or = [
        { requestNumber: regex },
        { categoryName: regex },
        { categorySlug: regex },
        { serviceAddress: regex },
        { description: regex },
        { preferredTime: regex },
        { status: regex },
      ];
    }

    const [items, totalItems] = await Promise.all([
    ServiceRequest.find(filters)
      .populate("clientId", "_id firstName lastName avatar email address locationLat locationLng")
      .populate("acceptedProviderId", "_id firstName lastName avatar sellerLevel averageRating")
      .populate("linkedOrderId", "_id orderNumber status paymentStatus completedAt")
      .populate("categoryId", "_id name slug iconName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ServiceRequest.countDocuments(filters),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Client service requests fetched successfully.",
      data: {
        items: items.map((item) => buildRequestSummary(item, req.user.id)),
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

const listProviderServiceRequests = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view nearby service requests.",
      });
    }

    const provider = await User.findById(req.user.id)
      .select("_id firstName lastName avatar address locationLat locationLng serviceLocationLat serviceLocationLng")
      .lean();

    const providerCoordinates = resolveProviderCoordinates(provider);
    if (!providerCoordinates) {
      return res.status(200).json({
        success: true,
        message: "Nearby service requests fetched successfully.",
        data: {
          items: [],
          pagination: {
            page: 1,
            limit: 1,
            totalItems: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        },
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(24, Number(req.query.limit) || 6));
    const radiusKm = Math.max(1, Math.min(100, Number(req.query.radiusKm) || 30));
    const search = String(req.query.search || "").trim().toLowerCase();
    const skip = (page - 1) * limit;

    const requests = await ServiceRequest.find({
      status: "open",
      acceptedProviderId: null,
      ignoredByProviderIds: { $ne: req.user.id },
      $or: [
        { requestSource: { $ne: "custom_category" } },
        { customCategoryApprovalStatus: "approved" },
      ],
      ...(search
        ? {
            $or: [
              { requestNumber: new RegExp(escapeRegex(search), "i") },
              { categoryName: new RegExp(escapeRegex(search), "i") },
              { categorySlug: new RegExp(escapeRegex(search), "i") },
              { serviceAddress: new RegExp(escapeRegex(search), "i") },
              { description: new RegExp(escapeRegex(search), "i") },
              { preferredTime: new RegExp(escapeRegex(search), "i") },
            ],
          }
        : {}),
    })
    .populate("clientId", "_id firstName lastName avatar email address locationLat locationLng")
    .populate("acceptedProviderId", "_id firstName lastName avatar sellerLevel averageRating")
    .populate("linkedOrderId", "_id orderNumber status paymentStatus completedAt")
    .populate("categoryId", "_id name slug iconName")
      .sort({ createdAt: -1 })
      .lean();

    const matched = requests
      .map((item) => {
        const requestCoordinates = normalizePoint(item.serviceLocationLat, item.serviceLocationLng);
        const distanceKm = haversineDistanceKm(providerCoordinates, requestCoordinates);
        return {
          ...item,
          distanceKm,
        };
      })
      .filter((item) => Number.isFinite(item.distanceKm) && item.distanceKm <= radiusKm)
      .sort((a, b) => {
        const distanceDelta = (a.distanceKm || 0) - (b.distanceKm || 0);
        if (distanceDelta !== 0) return distanceDelta;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

    const totalItems = matched.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const paginatedItems = matched.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      message: "Nearby service requests fetched successfully.",
      data: {
        items: paginatedItems.map((item) => buildRequestSummary(item, req.user.id)),
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

const acceptServiceRequest = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can accept service requests.",
      });
    }

    const request = await ServiceRequest.findOne({
      _id: req.params.id,
      status: "open",
      acceptedProviderId: null,
      ignoredByProviderIds: { $ne: req.user.id },
      $or: [
        { requestSource: { $ne: "custom_category" } },
        { customCategoryApprovalStatus: "approved" },
      ],
    })
      .populate("clientId", "_id firstName lastName avatar email address locationLat locationLng")
      .populate("categoryId", "_id name slug iconName")
      .populate("acceptedProviderId", "_id firstName lastName avatar sellerLevel averageRating");

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Service request not found or already handled.",
      });
    }

    request.status = "accepted";
    const linkedOrder = await createOrderFromServiceRequest({
      request,
      providerId: req.user.id,
    });

    emitToUser(String(request.clientId?._id || request.clientId), "notification:new", {
      id: createNotificationId(),
      type: "success",
      title: "Your service request was accepted",
      description: `A provider accepted your ${request.categoryName || "service"} request.`,
      data: {
        notificationType: "service_request_accepted",
        requestId: request._id.toString(),
        requestNumber: request.requestNumber,
        linkedOrderId: linkedOrder?._id?.toString() || request.linkedOrderId?.toString() || "",
        linkedOrderNumber: request.linkedOrderNumber || "",
        targetPath: linkedOrder
          ? `/client/orders/${linkedOrder.orderNumber || linkedOrder._id.toString()}`
          : "/client/orders?tab=requested",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Service request accepted successfully.",
      data: {
        request: buildRequestSummary(request, req.user.id),
        order: linkedOrder ? { id: linkedOrder._id, orderNumber: linkedOrder.orderNumber } : null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const ignoreServiceRequest = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can ignore service requests.",
      });
    }

    const request = await ServiceRequest.findOne({
      _id: req.params.id,
      status: "open",
      acceptedProviderId: null,
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Service request not found or already handled.",
      });
    }

    const ignoredIds = new Set((request.ignoredByProviderIds || []).map((id) => String(id)));
    ignoredIds.add(String(req.user.id));
    request.ignoredByProviderIds = Array.from(ignoredIds).map((id) => new mongoose.Types.ObjectId(id));
    await request.save({ validateBeforeSave: false });

    return res.status(200).json({
      success: true,
      message: "Service request ignored.",
      data: {
        requestId: request._id,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const shouldPublishToProviders = (request = {}) => {
  if (String(request.status || "open") !== "open") return false;
  if (String(request.requestSource || "existing_category") !== "custom_category") return true;
  return String(request.customCategoryApprovalStatus || "not_requested") === "approved";
};

const notifyNearbyProvidersForRequest = async ({ request, clientProfile }) => {
  if (!shouldPublishToProviders(request)) return 0;

  const requestCoordinates = normalizePoint(request.serviceLocationLat, request.serviceLocationLng);
  if (!requestCoordinates) return 0;

  const providers = await User.find({ role: "provider" })
    .select("_id firstName lastName avatar email address locationLat locationLng serviceLocationLat serviceLocationLng sellerLevel averageRating")
    .lean();

  const nearbyProviders = providers
    .map((provider) => {
      const providerCoordinates = resolveProviderCoordinates(provider);
      const distanceKm = haversineDistanceKm(requestCoordinates, providerCoordinates);
      return { provider, distanceKm };
    })
    .filter(({ distanceKm }) => Number.isFinite(distanceKm) && distanceKm <= 30)
    .sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));

  nearbyProviders.forEach(({ provider, distanceKm }) => {
    emitToUser(String(provider._id), "notification:new", {
      id: createNotificationId(String(provider._id)),
      type: "system",
      title: "New service request nearby",
      description: `${clientProfile?.firstName || "A client"} posted a new service request in your area.`,
      data: {
        notificationType: "service_request_created",
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        categorySlug: request.categorySlug,
        categoryName: request.categoryName,
        distanceKm,
        targetPath: "/provider/requests",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });
  });

  return nearbyProviders.length;
};

const findOrCreateApprovedCategoryForRequest = async ({ serviceRequest, adminUserId }) => {
  const requestedName = String(serviceRequest.customCategoryName || serviceRequest.categoryName || "").trim();
  const requestedDescription = String(serviceRequest.customCategoryDescription || "").trim();
  const requestedSlug = slugify(serviceRequest.customCategoryName || serviceRequest.categoryName || serviceRequest.categorySlug || "");

  let category = await Category.findOne({ slug: requestedSlug });
  if (!category) {
    category = await Category.create({
      name: requestedName,
      slug: requestedSlug,
      description: requestedDescription,
      isCustom: true,
      status: "approved",
      createdBy: serviceRequest.clientId || null,
      approvedBy: adminUserId || null,
      approvedAt: new Date(),
    });
    return category;
  }

  category.name = requestedName || category.name;
  if (requestedDescription) {
    category.description = requestedDescription;
  }
  category.isCustom = true;
  category.status = "approved";
  category.approvedBy = adminUserId || category.approvedBy || null;
  category.approvedAt = new Date();
  await category.save();
  return category;
};

const listAdminServiceRequests = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const requestType = String(req.query.requestType || "all").trim().toLowerCase();
    const skip = (page - 1) * limit;

    const filters = {};

    if (status !== "all" && ["open", "accepted", "cancelled"].includes(status)) {
      filters.status = status;
    }

    if (requestType === "custom") {
      filters.requestSource = "custom_category";
    } else if (requestType === "matched") {
      filters.requestSource = "existing_category";
    }

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filters.$or = [
        { requestNumber: regex },
        { categoryName: regex },
        { categorySlug: regex },
        { serviceAddress: regex },
        { description: regex },
        { preferredTime: regex },
        { status: regex },
      ];
    }

    const [items, totalItems] = await Promise.all([
      ServiceRequest.find(filters)
        .populate("clientId", "_id firstName lastName avatar email phone address locationLat locationLng")
        .populate("acceptedProviderId", "_id firstName lastName avatar sellerLevel averageRating email")
        .populate("linkedOrderId", "_id orderNumber status paymentStatus completedAt")
        .populate("categoryId", "_id name slug iconName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ServiceRequest.countDocuments(filters),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return res.status(200).json({
      success: true,
      message: "Admin service requests fetched successfully.",
      data: {
        items: items.map((item) => buildRequestSummary(item)),
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

const approveServiceRequestCustomCategory = async (req, res, next) => {
  try {
    const request = await ServiceRequest.findById(req.params.id)
      .populate("clientId", "_id firstName lastName email avatar phone address locationLat locationLng")
      .populate("categoryId", "_id name slug iconName");

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Service request not found.",
      });
    }

    if (request.requestSource !== "custom_category") {
      return res.status(400).json({
        success: false,
        message: "This service request does not need custom category approval.",
      });
    }

    if (request.customCategoryApprovalStatus === "approved") {
      return res.status(200).json({
        success: true,
        message: "Custom category request was already approved.",
        data: {
          request: buildRequestSummary(request),
        },
      });
    }

    const category = await findOrCreateApprovedCategoryForRequest({
      serviceRequest: request,
      adminUserId: req.user?.id || null,
    });

    request.categoryId = category._id;
    request.categorySlug = String(category.slug || request.categorySlug).trim().toLowerCase();
    request.categoryName = String(category.name || request.categoryName).trim();
    request.customCategoryApprovalStatus = "approved";
    request.customCategoryReviewedAt = new Date();
    request.customCategoryReviewedBy = req.user?.id || null;
    request.customCategoryRejectionReason = "";
    await request.save({ validateBeforeSave: false });

    const clientProfile = request.clientId || null;
    const notifiedProviders = await notifyNearbyProvidersForRequest({
      request: request.toObject(),
      clientProfile,
    });

    emitToUser(String(request.clientId?._id || request.clientId), "notification:new", {
      id: createNotificationId(String(request._id)),
      type: "success",
      title: "Custom category approved",
      description: `Your custom category request for ${request.categoryName || "this service"} was approved.`,
      data: {
        notificationType: "custom_category_request_approved",
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        categorySlug: request.categorySlug,
        categoryName: request.categoryName,
        targetPath: "/client/orders?tab=requested",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Custom category request approved successfully.",
      data: {
        request: buildRequestSummary({
          ...request.toObject(),
          categoryId: category.toObject(),
          clientId: clientProfile,
        }),
        notifiedProviders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createServiceRequest,
  listClientServiceRequests,
  listProviderServiceRequests,
  listAdminServiceRequests,
  approveServiceRequestCustomCategory,
  acceptServiceRequest,
  ignoreServiceRequest,
};
