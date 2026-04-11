const User = require("../models/User");
const cloudinary = require("../config/cloudinary");
const bcrypt = require("bcryptjs");
const { emitToRole, emitToUser } = require("../socket");

const PAYOUT_STATUS = {
  UNVERIFIED: "unverified",
  PENDING: "pending",
  VERIFIED: "verified",
  REJECTED: "rejected",
};

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
    ).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn payoutInfo");

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
    }).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn payoutInfo");

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
      "_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng payoutVerificationStatus walletBalance totalEarnings totalWithdrawn payoutInfo"
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
  uploadAvatar,
  updateProfile,
  changePassword,
  submitPayoutInfo,
  listProviderVerifications,
  getProviderVerificationDetails,
  approveProviderVerification,
  rejectProviderVerification,
};
