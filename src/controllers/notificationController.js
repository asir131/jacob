const { emitToUser } = require("../socket");
const jwt = require("jsonwebtoken");

const parseBearerToken = (authorizationHeader = "") => {
  if (!authorizationHeader) return null;
  if (!authorizationHeader.startsWith("Bearer ")) return null;
  return authorizationHeader.slice(7);
};

const sendNotificationToUser = async (req, res, next) => {
  try {
    const { userId, title, description, type, data } = req.body;

    if (!userId || !title || !description) {
      return res.status(400).json({
        success: false,
        message: "userId, title and description are required.",
      });
    }

    const notification = {
      id: `NTF-${Date.now()}`,
      type: type || "system",
      title,
      description,
      data: data || null,
      unread: true,
      createdAt: new Date().toISOString(),
    };

    emitToUser(userId, "notification:new", notification);

    return res.status(200).json({
      success: true,
      message: "Notification dispatched.",
      data: notification,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  sendNotificationToUser,
  sendNotificationToSelf: async (req, res, next) => {
    try {
      const token = parseBearerToken(req.headers.authorization);
      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Authorization token is required.",
        });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { title, description, type, data } = req.body;

      if (!title || !description) {
        return res.status(400).json({
          success: false,
          message: "title and description are required.",
        });
      }

      const notification = {
        id: `NTF-${Date.now()}`,
        type: type || "system",
        title,
        description,
        data: data || null,
        unread: true,
        createdAt: new Date().toISOString(),
      };

      emitToUser(decoded.userId, "notification:new", notification);

      return res.status(200).json({
        success: true,
        message: "Notification sent to current user.",
        data: notification,
      });
    } catch (error) {
      if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired token.",
        });
      }
      return next(error);
    }
  },
};
