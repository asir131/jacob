const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const {
  getWebsiteReviewPrompt,
  submitWebsiteReview,
  remindWebsiteReviewLater,
  getPublicWebsiteReviews,
} = require("../controllers/websiteReviewController");

const router = express.Router();

router.get("/public", getPublicWebsiteReviews);
router.get("/prompt", requireAuth, getWebsiteReviewPrompt);
router.post("/", requireAuth, submitWebsiteReview);
router.post("/remind-later", requireAuth, remindWebsiteReviewLater);

module.exports = router;
