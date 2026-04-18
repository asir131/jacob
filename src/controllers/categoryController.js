const mongoose = require("mongoose");
const Category = require("../models/Category");
const Gig = require("../models/Gig");
const slugify = require("../utils/slugify");
const { DEFAULT_CATEGORIES } = require("../utils/defaultCategories");

const normalizeCategory = (category, countMap = new Map()) => ({
  _id: String(category._id),
  name: category.name || "",
  slug: category.slug || "",
  description: category.description || "",
  iconName: category.iconName || "ShieldCheck",
  color: category.color || "bg-slate-100 text-slate-600",
  bgGradient: category.bgGradient || "from-slate-100 to-white",
  isCustom: Boolean(category.isCustom),
  status: category.status || "approved",
  count: Number(countMap.get(category.slug) || 0),
  createdAt: category.createdAt || null,
  updatedAt: category.updatedAt || null,
});

const ensureDefaultCategories = async () => {
  await Promise.all(
    DEFAULT_CATEGORIES.map((item) =>
      Category.findOneAndUpdate(
        { slug: item.slug },
        {
          $setOnInsert: {
            name: item.name,
            slug: item.slug,
            description: item.description,
            iconName: item.iconName,
            color: item.color,
            bgGradient: item.bgGradient,
            isCustom: false,
            status: "approved",
            approvedAt: new Date(),
          },
        },
        { upsert: true, new: false, setDefaultsOnInsert: true }
      )
    )
  );
};

const buildCountMap = async () => {
  const counts = await Gig.aggregate([
    { $match: { status: "published" } },
    {
      $group: {
        _id: "$categorySlug",
        count: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    counts
      .filter((item) => item?._id)
      .map((item) => [String(item._id), Number(item.count || 0)])
  );
};

const listApprovedCategories = async (req, res, next) => {
  try {
    await ensureDefaultCategories();
    const [categories, countMap] = await Promise.all([
      Category.find({ status: "approved" }).sort({ name: 1 }).lean(),
      buildCountMap(),
    ]);

    return res.status(200).json({
      success: true,
      message: "Categories fetched successfully.",
      data: categories.map((category) => normalizeCategory(category, countMap)),
    });
  } catch (error) {
    return next(error);
  }
};

const listAdminCategories = async (req, res, next) => {
  try {
    await ensureDefaultCategories();
    const [categories, countMap] = await Promise.all([
      Category.find({ status: "approved" }).sort({ createdAt: 1, name: 1 }).lean(),
      buildCountMap(),
    ]);

    return res.status(200).json({
      success: true,
      message: "Admin categories fetched successfully.",
      data: categories.map((category) => normalizeCategory(category, countMap)),
    });
  } catch (error) {
    return next(error);
  }
};

const createCategory = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const slugInput = String(req.body.slug || "").trim();
    const slug = slugify(slugInput || name);
    const description = String(req.body.description || "").trim();
    const iconName = String(req.body.iconName || "ShieldCheck").trim() || "ShieldCheck";
    const color = String(req.body.color || "bg-slate-100 text-slate-600").trim() || "bg-slate-100 text-slate-600";
    const bgGradient = String(req.body.bgGradient || "from-slate-100 to-white").trim() || "from-slate-100 to-white";

    if (!name || !slug) {
      return res.status(400).json({
        success: false,
        message: "Category name is required.",
      });
    }

    const existing = await Category.findOne({ slug }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "A category with this slug already exists.",
      });
    }

    const category = await Category.create({
      name,
      slug,
      description,
      iconName,
      color,
      bgGradient,
      isCustom: true,
      status: "approved",
      createdBy: req.user?.id || null,
      approvedBy: req.user?.id || null,
      approvedAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      message: "Category created successfully.",
      data: normalizeCategory(category.toObject(), new Map()),
    });
  } catch (error) {
    return next(error);
  }
};

const updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid category id." });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    const nextName = req.body.name !== undefined ? String(req.body.name || "").trim() : category.name;
    const slugSource = req.body.slug !== undefined ? String(req.body.slug || "").trim() : category.slug;
    const nextSlug = slugify(slugSource || nextName);

    if (!nextName || !nextSlug) {
      return res.status(400).json({ success: false, message: "Category name is required." });
    }

    const duplicate = await Category.findOne({
      slug: nextSlug,
      _id: { $ne: category._id },
    }).lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "Another category already uses this slug.",
      });
    }

    category.name = nextName;
    category.slug = nextSlug;
    if (req.body.description !== undefined) category.description = String(req.body.description || "").trim();
    if (req.body.iconName !== undefined) category.iconName = String(req.body.iconName || "ShieldCheck").trim() || "ShieldCheck";
    if (req.body.color !== undefined) category.color = String(req.body.color || "bg-slate-100 text-slate-600").trim() || "bg-slate-100 text-slate-600";
    if (req.body.bgGradient !== undefined) category.bgGradient = String(req.body.bgGradient || "from-slate-100 to-white").trim() || "from-slate-100 to-white";
    category.status = "approved";
    category.approvedBy = req.user?.id || category.approvedBy || null;
    category.approvedAt = category.approvedAt || new Date();
    await category.save();

    return res.status(200).json({
      success: true,
      message: "Category updated successfully.",
      data: normalizeCategory(category.toObject(), new Map()),
    });
  } catch (error) {
    return next(error);
  }
};

const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid category id." });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    category.status = "rejected";
    category.approvedAt = null;
    category.approvedBy = null;
    await category.save();

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully.",
      data: { id: String(id) },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listApprovedCategories,
  listAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  ensureDefaultCategories,
};
