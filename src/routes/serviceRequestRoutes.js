const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createServiceRequest,
  listClientServiceRequests,
  listProviderServiceRequests,
  listAdminServiceRequests,
  approveServiceRequestCustomCategory,
  acceptServiceRequest,
  ignoreServiceRequest,
} = require("../controllers/serviceRequestController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.post("/", requireAuth, upload.array("images", 4), createServiceRequest);
router.get("/admin", requireAuth, requireAdmin, listAdminServiceRequests);
router.patch("/admin/:id/custom-category/approve", requireAuth, requireAdmin, approveServiceRequestCustomCategory);
router.get("/client", requireAuth, listClientServiceRequests);
router.get("/provider", requireAuth, listProviderServiceRequests);
router.patch("/provider/:id/accept", requireAuth, acceptServiceRequest);
router.patch("/provider/:id/ignore", requireAuth, ignoreServiceRequest);

module.exports = router;
