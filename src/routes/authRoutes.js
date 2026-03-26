const express = require("express");
const {
  signup,
  verifySignupOtp,
  login,
  refreshAccessToken,
  logout,
} = require("../controllers/authController");
const {
  validateSignupRequest,
  validateVerifyOtpRequest,
  validateLoginRequest,
  validateRefreshTokenRequest,
} = require("../middlewares/validateRequest");

const router = express.Router();

router.post("/signup", validateSignupRequest, signup);
router.post("/verify-signup-otp", validateVerifyOtpRequest, verifySignupOtp);
router.post("/login", validateLoginRequest, login);
router.post("/refresh-token", validateRefreshTokenRequest, refreshAccessToken);
router.post("/logout", validateRefreshTokenRequest, logout);

module.exports = router;
