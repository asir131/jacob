const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  getPublicFaqs,
  getAdminFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
} = require("../controllers/faqController");

const router = express.Router();

router.get("/", getPublicFaqs);
router.get("/admin", requireAuth, requireAdmin, getAdminFaqs);
router.post("/admin", requireAuth, requireAdmin, createFaq);
router.patch("/admin/:id", requireAuth, requireAdmin, updateFaq);
router.delete("/admin/:id", requireAuth, requireAdmin, deleteFaq);

module.exports = router;
