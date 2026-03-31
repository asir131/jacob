const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const OtpVerification = require("../models/OtpVerification");
const RefreshToken = require("../models/RefreshToken");
const generateOtp = require("../utils/generateOtp");
const { sendOtpEmail } = require("../utils/sendEmail");

const OTP_EXP_MINUTES = 10;
const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = "30d";

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
        message: "User already exists with this email.",
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
        message: "User already verified with this email.",
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

module.exports = {
  signup,
  verifySignupOtp,
  login,
  refreshAccessToken,
  logout,
};
