const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "superAdmin") {
    return res.status(403).json({
      success: false,
      message: "Super admin privileges are required.",
    });
  }

  return next();
};

module.exports = requireSuperAdmin;
