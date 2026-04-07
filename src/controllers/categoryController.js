const Category = require("../models/Category");
const Gig = require("../models/Gig");

const listApprovedCategories = async (req, res, next) => {
  try {
    const [categories, counts] = await Promise.all([
      Category.find({ status: "approved" }).sort({ name: 1 }).lean(),
      Gig.aggregate([
        { $match: { status: "published" } },
        { $group: { _id: "$categorySlug", count: { $sum: 1 } } },
      ]),
    ]);

    const countMap = counts.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      message: "Categories fetched successfully.",
      data: categories.map((category) => ({
        ...category,
        count: countMap[category.slug] || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listApprovedCategories,
};
