const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const {
  listApprovedCategories,
  listAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../controllers/categoryController");

const router = express.Router();

router.get("/", listApprovedCategories);
router.get("/admin", requireAuth, requireAdmin, listAdminCategories);
router.post("/admin", requireAuth, requireAdmin, createCategory);
router.put("/admin/:id", requireAuth, requireAdmin, updateCategory);
router.delete("/admin/:id", requireAuth, requireAdmin, deleteCategory);

module.exports = router;
