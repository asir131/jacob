const Category = require("../models/Category");
const Gig = require("../models/Gig");
const GigRequest = require("../models/GigRequest");
const cloudinary = require("../config/cloudinary");
const slugify = require("../utils/slugify");
const { emitToRole, emitToUser } = require("../socket");

const DEFAULT_CATEGORY_ICON = "ShieldCheck";
const DEFAULT_PACKAGE_NAMES = ["Basic", "Standard", "Premium"];
const MAX_GIG_IMAGES = 4;

const isCustomCategorySlug = (categorySlug = "", customCategoryName = "") => {
  return categorySlug === "create-your-own-category" || Boolean(String(customCategoryName).trim());
};

const buildCustomCategoryPayload = ({ customCategoryName, customCategoryDescription, customCategoryIconName, providerId }) => {
  const name = String(customCategoryName || "").trim();
  const slug = slugify(name);

  return {
    name,
    slug,
    description: String(customCategoryDescription || "").trim(),
    iconName: String(customCategoryIconName || "").trim() || DEFAULT_CATEGORY_ICON,
    color: "text-slate-600",
    bgGradient: "from-slate-100 to-white",
    isCustom: true,
    status: "pending",
    createdBy: providerId,
  };
};

const normalizePackages = (packages = []) => {
  return DEFAULT_PACKAGE_NAMES.map((name, index) => {
    const item = Array.isArray(packages) ? packages[index] || {} : {};
    return {
      name,
      title: String(item.title || "").trim(),
      description: String(item.description || "").trim(),
      deliveryTime: String(item.deliveryTime || "").trim(),
      price: Number(item.price) || 0,
    };
  });
};

const normalizeImages = (images = []) => {
  if (!Array.isArray(images)) return [];
  return images.filter((image) => typeof image === "string" && image.trim()).slice(0, 4);
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

const uploadGigImages = async (files = []) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const limitedFiles = files.slice(0, MAX_GIG_IMAGES);
  const uploads = await Promise.all(
    limitedFiles.map((file) => uploadBufferToCloudinary(file.buffer, "jacob/gig-images"))
  );
  return uploads
    .map((result) => result?.secure_url)
    .filter((url) => typeof url === "string" && url.trim());
};

const parseGigRequestBody = (req) => {
  const title = String(req.body.title || "").trim();
  const categorySlug = String(req.body.categorySlug || "").trim();
  const categoryName = String(req.body.categoryName || "").trim();
  const description = String(req.body.description || "").trim();
  const requirements = String(req.body.requirements || "").trim();
  const baseCity = String(req.body.baseCity || "").trim();
  const customCategoryName = String(req.body.customCategoryName || "").trim();
  const customCategoryDescription = String(req.body.customCategoryDescription || "").trim();
  const customCategoryIconName = String(req.body.customCategoryIconName || "").trim();
  const locationLat = req.body.locationLat === "" || req.body.locationLat === undefined || req.body.locationLat === null
    ? null
    : Number(req.body.locationLat);
  const locationLng = req.body.locationLng === "" || req.body.locationLng === undefined || req.body.locationLng === null
    ? null
    : Number(req.body.locationLng);
  const travelRadiusKm = req.body.travelRadiusKm === "" || req.body.travelRadiusKm === undefined || req.body.travelRadiusKm === null
    ? null
    : Number(req.body.travelRadiusKm);
  const packages = parseJsonField(req.body.packages, []);
  const images = normalizeImages(parseJsonField(req.body.images, []));

  return {
    title,
    categorySlug,
    categoryName,
    description,
    requirements,
    baseCity,
    customCategoryName,
    customCategoryDescription,
    customCategoryIconName,
    locationLat,
    locationLng,
    travelRadiusKm,
    packages,
    images,
  };
};

