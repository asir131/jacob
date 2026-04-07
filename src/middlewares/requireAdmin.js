const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "superAdmin") {
    return res.status(403).json({
      success: false,
      message: "Admin privileges are required.",
    });
  }

  return next();
};

module.exports = requireAdmin;
