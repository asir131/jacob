const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const OtpVerification = require("../models/OtpVerification");
const PasswordResetOtp = require("../models/PasswordResetOtp");
const RefreshToken = require("../models/RefreshToken");
const generateOtp = require("../utils/generateOtp");
const { sendOtpEmail, sendPasswordResetOtpEmail } = require("../utils/sendEmail");

const OTP_EXP_MINUTES = 10;
const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = "30d";
const googleClient = new OAuth2Client();

const getGoogleAudiences = () =>
  [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

const createAccessToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
};

const createRefreshToken = async (user) => {
  const jti = crypto.randomUUID();
  const refreshToken = jwt.sign(
    {
      userId: user._id,
      jti,
    },
    process.env.JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  const decoded = jwt.decode(refreshToken);
  const expiresAt = new Date(decoded.exp * 1000);
  const tokenHash = await bcrypt.hash(refreshToken, 10);

  await RefreshToken.create({
    userId: user._id,
    jti,
    tokenHash,
    expiresAt,
    revoked: false,
  });

  return refreshToken;
};

const buildAuthPayload = (user, accessToken, refreshToken) => {
  return {
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      avatar: user.avatar || "",
      phone: user.phone || "",
      address: user.address || "",
      preferredLanguage: user.preferredLanguage || "English (US)",
      locationLat: typeof user.locationLat === "number" ? user.locationLat : null,
      locationLng: typeof user.locationLng === "number" ? user.locationLng : null,
      businessBio: user.businessBio || "",
      experienceLevel: user.experienceLevel || "",
      serviceCity: user.serviceCity || "",
      serviceLocationLat:
        typeof user.serviceLocationLat === "number" ? user.serviceLocationLat : null,
      serviceLocationLng:
        typeof user.serviceLocationLng === "number" ? user.serviceLocationLng : null,
      payoutVerificationStatus: user.payoutVerificationStatus || "unverified",
      walletBalance: Number(user.walletBalance) || 0,
      totalEarnings: Number(user.totalEarnings) || 0,
      totalWithdrawn: Number(user.totalWithdrawn) || 0,
      averageRating: Number(user.averageRating) || 0,
      reviewCount: Number(user.reviewCount) || 0,
      sellerLevel: user.sellerLevel || "New",
      savedServiceIds: Array.isArray(user.savedServiceIds) ? user.savedServiceIds.map((item) => String(item)) : [],
      payoutInfo: {
        accountHolderName: user?.payoutInfo?.accountHolderName || "",
        bankAccountNumber: user?.payoutInfo?.bankAccountNumber || "",
        routingNumber: user?.payoutInfo?.routingNumber || "",
        bankName: user?.payoutInfo?.bankName || "",
        accountType: user?.payoutInfo?.accountType || "",
        nidFrontImageUrl: user?.payoutInfo?.nidFrontImageUrl || "",
        nidBackImageUrl: user?.payoutInfo?.nidBackImageUrl || "",
        submittedAt: user?.payoutInfo?.submittedAt || null,
        reviewedAt: user?.payoutInfo?.reviewedAt || null,
        rejectionReason: user?.payoutInfo?.rejectionReason || "",
      },
    },
  };
};

const signup = async (req, res, next) => {
  try {
    const { firstName, lastName, email, password, role } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already in use",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXP_MINUTES * 60 * 1000);

    await OtpVerification.findOneAndUpdate(
      { email: normalizedEmail },
      {
        firstName,
        lastName,
        email: normalizedEmail,
        password: hashedPassword,
        role,
        otp,
        expiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendOtpEmail({ email: normalizedEmail, firstName, otp });

    res.status(200).json({
      success: true,
      message: "OTP sent to email. Verify OTP to complete signup.",
      data: {
        email: normalizedEmail,
        otpExpiresInMinutes: OTP_EXP_MINUTES,
      },
    });
  } catch (error) {
    next(error);
  }
};

const verifySignupOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const pendingSignup = await OtpVerification.findOne({
      email: normalizedEmail,
    });

    if (!pendingSignup) {
      return res.status(404).json({
        success: false,
        message: "No pending signup found for this email.",
      });
    }

    if (pendingSignup.expiresAt.getTime() < Date.now()) {
      await OtpVerification.deleteOne({ _id: pendingSignup._id });
      return res.status(400).json({
        success: false,
        message: "OTP expired. Please signup again.",
      });
    }

    if (pendingSignup.otp !== String(otp)) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    const createdUser = await User.create({
      firstName: pendingSignup.firstName,
      lastName: pendingSignup.lastName,
      email: pendingSignup.email,
      password: pendingSignup.password,
      role: pendingSignup.role,
      isVerified: true,
    });

    await OtpVerification.deleteOne({ _id: pendingSignup._id });

    res.status(201).json({
      success: true,
      message: "Signup confirmed successfully.",
      data: {
        id: createdUser._id,
        firstName: createdUser.firstName,
        lastName: createdUser.lastName,
        email: createdUser.email,
        role: createdUser.role,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Email already in use",
      });
    }
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const accessToken = createAccessToken(user);
    const refreshToken = await createRefreshToken(user);

    res.status(200).json({
      success: true,
      message: "Login successful.",
      data: buildAuthPayload(user, accessToken, refreshToken),
    });
  } catch (error) {
    next(error);
  }
};

const refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    const storedToken = await RefreshToken.findOne({
      userId: decoded.userId,
      jti: decoded.jti,
      revoked: false,
      expiresAt: { $gt: new Date() },
    });

    if (!storedToken) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token.",
      });
    }

    const isTokenMatch = await bcrypt.compare(refreshToken, storedToken.tokenHash);
    if (!isTokenMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token.",
      });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found.",
      });
    }

    storedToken.revoked = true;
    await storedToken.save();

    const newAccessToken = createAccessToken(user);
    const newRefreshToken = await createRefreshToken(user);

    res.status(200).json({
      success: true,
      message: "Token refreshed successfully.",
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired refresh token.",
      });
    }
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    await RefreshToken.findOneAndUpdate(
      { userId: decoded.userId, jti: decoded.jti, revoked: false },
      { revoked: true }
    );

    res.status(200).json({
      success: true,
      message: "Logout successful.",
    });
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired refresh token.",
      });
    }
    next(error);
  }
};

const loginWithGoogle = async (req, res, next) => {
  try {
    const { idToken, role = "client" } = req.body;
    const audiences = getGoogleAudiences();

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google login token is required.",
      });
    }

    if (!audiences.length) {
      return res.status(500).json({
        success: false,
        message: "Google login is not configured on the server.",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences,
    });
    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      return res.status(401).json({
        success: false,
        message: "Google account email is not verified.",
      });
    }

    const normalizedEmail = payload.email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      const requestedRole = ["client", "provider"].includes(role) ? role : "client";
      const fallbackName = normalizedEmail.split("@")[0] || "Google User";
      const firstName = String(payload.given_name || payload.name || fallbackName).trim();
      const lastName = String(payload.family_name || "").trim();

      user = await User.create({
        firstName,
        lastName,
        email: normalizedEmail,
        password: await bcrypt.hash(crypto.randomUUID(), 10),
        role: requestedRole,
        avatar: payload.picture || "",
        authProvider: "google",
        googleId: payload.sub || "",
        isVerified: true,
      });
    } else {
      let shouldSave = false;
      if (!user.googleId && payload.sub) {
        user.googleId = payload.sub;
        shouldSave = true;
      }
      if (user.authProvider !== "google") {
        user.authProvider = "google";
        shouldSave = true;
      }
      if (!user.avatar && payload.picture) {
        user.avatar = payload.picture;
        shouldSave = true;
      }
      if (!user.isVerified) {
        user.isVerified = true;
        shouldSave = true;
      }
      if (shouldSave) await user.save();
    }

    const accessToken = createAccessToken(user);
    const refreshToken = await createRefreshToken(user);

    return res.status(200).json({
      success: true,
      message: "Google login successful.",
      data: buildAuthPayload(user, accessToken, refreshToken),
    });
  } catch (error) {
    if (error.message?.includes("Wrong number of segments") || error.message?.includes("Token used too late")) {
      return res.status(401).json({
        success: false,
        message: "Invalid Google login token.",
      });
    }
    return next(error);
  }
};

const requestPasswordResetOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No account found with this email.",
      });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXP_MINUTES * 60 * 1000);

    await PasswordResetOtp.findOneAndUpdate(
      { email: normalizedEmail },
      {
        email: normalizedEmail,
        userId: user._id,
        otp,
        resetToken: "",
        verifiedAt: null,
        expiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendPasswordResetOtpEmail({
      email: normalizedEmail,
      firstName: user.firstName,
      otp,
    });

    return res.status(200).json({
      success: true,
      message: "OTP sent to your email.",
      data: {
        email: normalizedEmail,
        otpExpiresInMinutes: OTP_EXP_MINUTES,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const verifyPasswordResetOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const resetRequest = await PasswordResetOtp.findOne({ email: normalizedEmail });
    if (!resetRequest) {
      return res.status(404).json({
        success: false,
        message: "No password reset request found for this email.",
      });
    }

    if (resetRequest.expiresAt.getTime() < Date.now()) {
      await PasswordResetOtp.deleteOne({ _id: resetRequest._id });
      return res.status(400).json({
        success: false,
        message: "OTP expired. Please request a new code.",
      });
    }

    if (resetRequest.otp !== String(otp)) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    resetRequest.verifiedAt = new Date();
    resetRequest.resetToken = crypto.randomUUID();
    await resetRequest.save();

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      data: {
        email: normalizedEmail,
        resetToken: resetRequest.resetToken,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const resetPasswordWithOtp = async (req, res, next) => {
  try {
    const { email, otp, resetToken, newPassword } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const resetRequest = await PasswordResetOtp.findOne({ email: normalizedEmail });
    if (!resetRequest) {
      return res.status(404).json({
        success: false,
        message: "No password reset request found for this email.",
      });
    }

    if (resetRequest.expiresAt.getTime() < Date.now()) {
      await PasswordResetOtp.deleteOne({ _id: resetRequest._id });
      return res.status(400).json({
        success: false,
        message: "OTP expired. Please request a new code.",
      });
    }

    if (resetRequest.otp !== String(otp) || !resetRequest.verifiedAt || resetRequest.resetToken !== String(resetToken)) {
      return res.status(400).json({
        success: false,
        message: "Password reset session is invalid. Please verify OTP again.",
      });
    }

    const user = await User.findById(resetRequest.userId);
    if (!user) {
      await PasswordResetOtp.deleteOne({ _id: resetRequest._id });
      return res.status(404).json({
        success: false,
        message: "User not found.",
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

    await PasswordResetOtp.deleteOne({ _id: resetRequest._id });

    return res.status(200).json({
      success: true,
      message: "Password reset successful.",
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  signup,
  verifySignupOtp,
  login,
  loginWithGoogle,
  refreshAccessToken,
  logout,
  requestPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPasswordWithOtp,
};