const parseJsonField = (value, fallback) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const createGig = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can create gigs.",
      });
    }

    const {
      title,
      categorySlug,
      categoryName,
      description,
      requirements,
      baseCity,
      customCategoryName,
      customCategoryDescription,
      customCategoryIconName,
      locationLat,
      locationLng,
      travelRadiusKm,
      packages,
      images: parsedImages,
    } = parseGigRequestBody(req);
    const uploadedImages = await uploadGigImages(req.files || []);
    const images = normalizeImages(
      parsedImages.concat(uploadedImages)
    );

    if (!title || !categorySlug || !categoryName) {
      return res.status(400).json({
        success: false,
        message: "Title, category slug and category name are required.",
      });
    }

    const customRequested = isCustomCategorySlug(categorySlug, customCategoryName);
    const normalizedCategorySlug = customRequested ? slugify(customCategoryName) : String(categorySlug).trim().toLowerCase();

    if (customRequested && !normalizedCategorySlug) {
      return res.status(400).json({
        success: false,
        message: "Custom category name is required.",
      });
    }

    if (customRequested) {
      const categoryPayload = buildCustomCategoryPayload({
        customCategoryName,
        customCategoryDescription,
        customCategoryIconName,
        providerId: req.user.id,
      });

      const category = await Category.findOneAndUpdate(
        { slug: categoryPayload.slug },
        categoryPayload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const gigRequest = await GigRequest.create({
        providerId: req.user.id,
        title,
        categorySlug: category.slug,
        categoryName: category.name,
        isCustomCategory: true,
        customCategoryName: category.name,
        customCategoryDescription: category.description,
        customCategoryIconName: category.iconName,
        description,
        requirements,
        packages: normalizePackages(packages),
        images,
        baseCity: String(baseCity || "").trim(),
        locationLat: typeof locationLat === "number" ? locationLat : null,
        locationLng: typeof locationLng === "number" ? locationLng : null,
        travelRadiusKm: Number(travelRadiusKm) || null,
        status: "pending_approval",
        categoryRef: category._id,
      });

      emitToRole("superAdmin", "gig:approval:requested", {
        id: gigRequest._id.toString(),
        title: gigRequest.title,
        categorySlug: gigRequest.categorySlug,
        categoryName: gigRequest.categoryName,
        customCategoryName: gigRequest.customCategoryName,
        customCategoryDescription: gigRequest.customCategoryDescription,
        customCategoryIconName: gigRequest.customCategoryIconName,
        provider: {
          id: req.user.id,
          firstName: req.user.firstName || "",
          lastName: req.user.lastName || "",
          email: req.user.email || "",
        },
        createdAt: gigRequest.createdAt,
        status: gigRequest.status,
      });

      emitToRole("superAdmin", "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "system",
        title: "New custom category request",
        description: `${req.user.firstName || "A provider"} submitted ${gigRequest.customCategoryName || gigRequest.categoryName} for approval.`,
        data: {
          requestId: gigRequest._id.toString(),
          categorySlug: gigRequest.categorySlug,
          categoryName: gigRequest.categoryName,
          customCategoryName: gigRequest.customCategoryName,
        },
        unread: true,
        createdAt: new Date().toISOString(),
      });

      return res.status(201).json({
        success: true,
        message: "Custom category request sent for admin approval.",
        data: {
          gigRequest,
          category,
        },
      });
    }

    const gig = await Gig.create({
      providerId: req.user.id,
      title,
      categorySlug: normalizedCategorySlug,
      categoryName,
      description,
      requirements,
      packages: normalizePackages(packages),
      images,
      baseCity: String(baseCity || "").trim(),
      locationLat: typeof locationLat === "number" ? locationLat : null,
      locationLng: typeof locationLng === "number" ? locationLng : null,
      travelRadiusKm: Number(travelRadiusKm) || null,
      status: "published",
      publishedAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      message: "Gig published successfully.",
      data: {
        gig,
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateGig = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can update gigs.",
      });
    }

    const { id } = req.params;
    const gig = await Gig.findById(id);
    const gigRequest = gig ? null : await GigRequest.findById(id);
    const existingRecord = gig || gigRequest;

    if (!existingRecord) {
      return res.status(404).json({
        success: false,
        message: "Gig not found.",
      });
    }

    if (String(existingRecord.providerId) !== String(req.user.id) && req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this gig.",
      });
    }

    const {
      title,
      categorySlug,
      categoryName,
      description,
      requirements,
      baseCity,
      customCategoryName,
      customCategoryDescription,
      customCategoryIconName,
      locationLat,
      locationLng,
      travelRadiusKm,
      packages,
      images: parsedImages,
    } = parseGigRequestBody(req);
    const uploadedImages = await uploadGigImages(req.files || []);
    const images = normalizeImages(parsedImages.concat(uploadedImages));

    if (!title || !categorySlug || !categoryName) {
      return res.status(400).json({
        success: false,
        message: "Title, category slug and category name are required.",
      });
    }

    const customRequested = isCustomCategorySlug(categorySlug, customCategoryName);
    const normalizedCategorySlug = customRequested ? slugify(customCategoryName) : String(categorySlug).trim().toLowerCase();

    if (customRequested && !normalizedCategorySlug) {
      return res.status(400).json({
        success: false,
        message: "Custom category name is required.",
      });
    }

    const normalizedPackages = normalizePackages(packages);
    const existingCustomFields = {
      customCategoryName: String(existingRecord.customCategoryName || "").trim(),
      customCategoryDescription: String(existingRecord.customCategoryDescription || "").trim(),
      customCategoryIconName: String(existingRecord.customCategoryIconName || "").trim(),
    };
    const customFieldsChanged =
      customRequested &&
      (
        existingCustomFields.customCategoryName !== customCategoryName ||
        existingCustomFields.customCategoryDescription !== customCategoryDescription
      );

    const categoryPayload = customRequested
      ? buildCustomCategoryPayload({
          customCategoryName,
          customCategoryDescription,
          customCategoryIconName,
          providerId: req.user.id,
        })
      : null;

    if (gigRequest) {
      if (customRequested) {
        const category = await Category.findOneAndUpdate(
          { slug: categoryPayload.slug },
          categoryPayload,
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        gigRequest.title = title;
        gigRequest.categorySlug = category.slug;
        gigRequest.categoryName = category.name;
        gigRequest.isCustomCategory = true;
        gigRequest.customCategoryName = category.name;
        gigRequest.customCategoryDescription = category.description;
        gigRequest.customCategoryIconName = category.iconName;
        gigRequest.description = description;
        gigRequest.requirements = requirements;
        gigRequest.packages = normalizedPackages;
        gigRequest.images = images;
        gigRequest.baseCity = baseCity;
        gigRequest.locationLat = typeof locationLat === "number" ? locationLat : null;
        gigRequest.locationLng = typeof locationLng === "number" ? locationLng : null;
        gigRequest.travelRadiusKm = Number(travelRadiusKm) || null;
        gigRequest.status = "pending_approval";
        gigRequest.categoryRef = category._id;
        gigRequest.rejectionReason = "";
        gigRequest.reviewedBy = null;
        gigRequest.reviewedAt = null;
        await gigRequest.save();

        emitToRole("superAdmin", "gig:approval:requested", {
          id: gigRequest._id.toString(),
          title: gigRequest.title,
          categorySlug: gigRequest.categorySlug,
          categoryName: gigRequest.categoryName,
          customCategoryName: gigRequest.customCategoryName,
          customCategoryDescription: gigRequest.customCategoryDescription,
          customCategoryIconName: gigRequest.customCategoryIconName,
          provider: {
            id: req.user.id,
            firstName: req.user.firstName || "",
            lastName: req.user.lastName || "",
            email: req.user.email || "",
          },
          createdAt: gigRequest.createdAt,
          status: gigRequest.status,
        });

        emitToRole("superAdmin", "notification:new", {
          id: `NTF-${Date.now()}`,
          type: "system",
          title: "Custom category request updated",
          description: `${req.user.firstName || "A provider"} updated ${gigRequest.customCategoryName || gigRequest.categoryName} for approval.`,
          data: {
            requestId: gigRequest._id.toString(),
            categorySlug: gigRequest.categorySlug,
            categoryName: gigRequest.categoryName,
            customCategoryName: gigRequest.customCategoryName,
          },
          unread: true,
          createdAt: new Date().toISOString(),
        });

        return res.status(200).json({
          success: true,
          message: "Gig request updated and sent for admin approval.",
          data: {
            gigRequest,
            category,
          },
        });
      }

      gig.title = title;
      gig.categorySlug = normalizedCategorySlug;
      gig.categoryName = categoryName;
      gig.customCategoryName = "";
      gig.customCategoryDescription = "";
      gig.customCategoryIconName = "";
      gig.description = description;
      gig.requirements = requirements;
      gig.packages = normalizedPackages;
      gig.images = images;
      gig.baseCity = baseCity;
      gig.locationLat = typeof locationLat === "number" ? locationLat : null;
      gig.locationLng = typeof locationLng === "number" ? locationLng : null;
      gig.travelRadiusKm = Number(travelRadiusKm) || null;
      gig.status = gig.status === "draft" ? "draft" : "published";
      if (gig.status === "published") {
        gig.publishedAt = gig.publishedAt || new Date();
      }
      await gig.save();

      return res.status(200).json({
        success: true,
        message: "Gig updated successfully.",
        data: {
          gig,
        },
      });
    }

    gig.title = title;
    gig.categorySlug = normalizedCategorySlug;
    gig.categoryName = categoryName;
    gig.customCategoryName = customCategoryName;
    gig.customCategoryDescription = customCategoryDescription;
    gig.customCategoryIconName = customCategoryIconName;
    gig.description = description;
    gig.requirements = requirements;
    gig.packages = normalizedPackages;
    gig.images = images;
    gig.baseCity = baseCity;
    gig.locationLat = typeof locationLat === "number" ? locationLat : null;
    gig.locationLng = typeof locationLng === "number" ? locationLng : null;
    gig.travelRadiusKm = Number(travelRadiusKm) || null;
    if (customRequested && customFieldsChanged) {
      const category = await Category.findOneAndUpdate(
        { slug: categoryPayload.slug },
        categoryPayload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const existingPendingRequest = await GigRequest.findOne({
        gigRef: gig._id,
        status: "pending_approval",
      });

      const gigRequest = existingPendingRequest || new GigRequest({
        providerId: req.user.id,
        gigRef: gig._id,
      });

      gigRequest.title = title;
      gigRequest.categorySlug = category.slug;
      gigRequest.categoryName = category.name;
      gigRequest.isCustomCategory = true;
      gigRequest.customCategoryName = category.name;
      gigRequest.customCategoryDescription = category.description;
      gigRequest.customCategoryIconName = category.iconName;
      gigRequest.description = description;
      gigRequest.requirements = requirements;
      gigRequest.packages = normalizedPackages;
      gigRequest.images = images;
      gigRequest.baseCity = baseCity;
      gigRequest.locationLat = typeof locationLat === "number" ? locationLat : null;
      gigRequest.locationLng = typeof locationLng === "number" ? locationLng : null;
      gigRequest.travelRadiusKm = Number(travelRadiusKm) || null;
      gigRequest.status = "pending_approval";
      gigRequest.categoryRef = category._id;
      gigRequest.rejectionReason = "";
      gigRequest.reviewedBy = null;
      gigRequest.reviewedAt = null;
      await gigRequest.save();

      emitToRole("superAdmin", "gig:approval:requested", {
        id: gigRequest._id.toString(),
        title: gigRequest.title,
        categorySlug: gigRequest.categorySlug,
        categoryName: gigRequest.categoryName,
        customCategoryName: gigRequest.customCategoryName,
        customCategoryDescription: gigRequest.customCategoryDescription,
        customCategoryIconName: gigRequest.customCategoryIconName,
        provider: {
          id: req.user.id,
          firstName: req.user.firstName || "",
          lastName: req.user.lastName || "",
          email: req.user.email || "",
        },
        createdAt: gigRequest.createdAt,
        status: gigRequest.status,
      });

      emitToRole("superAdmin", "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "system",
        title: "Custom category change awaiting approval",
        description: `${req.user.firstName || "A provider"} changed ${gigRequest.customCategoryName || gigRequest.categoryName} and it needs approval again.`,
        data: {
          requestId: gigRequest._id.toString(),
          categorySlug: gigRequest.categorySlug,
          categoryName: gigRequest.categoryName,
          customCategoryName: gigRequest.customCategoryName,
        },
        unread: true,
        createdAt: new Date().toISOString(),
      });

      return res.status(200).json({
        success: true,
        message: "Custom category changes sent for admin approval.",
        data: {
          gigRequest,
          category,
        },
      });
    }

    await gig.save();

    return res.status(200).json({
      success: true,
      message: "Gig updated successfully.",
      data: {
        gig,
      },
    });
  } catch (error) {
    next(error);
  }
};

