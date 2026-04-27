const express = require("express");
const {
  signup,
  verifySignupOtp,
  login,
  refreshAccessToken,
  logout,
  requestPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPasswordWithOtp,
} = require("../controllers/authController");
const {
  validateSignupRequest,
  validateVerifyOtpRequest,
  validateLoginRequest,
  validateRefreshTokenRequest,
  validateForgotPasswordRequest,
  validateResetPasswordRequest,
} = require("../middlewares/validateRequest");

const router = express.Router();

router.post("/signup", validateSignupRequest, signup);
router.post("/verify-signup-otp", validateVerifyOtpRequest, verifySignupOtp);
router.post("/login", validateLoginRequest, login);
router.post("/forgot-password/request-otp", validateForgotPasswordRequest, requestPasswordResetOtp);
router.post("/forgot-password/verify-otp", validateVerifyOtpRequest, verifyPasswordResetOtp);
router.post("/forgot-password/reset", validateResetPasswordRequest, resetPasswordWithOtp);
router.post("/refresh-token", validateRefreshTokenRequest, refreshAccessToken);
router.post("/logout", validateRefreshTokenRequest, logout);

module.exports = router;
