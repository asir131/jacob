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
const MAX_GIG_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const ALLOWED_GIG_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const ALLOWED_GIG_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

const createUploadError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const getFileExtension = (filename = "") => {
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
};

const isVideoFilename = (filename = "") => ALLOWED_GIG_VIDEO_EXTENSIONS.has(getFileExtension(filename));

const isAllowedGigVideoFile = (file) => {
  const mimetype = String(file.mimetype || "").toLowerCase();
  return (
    ALLOWED_GIG_VIDEO_MIME_TYPES.has(mimetype) ||
    isVideoFilename(file.originalname) ||
    mimetype.includes("mp4") ||
    mimetype.includes("quicktime") ||
    mimetype.includes("webm")
  );
};

const isAllowedGigImageFile = (file) => {
  const mimetype = String(file.mimetype || "").toLowerCase();
  return mimetype.startsWith("image/") && !isAllowedGigVideoFile(file);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_GIG_VIDEO_SIZE_BYTES,
    files: 6,
  },
  fileFilter: (_req, file, cb) => {
    const isGigMediaField = file.fieldname === "images" || file.fieldname === "videos";
    if (isGigMediaField && (isAllowedGigImageFile(file) || isAllowedGigVideoFile(file))) {
      return cb(null, true);
    }
    return cb(createUploadError("Only images and MP4, MOV, or WebM videos are supported for gig media."));
  },
});

const gigMediaUpload = upload.fields([
  { name: "images", maxCount: 4 },
  { name: "videos", maxCount: 2 },
]);

const handleGigMediaUpload = (req, res, next) => {
  gigMediaUpload(req, res, (error) => {
    if (!error) return next();

    error.statusCode = 400;
    if (error.code === "LIMIT_FILE_SIZE") {
      error.message = "Each gig media file must be 100 MB or smaller.";
    } else if (error.code === "LIMIT_FILE_COUNT") {
      error.message = "You can upload up to 4 images and 2 videos per gig.";
    } else if (error.code === "LIMIT_UNEXPECTED_FILE") {
      error.message = "You can upload up to 4 images and 2 videos per gig.";
    }
    return next(error);
  });
};

router.post("/", requireAuth, handleGigMediaUpload, createGig);
router.put("/:id", requireAuth, handleGigMediaUpload, updateGig);
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