const listPendingGigRequests = async (req, res, next) => {
  try {
    const gigRequests = await GigRequest.find({ status: "pending_approval" })
      .populate("providerId", "firstName lastName email role avatar")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      message: "Pending gig requests fetched successfully.",
      data: gigRequests,
    });
  } catch (error) {
    next(error);
  }
};

const deleteGig = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can delete gigs.",
      });
    }

    const { id } = req.params;
    const gig = await Gig.findById(id);

    if (!gig) {
      return res.status(404).json({
        success: false,
        message: "Gig not found.",
      });
    }

    if (String(gig.providerId) !== String(req.user.id) && req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this gig.",
      });
    }

    await Promise.all([
      GigRequest.deleteMany({ gigRef: gig._id }),
      Gig.deleteOne({ _id: gig._id }),
    ]);

    res.status(200).json({
      success: true,
      message: "Gig deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
};

const deleteGigRequest = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can delete gig requests.",
      });
    }

    const { id } = req.params;
    const gigRequest = await GigRequest.findById(id);

    if (!gigRequest) {
      return res.status(404).json({
        success: false,
        message: "Gig request not found.",
      });
    }

    if (String(gigRequest.providerId) !== String(req.user.id) && req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this gig request.",
      });
    }

    const deleteOperations = [GigRequest.deleteOne({ _id: gigRequest._id })];
    if (gigRequest.gigRef) {
      deleteOperations.push(Gig.deleteOne({ _id: gigRequest.gigRef }));
      deleteOperations.push(GigRequest.deleteMany({ gigRef: gigRequest.gigRef }));
    }

    await Promise.all(deleteOperations);

    res.status(200).json({
      success: true,
      message: "Gig request deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
};

const approveGigRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { iconName, rejectionReason } = req.body;

    const gigRequest = await GigRequest.findById(id);
    if (!gigRequest) {
      return res.status(404).json({
        success: false,
        message: "Gig request not found.",
      });
    }

    if (gigRequest.status === "published") {
      return res.status(400).json({
        success: false,
        message: "Gig request is already published.",
      });
    }

    const category = await Category.findOneAndUpdate(
      { slug: gigRequest.categorySlug },
      {
        name: gigRequest.customCategoryName || gigRequest.categoryName,
        slug: gigRequest.categorySlug,
        description: gigRequest.customCategoryDescription || "",
        iconName: String(iconName || gigRequest.customCategoryIconName || DEFAULT_CATEGORY_ICON).trim() || DEFAULT_CATEGORY_ICON,
        color: "text-slate-600",
        bgGradient: "from-slate-100 to-white",
        isCustom: true,
        status: "approved",
        approvedBy: req.user.id,
        approvedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    let gig = gigRequest.gigRef ? await Gig.findById(gigRequest.gigRef) : null;
    if (gig) {
      gig.providerId = gigRequest.providerId;
      gig.title = gigRequest.title;
      gig.categorySlug = category.slug;
      gig.categoryName = category.name;
      gig.customCategoryName = category.name;
      gig.customCategoryDescription = category.description;
      gig.customCategoryIconName = category.iconName;
      gig.description = gigRequest.description;
      gig.requirements = gigRequest.requirements;
      gig.packages = gigRequest.packages || [];
      gig.images = gigRequest.images || [];
      gig.baseCity = gigRequest.baseCity || "";
      gig.locationLat = typeof gigRequest.locationLat === "number" ? gigRequest.locationLat : null;
      gig.locationLng = typeof gigRequest.locationLng === "number" ? gigRequest.locationLng : null;
      gig.travelRadiusKm = typeof gigRequest.travelRadiusKm === "number" ? gigRequest.travelRadiusKm : null;
      gig.status = "published";
      gig.approvedBy = req.user.id;
      gig.approvedAt = new Date();
      gig.publishedAt = new Date();
      await gig.save();
    } else {
      gig = await Gig.create({
        providerId: gigRequest.providerId,
        title: gigRequest.title,
        categorySlug: category.slug,
        categoryName: category.name,
        customCategoryName: category.name,
        customCategoryDescription: category.description,
        customCategoryIconName: category.iconName,
        description: gigRequest.description,
        requirements: gigRequest.requirements,
        packages: gigRequest.packages || [],
        images: gigRequest.images || [],
        baseCity: gigRequest.baseCity || "",
        locationLat: typeof gigRequest.locationLat === "number" ? gigRequest.locationLat : null,
        locationLng: typeof gigRequest.locationLng === "number" ? gigRequest.locationLng : null,
        travelRadiusKm: typeof gigRequest.travelRadiusKm === "number" ? gigRequest.travelRadiusKm : null,
        status: "published",
        approvedBy: req.user.id,
        approvedAt: new Date(),
        publishedAt: new Date(),
      });
    }

    gigRequest.status = "published";
    gigRequest.categoryRef = category._id;
    gigRequest.gigRef = gig._id;
    gigRequest.reviewedBy = req.user.id;
    gigRequest.reviewedAt = new Date();
    gigRequest.rejectionReason = "";
    await gigRequest.save();

    emitToUser(String(gigRequest.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "success",
      title: "Your gig has been approved",
      description: `${category.name} is now live and visible in the categories list.`,
      data: {
        requestId: gigRequest._id.toString(),
        gigId: gig._id.toString(),
        categorySlug: category.slug,
        categoryName: category.name,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: "Gig request approved and published successfully.",
      data: {
        category,
        gig,
        gigRequest,
      },
    });
  } catch (error) {
    next(error);
  }
};

const listMyGigs = async (req, res, next) => {
  try {
    if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only providers can view gigs.",
      });
    }

    const [publishedGigs, pendingRequests] = await Promise.all([
      Gig.find({ providerId: req.user.id }).sort({ createdAt: -1 }).lean(),
      GigRequest.find({ providerId: req.user.id }).sort({ createdAt: -1 }).lean(),
    ]);

    res.status(200).json({
      success: true,
      message: "My gigs fetched successfully.",
      data: {
        publishedGigs,
        pendingRequests,
      },
    });
  } catch (error) {
    next(error);
  }
};

const rejectGigRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rejectionReason = "" } = req.body;

    const gigRequest = await GigRequest.findById(id);
    if (!gigRequest) {
      return res.status(404).json({
        success: false,
        message: "Gig request not found.",
      });
    }

    gigRequest.status = "rejected";
    gigRequest.reviewedBy = req.user.id;
    gigRequest.reviewedAt = new Date();
    gigRequest.rejectionReason = String(rejectionReason).trim();
    await gigRequest.save();

    if (gigRequest.categoryRef) {
      await Category.findByIdAndUpdate(gigRequest.categoryRef, {
        status: "rejected",
        approvedBy: req.user.id,
        approvedAt: null,
      });
    }

    emitToUser(String(gigRequest.providerId), "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
      title: "Your gig was rejected",
      description: gigRequest.rejectionReason || "An admin rejected your custom category request.",
      data: {
        requestId: gigRequest._id.toString(),
        categorySlug: gigRequest.categorySlug,
        categoryName: gigRequest.categoryName,
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: "Gig request rejected.",
      data: gigRequest,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createGig,
  updateGig,
  listMyGigs,
  listPendingGigRequests,
  deleteGig,
  deleteGigRequest,
  approveGigRequest,
  rejectGigRequest,
};
