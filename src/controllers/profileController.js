const User = require("../models/User");
const cloudinary = require("../config/cloudinary");
const bcrypt = require("bcryptjs");

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
    ).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng");

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
        user: {
          id: updatedUser._id,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          email: updatedUser.email,
          role: updatedUser.role,
          avatar: updatedUser.avatar,
          phone: updatedUser.phone || "",
          address: updatedUser.address || "",
          preferredLanguage: updatedUser.preferredLanguage || "English (US)",
          locationLat: typeof updatedUser.locationLat === "number" ? updatedUser.locationLat : null,
          locationLng: typeof updatedUser.locationLng === "number" ? updatedUser.locationLng : null,
          businessBio: updatedUser.businessBio || "",
          experienceLevel: updatedUser.experienceLevel || "",
          serviceCity: updatedUser.serviceCity || "",
          serviceLocationLat:
            typeof updatedUser.serviceLocationLat === "number" ? updatedUser.serviceLocationLat : null,
          serviceLocationLng:
            typeof updatedUser.serviceLocationLng === "number" ? updatedUser.serviceLocationLng : null,
        },
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
    }).select("_id firstName lastName email role avatar phone address preferredLanguage locationLat locationLng businessBio experienceLevel serviceCity serviceLocationLat serviceLocationLng");

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
        user: {
          id: updatedUser._id,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          email: updatedUser.email,
          role: updatedUser.role,
          avatar: updatedUser.avatar,
          phone: updatedUser.phone || "",
          address: updatedUser.address || "",
          preferredLanguage: updatedUser.preferredLanguage || "English (US)",
          locationLat: typeof updatedUser.locationLat === "number" ? updatedUser.locationLat : null,
          locationLng: typeof updatedUser.locationLng === "number" ? updatedUser.locationLng : null,
          businessBio: updatedUser.businessBio || "",
          experienceLevel: updatedUser.experienceLevel || "",
          serviceCity: updatedUser.serviceCity || "",
          serviceLocationLat:
            typeof updatedUser.serviceLocationLat === "number" ? updatedUser.serviceLocationLat : null,
          serviceLocationLng:
            typeof updatedUser.serviceLocationLng === "number" ? updatedUser.serviceLocationLng : null,
        },
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
  uploadAvatar,
  updateProfile,
  changePassword,
};
