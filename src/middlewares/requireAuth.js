const jwt = require("jsonwebtoken");
const User = require("../models/User");

const parseBearerToken = (authorizationHeader = "") => {
  if (!authorizationHeader) return null;
  if (!authorizationHeader.startsWith("Bearer ")) return null;
  return authorizationHeader.slice(7);
};

const requireAuth = (req, res, next) => {
  try {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    User.findById(decoded.userId)
      .select("_id role email firstName lastName")
      .then((user) => {
        if (!user) {
          return res.status(401).json({
            success: false,
            message: "User not found.",
          });
        }

        req.user = {
          id: user._id,
          role: user.role,
          email: user.email,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
        };

        return next();
      })
      .catch(() => {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired token.",
        });
      });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
};

module.exports = requireAuth;
