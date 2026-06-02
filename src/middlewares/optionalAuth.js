const jwt = require("jsonwebtoken");
const User = require("../models/User");

const parseBearerToken = (authorizationHeader = "") => {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) return null;
  return authorizationHeader.slice(7);
};

const optionalAuth = async (req, _res, next) => {
  try {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("_id role email firstName lastName avatar");
    if (user) {
      req.user = {
        id: user._id,
        role: user.role,
        email: user.email,
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        avatar: user.avatar || "",
      };
    }
  } catch {
    // Public support submissions should still work if an optional token is absent or stale.
  }

  return next();
};

module.exports = optionalAuth;
