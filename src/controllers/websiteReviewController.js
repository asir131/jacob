const Order = require("../models/Order");
const User = require("../models/User");
const WebsiteReview = require("../models/WebsiteReview");

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const resolveContext = (value, fallbackRole = "client") =>
  value === "provider" ? "provider" : fallbackRole === "provider" ? "provider" : "client";

const getContextFieldNames = (context) =>
  context === "provider"
    ? {
        submittedAt: "providerWebsiteReviewSubmittedAt",
        deferredCount: "providerWebsiteReviewDeferredOrderCount",
        orderOwnerField: "providerId",
      }
    : {
        submittedAt: "clientWebsiteReviewSubmittedAt",
        deferredCount: "clientWebsiteReviewDeferredOrderCount",
        orderOwnerField: "clientId",
      };

const countEligibleOrders = async ({ userId, context }) => {
  const fields = getContextFieldNames(context);
  return Order.countDocuments({
    [fields.orderOwnerField]: userId,
    status: "completed",
    paymentStatus: "paid",
  });
};

const buildPromptPayload = async ({ userId, context }) => {
  const user = await User.findById(userId).select(
    "clientWebsiteReviewSubmittedAt providerWebsiteReviewSubmittedAt clientWebsiteReviewDeferredOrderCount providerWebsiteReviewDeferredOrderCount role"
  );
  if (!user) return null;

  const fields = getContextFieldNames(context);
  const currentOrderCount = await countEligibleOrders({ userId, context });
  const submittedAt = user[fields.submittedAt] || null;
  const deferredOrderCount = Number(user[fields.deferredCount] || 0);
  const shouldPrompt = !submittedAt && currentOrderCount >= 1 && currentOrderCount > deferredOrderCount;

  return {
    context,
    currentOrderCount,
    submittedAt,
    deferredOrderCount,
    shouldPrompt,
  };
};

const getWebsiteReviewPrompt = async (req, res, next) => {
  try {
    const context = resolveContext(req.query.context, req.user.role);
    const payload = await buildPromptPayload({ userId: req.user.id, context });

    if (!payload) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const submitWebsiteReview = async (req, res, next) => {
  try {
    const context = resolveContext(req.body.context, req.user.role);
    const rating = Number(req.body.rating || 0);
    const reviewText = String(req.body.reviewText || "").trim();

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const fields = getContextFieldNames(context);
    if (user[fields.submittedAt]) {
      return res.status(409).json({
        success: false,
        message: "Website review already submitted.",
      });
    }

    const currentOrderCount = await countEligibleOrders({ userId: req.user.id, context });
    if (currentOrderCount < 1) {
      return res.status(400).json({
        success: false,
        message: "You are not eligible to review the website yet.",
      });
    }

    await WebsiteReview.create({
      reviewerId: user._id,
      reviewerRole: context,
      rating,
      reviewText,
      orderCountAtSubmission: currentOrderCount,
    });

    user[fields.submittedAt] = new Date();
    await user.save();

    return res.status(201).json({
      success: true,
      message: "Website review submitted successfully.",
    });
  } catch (error) {
    return next(error);
  }
};

const remindWebsiteReviewLater = async (req, res, next) => {
  try {
    const context = resolveContext(req.body.context, req.user.role);
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const fields = getContextFieldNames(context);
    const currentOrderCount = await countEligibleOrders({ userId: req.user.id, context });
    user[fields.deferredCount] = currentOrderCount;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "We will remind you again later.",
      data: {
        context,
        deferredUntilOrderCount: currentOrderCount + 1,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getPublicWebsiteReviews = async (_req, res, next) => {
  try {
    const reviews = await WebsiteReview.find({})
      .populate(
        "reviewerId",
        "_id firstName lastName avatar role sellerLevel averageRating totalEarnings"
      )
      .sort({ createdAt: -1 })
      .lean();

    const providerReviews = reviews.filter(
      (item) => item.reviewerRole === "provider" && item.reviewerId
    );
    const clientReviews = reviews.filter(
      (item) => item.reviewerRole === "client" && item.reviewerId
    );

    const providerIds = providerReviews.map((item) => item.reviewerId?._id).filter(Boolean);
    const clientIds = clientReviews.map((item) => item.reviewerId?._id).filter(Boolean);
    const since = new Date(Date.now() - THIRTY_DAYS_MS);

    const [providerIncomeRows, clientSpendingRows] = await Promise.all([
      providerIds.length
        ? Order.aggregate([
            {
              $match: {
                providerId: { $in: providerIds },
                status: "completed",
                paymentStatus: "paid",
                paidAt: { $gte: since },
              },
            },
            {
              $group: {
                _id: "$providerId",
                total: { $sum: "$providerEarningsAmount" },
              },
            },
          ])
        : [],
      clientIds.length
        ? Order.aggregate([
            {
              $match: {
                clientId: { $in: clientIds },
                status: "completed",
                paymentStatus: "paid",
                paidAt: { $gte: since },
              },
            },
            {
              $group: {
                _id: "$clientId",
                total: { $sum: "$paymentAmount" },
              },
            },
          ])
        : [],
    ]);

    const providerIncomeMap = new Map(
      providerIncomeRows.map((item) => [String(item._id), Number(item.total || 0)])
    );
    const clientSpendingMap = new Map(
      clientSpendingRows.map((item) => [String(item._id), Number(item.total || 0)])
    );

    const usedProviderIds = new Set();
    const topProviderReviews = providerReviews
      .sort((a, b) => {
        const ratingA = Number(a.reviewerId?.averageRating || 0);
        const ratingB = Number(b.reviewerId?.averageRating || 0);
        if (ratingA !== ratingB) return ratingB - ratingA;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .filter((item) => {
        const id = String(item.reviewerId?._id || "");
        if (!id || usedProviderIds.has(id)) return false;
        usedProviderIds.add(id);
        return true;
      })
      .slice(0, 3)
      .map((item) => ({
        id: String(item._id),
        reviewText: item.reviewText || "",
        websiteRating: Number(item.rating || 0),
        createdAt: item.createdAt,
        reviewer: {
          id: String(item.reviewerId?._id || ""),
          name: `${item.reviewerId?.firstName || ""} ${item.reviewerId?.lastName || ""}`.trim() || "Provider",
          avatar: item.reviewerId?.avatar || "",
          sellerLevel: item.reviewerId?.sellerLevel || "New",
          providerRating: Number(item.reviewerId?.averageRating || 0),
          monthlyIncome: providerIncomeMap.get(String(item.reviewerId?._id || "")) || 0,
        },
      }));

    const latestClientReviews = clientReviews
      .slice(0, 6)
      .map((item) => ({
        id: String(item._id),
        reviewText: item.reviewText || "",
        websiteRating: Number(item.rating || 0),
        createdAt: item.createdAt,
        reviewer: {
          id: String(item.reviewerId?._id || ""),
          name: `${item.reviewerId?.firstName || ""} ${item.reviewerId?.lastName || ""}`.trim() || "Client",
          avatar: item.reviewerId?.avatar || "",
          monthlySpending: clientSpendingMap.get(String(item.reviewerId?._id || "")) || 0,
        },
      }));

    return res.status(200).json({
      success: true,
      data: {
        providerReviews: topProviderReviews,
        clientReviews: latestClientReviews,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getWebsiteReviewPrompt,
  submitWebsiteReview,
  remindWebsiteReviewLater,
  getPublicWebsiteReviews,
};
