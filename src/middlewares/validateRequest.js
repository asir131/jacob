const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validateSignupRequest = (req, res, next) => {
  const { firstName, lastName, email, password, role } = req.body;

  if (!firstName || !lastName || !email || !password || !role) {
    return res.status(400).json({
      success: false,
      message: "All fields are required.",
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address.",
    });
  }

  if (String(password).length < 8) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 8 characters.",
    });
  }

  if (!["client", "provider"].includes(role)) {
    return res.status(400).json({
      success: false,
      message: "Role must be either client or provider for signup.",
    });
  }

  next();
};

const validateVerifyOtpRequest = (req, res, next) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "Email and OTP are required.",
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address.",
    });
  }

  if (!/^\d{4}$/.test(String(otp))) {
    return res.status(400).json({
      success: false,
      message: "OTP must be exactly 4 digits.",
    });
  }

  next();
};

const validateLoginRequest = (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required.",
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address.",
    });
  }

  next();
};

const validateRefreshTokenRequest = (req, res, next) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      message: "Refresh token is required.",
    });
  }

  next();
};

module.exports = {
  validateSignupRequest,
  validateVerifyOtpRequest,
  validateLoginRequest,
  validateRefreshTokenRequest,
};
