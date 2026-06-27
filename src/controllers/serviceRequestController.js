const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const Category = require("../models/Category");
const ServiceRequest = require("../models/ServiceRequest");
const Order = require("../models/Order");
const User = require("../models/User");
const { emitToRole, emitToUser } = require("../socket");
const { ensureConversationForOrder, startServiceRequestNegotiationConversation } = require("./chatController");
const slugify = require("../utils/slugify");
const { findBlockingAvailability } = require("../utils/providerAvailability");

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

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));
const calculateOrderPricing = (listedPrice) => {
  const gross = roundMoney(listedPrice);
  const adminFee = roundMoney(gross * 0.15);
  const providerNet = roundMoney(Math.max(gross - adminFee, 0));
  return {
    packagePrice: gross,
    paymentAmount: gross,
    platformFeeAmount: adminFee,
    providerEarningsAmount: providerNet,
    listedPrice: gross,
    customerPaidAmount: gross,
    adminFeeAmount: adminFee,
    providerNetAmount: providerNet,
  };
};

const createNotificationId = (suffix = "") => `NTF-${Date.now()}${suffix ? `-${suffix}` : ""}`;
const extractZipCodeFromText = (value = "") => {
  const match = String(value || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : "";
};

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
  const viewerInvitation = resolveViewerInvitation(request, viewerId);
  const pendingInvitationCount = Array.isArray(request.adminInvitations)
    ? request.adminInvitations.filter((item) => String(item?.status || "") === "pending").length
    : 0;

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
    acceptedVia: request.acceptedVia || "",
    ignoredByViewer: Boolean(
      viewerId &&
        Array.isArray(request.ignoredByProviderIds) &&
        request.ignoredByProviderIds.some((id) => String(id) === String(viewerId))
    ),
    distanceKm,
    adminRequestedForViewer: Boolean(viewerInvitation),
    adminInvitationStatus: viewerInvitation?.status || "",
    adminInvitedAt: viewerInvitation?.invitedAt || null,
    assignedToOtherProvider: Boolean(
      viewerInvitation &&
        request.acceptedProviderId &&
        String(request.acceptedProviderId?._id || request.acceptedProviderId) !== String(viewerId)
    ),
    pendingInvitationCount,
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

  const pricing = calculateOrderPricing(request.budget);
  const availabilityBlock = await findBlockingAvailability({
    providerId,
    scheduledDate: request.preferredDate ? new Date(request.preferredDate) : new Date(),
    scheduledTime: String(request.preferredTime || "").trim(),
  });
  if (availabilityBlock) {
    const error = new Error(
      availabilityBlock.scope === "full_day"
        ? "You have blocked this request date on your calendar."
        : "You have blocked this request time on your calendar."
    );
    error.statusCode = 409;
    throw error;
  }

  const order = await Order.create({
    orderNumber: createOrderNumber(),
    gigId: null,
    clientId: request.clientId,
    providerId,
    conversationId: null,
    packageName: String(request.categorySlug || "custom-request").trim(),
    packageTitle: String(request.categoryName || request.categorySlug || "Custom Request").trim(),
    categoryName: String(request.categoryName || request.categorySlug || "Custom Request").trim(),
    ...pricing,
    scheduledDate: request.preferredDate ? new Date(request.preferredDate) : new Date(),
    scheduledTime: String(request.preferredTime || "").trim(),
    serviceAddress: String(request.serviceAddress || "").trim(),
    clientAddressSnapshot,
    specialInstructions: String(request.description || "").trim(),
    requirementSubmittedAt: new Date(request.createdAt || Date.now()),
    status: "accepted",
    paymentStatus: "unpaid",
    paymentProvider: "stripe",
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

    const searchFilters = search
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
      : {};

    const requests = await ServiceRequest.find({
      ...searchFilters,
      $or: [
        {
          status: "open",
          acceptedProviderId: null,
          ignoredByProviderIds: { $ne: req.user.id },
          $or: [
            { requestSource: { $ne: "custom_category" } },
            { customCategoryApprovalStatus: "approved" },
          ],
        },
        {
          adminInvitations: {
            $elemMatch: {
              providerId: req.user.id,
              status: "pending",
            },
          },
          linkedOrderId: null,
        },
      ],
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
      .filter((item) => {
        const invitation = resolveViewerInvitation(item, req.user.id);
        if (invitation && String(invitation.status || "") !== "pending") return false;
        if (invitation) return true;
        return Number.isFinite(item.distanceKm) && item.distanceKm <= radiusKm;
      })
      .sort((a, b) => {
        const invitationA = resolveViewerInvitation(a, req.user.id);
        const invitationB = resolveViewerInvitation(b, req.user.id);
        if (invitationA && !invitationB) return -1;
        if (!invitationA && invitationB) return 1;
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
    request.acceptedVia = "direct";
    const linkedOrder = await createOrderFromServiceRequest({
      request,
      providerId: req.user.id,
    });

    if (Array.isArray(request.adminInvitations) && request.adminInvitations.length) {
      request.adminInvitations = request.adminInvitations.map((item) => {
        const matches = String(item.providerId?._id || item.providerId) === String(req.user.id);
        return {
          ...item,
          status: matches ? "accepted" : "unavailable",
          respondedAt: matches ? new Date() : item.respondedAt || new Date(),
        };
      });
      await request.save({ validateBeforeSave: false });
    }

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

const resolveViewerInvitation = (request, viewerId) => {
  if (!viewerId || !Array.isArray(request?.adminInvitations)) return null;
  return (
    request.adminInvitations.find((item) => String(item?.providerId?._id || item?.providerId || "") === String(viewerId)) ||
    null
  );
};

const resolveRequestByReference = async (requestRef) => {
  const normalized = String(requestRef || "").trim();
  if (!normalized) return null;

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const byId = await ServiceRequest.findById(normalized);
    if (byId) return byId;
  }

  return ServiceRequest.findOne({ requestNumber: normalized });
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

const inviteProvidersToServiceRequest = async (req, res, next) => {
  try {
    const { requestRef, providerIds = [] } = req.body || {};
    const serviceRequest = await resolveRequestByReference(requestRef);

    if (!serviceRequest) {
      return res.status(404).json({ success: false, message: "Service request not found." });
    }
    if (String(serviceRequest.status || "") !== "open" || serviceRequest.acceptedProviderId) {
      return res.status(400).json({ success: false, message: "This service request is no longer open for provider invitations." });
    }
    if (
      String(serviceRequest.requestSource || "") === "custom_category" &&
      String(serviceRequest.customCategoryApprovalStatus || "") !== "approved"
    ) {
      return res.status(400).json({ success: false, message: "Approve the custom category before inviting providers." });
    }

    const normalizedProviderIds = [...new Set((Array.isArray(providerIds) ? providerIds : []).map((item) => String(item || "").trim()).filter(Boolean))];
    if (!normalizedProviderIds.length) {
      return res.status(400).json({ success: false, message: "Select at least one provider." });
    }

    const providers = await User.find({
      _id: { $in: normalizedProviderIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id)) },
      role: "provider",
    })
      .select("_id firstName lastName email")
      .lean();

    if (!providers.length) {
      return res.status(404).json({ success: false, message: "No matching providers found." });
    }

    const existingInvitations = Array.isArray(serviceRequest.adminInvitations) ? serviceRequest.adminInvitations : [];
    const invitationMap = new Map(existingInvitations.map((item) => [String(item.providerId), item]));
    const invitedProviders = [];

    providers.forEach((provider) => {
      const existing = invitationMap.get(String(provider._id));
      if (existing) {
        existing.status = "pending";
        existing.invitedAt = new Date();
        existing.invitedBy = req.user?.id || null;
        existing.respondedAt = null;
      } else {
        existingInvitations.push({
          providerId: provider._id,
          invitedBy: req.user?.id || null,
          invitedAt: new Date(),
          status: "pending",
          respondedAt: null,
        });
      }

      emitToUser(String(provider._id), "notification:new", {
        id: createNotificationId(String(provider._id)),
        type: "system",
        title: "Admin requested a provider review",
        description: `Admin asked if you can handle ${serviceRequest.categoryName || "this request"} at ${serviceRequest.serviceAddress || "the requested location"}.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "admin_service_request_invitation",
          requestId: String(serviceRequest._id),
          requestNumber: serviceRequest.requestNumber,
          targetPath: "/provider/requests",
        },
      });

      invitedProviders.push({
        id: String(provider._id),
        name: `${provider.firstName || ""} ${provider.lastName || ""}`.trim() || provider.email || "Provider",
        email: provider.email || "",
      });
    });

    serviceRequest.adminInvitations = existingInvitations;
    await serviceRequest.save({ validateBeforeSave: false });

    emitToRole("superAdmin", "notification:new", {
      id: createNotificationId(String(serviceRequest._id)),
      type: "system",
      title: "Providers requested for service request",
      description: `Admin sent ${invitedProviders.length} provider request${invitedProviders.length === 1 ? "" : "s"} for ${serviceRequest.requestNumber}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "admin_provider_invites_sent",
        requestId: String(serviceRequest._id),
        requestNumber: serviceRequest.requestNumber,
        targetPath: `/service-requests?requestId=${String(serviceRequest._id)}`,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Provider requests sent successfully.",
      data: {
        requestId: String(serviceRequest._id),
        requestNumber: serviceRequest.requestNumber,
        invitedProviders,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const respondToAdminServiceRequestInvitation = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Only providers can respond to admin invitations." });
    }

    const { action } = req.body || {};
    if (!["accept", "decline"].includes(String(action || ""))) {
      return res.status(400).json({ success: false, message: "Action must be accept or decline." });
    }

    const request = await ServiceRequest.findById(req.params.id)
      .populate("clientId", "_id firstName lastName email avatar")
      .populate("acceptedProviderId", "_id firstName lastName email avatar");

    if (!request) {
      return res.status(404).json({ success: false, message: "Service request not found." });
    }

    const invitation = resolveViewerInvitation(request, req.user.id);
    if (!invitation) {
      return res.status(404).json({ success: false, message: "No admin invitation found for this provider." });
    }

    if (String(invitation.status || "") !== "pending") {
      return res.status(400).json({ success: false, message: "This admin invitation is already handled." });
    }

    if (request.acceptedProviderId && String(request.acceptedProviderId?._id || request.acceptedProviderId) !== String(req.user.id)) {
      invitation.status = "unavailable";
      invitation.respondedAt = new Date();
      await request.save({ validateBeforeSave: false });
      return res.status(409).json({
        success: false,
        message: "Another provider already accepted this request.",
      });
    }

    if (action === "decline") {
      invitation.status = "declined";
      invitation.respondedAt = new Date();
      await request.save({ validateBeforeSave: false });

      emitToRole("superAdmin", "notification:new", {
        id: createNotificationId(String(request._id)),
        type: "warning",
        title: "Provider declined admin request",
        description: `${req.user.firstName || "A provider"} declined request ${request.requestNumber}.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "admin_service_request_declined",
          requestId: String(request._id),
          requestNumber: request.requestNumber,
          targetPath: `/service-requests?requestId=${String(request._id)}`,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Service request declined.",
        data: {
          request: buildRequestSummary(request, req.user.id),
        },
      });
    }

    const negotiationConversation = await startServiceRequestNegotiationConversation({
      serviceRequestId: request._id,
      clientId: request.clientId?._id || request.clientId,
      providerId: req.user.id,
      categoryName: request.categoryName,
      requestNumber: request.requestNumber,
    });

    request.acceptedProviderId = req.user.id;
    request.acceptedAt = new Date();
    request.status = "accepted";
    request.acceptedVia = "admin_invitation";
    request.negotiationConversationId = negotiationConversation?._id || null;
    request.adminInvitations = (request.adminInvitations || []).map((item) => {
      const isCurrent = String(item.providerId?._id || item.providerId) === String(req.user.id);
      return {
        ...item,
        status: isCurrent ? "accepted" : String(item.status || "") === "pending" ? "unavailable" : item.status,
        respondedAt: isCurrent || String(item.status || "") === "pending" ? new Date() : item.respondedAt || null,
      };
    });
    await request.save({ validateBeforeSave: false });

    const conversationId = negotiationConversation ? String(negotiationConversation._id) : "";
    emitToUser(String(request.clientId?._id || request.clientId), "notification:new", {
      id: createNotificationId(String(request._id)),
      type: "success",
      title: "A provider is ready to negotiate",
      description: `${req.user.firstName || "A provider"} accepted your request for ${request.categoryName || "this service"}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "service_request_negotiation_started",
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        conversationId,
        targetPath: conversationId ? `/messages?conversationId=${conversationId}` : "/messages",
      },
    });
    emitToUser(String(req.user.id), "notification:new", {
      id: createNotificationId(`${String(request._id)}-provider`),
      type: "success",
      title: "Negotiation started",
      description: `You accepted ${request.requestNumber}. Continue with the client in inbox.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "service_request_negotiation_started_provider",
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        conversationId,
        targetPath: conversationId ? `/messages?conversationId=${conversationId}` : "/messages",
      },
    });
    emitToRole("superAdmin", "notification:new", {
      id: createNotificationId(`${String(request._id)}-admin`),
      type: "success",
      title: "Provider accepted admin request",
      description: `${req.user.firstName || "A provider"} accepted request ${request.requestNumber}.`,
      unread: true,
      createdAt: new Date().toISOString(),
      data: {
        notificationType: "admin_service_request_accepted",
        requestId: String(request._id),
        requestNumber: request.requestNumber,
        conversationId,
        targetPath: `/service-requests?requestId=${String(request._id)}`,
      },
    });

    (request.adminInvitations || []).forEach((item) => {
      const providerId = String(item.providerId?._id || item.providerId || "");
      if (!providerId || providerId === String(req.user.id) || String(item.status || "") !== "unavailable") return;
      emitToUser(providerId, "notification:new", {
        id: createNotificationId(`${String(request._id)}-${providerId}`),
        type: "warning",
        title: "Request already accepted",
        description: `Another provider already accepted ${request.requestNumber}, so you can no longer accept it.`,
        unread: true,
        createdAt: new Date().toISOString(),
        data: {
          notificationType: "admin_service_request_unavailable",
          requestId: String(request._id),
          requestNumber: request.requestNumber,
          targetPath: "/provider/requests",
        },
      });
    });

    return res.status(200).json({
      success: true,
      message: "Negotiation started with the client.",
      data: {
        request: buildRequestSummary(request, req.user.id),
        conversationId,
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
  inviteProvidersToServiceRequest,
  respondToAdminServiceRequestInvitation,
  acceptServiceRequest,
  ignoreServiceRequest,
};
