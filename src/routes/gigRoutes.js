const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  createGig,
  updateGig,
  listMyGigs,
  listPendingGigRequests,
  deleteGig,
  deleteGigRequest,
  approveGigRequest,
  rejectGigRequest,
  listPublicServices,
  trackGigImpressions,
  getPublicServiceById,
  trackGigDetailView,
  getGigAnalytics,
} = require("../controllers/gigController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 4,
  },
});

router.post("/", requireAuth, upload.array("images", 4), createGig);
router.put("/:id", requireAuth, upload.array("images", 4), updateGig);
router.delete("/:id", requireAuth, deleteGig);
router.delete("/requests/:id", requireAuth, deleteGigRequest);
router.get("/mine", requireAuth, listMyGigs);
router.post("/analytics/impressions", requireAuth, trackGigImpressions);
router.get("/public", listPublicServices);
router.post("/public/:id/view", requireAuth, trackGigDetailView);
router.get("/public/:id", getPublicServiceById);
router.get("/:id/analytics", requireAuth, getGigAnalytics);
router.get("/pending", requireAuth, requireAdmin, listPendingGigRequests);
router.post("/:id/approve", requireAuth, requireAdmin, approveGigRequest);
router.post("/:id/reject", requireAuth, requireAdmin, rejectGigRequest);

module.exports = router;
