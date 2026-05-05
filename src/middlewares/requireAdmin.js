const requireAdmin = (req, res, next) => {
  if (!req.user || !["admin", "superAdmin"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Admin privileges are required.",
    });
  }

  return next();
};

module.exports = requireAdmin;
