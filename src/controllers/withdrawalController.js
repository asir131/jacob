const User = require("../models/User");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const { emitToRole, emitToUser } = require("../socket");

const buildWithdrawal = (doc) => ({
  id: doc._id,
  amount: Number(doc.amount) || 0,
  status: doc.status,
  note: doc.note || "",
  requestedAt: doc.requestedAt || doc.createdAt || null,
  reviewedAt: doc.reviewedAt || null,
  processedAt: doc.processedAt || null,
});

const getMyWithdrawals = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "provider") {
      return res.status(403).json({
        success: false,
        message: "Only providers can view withdrawals.",
      });
    }

    const user = await User.findById(req.user.id).select("_id walletBalance totalEarnings totalWithdrawn");
    const pendingTotalAgg = await WithdrawalRequest.aggregate([
      { $match: { providerId: user._id, status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const pendingWithdrawalAmount = Number(pendingTotalAgg?.[0]?.total || 0);
    const availableBalance = Math.max(Number(user?.walletBalance || 0) - pendingWithdrawalAmount, 0);
    const withdrawals = await WithdrawalRequest.find({ providerId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        balance: {
          availableBalance,
          pendingWithdrawalAmount,
          totalEarnings: Number(user?.totalEarnings || 0),
          totalWithdrawn: Number(user?.totalWithdrawn || 0),
        },
        withdrawals: withdrawals.map(buildWithdrawal),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const requestWithdrawal = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "provider") {
      return res.status(403).json({
        success: false,
        message: "Only providers can request withdrawals.",
      });
    }

    const amount = Number(req.body.amount);
    const note = String(req.body.note || "").trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid withdrawal amount.",
      });
    }

    const user = await User.findById(req.user.id).select("_id walletBalance");
    const pendingTotalAgg = await WithdrawalRequest.aggregate([
      { $match: { providerId: user._id, status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const pendingWithdrawalAmount = Number(pendingTotalAgg?.[0]?.total || 0);
    const availableBalance = Math.max(Number(user?.walletBalance || 0) - pendingWithdrawalAmount, 0);

    if (amount > availableBalance) {
      return res.status(400).json({
        success: false,
        message: "Insufficient available balance.",
      });
    }

    const request = await WithdrawalRequest.create({
      providerId: req.user.id,
      amount,
      note,
      status: "pending",
      requestedAt: new Date(),
    });

    emitToRole("superAdmin", "notification:new", {
      id: `NTF-${Date.now()}`,
      type: "warning",
      title: "Withdrawal request created",
      description: `A provider requested a withdrawal of $${amount.toFixed(2)}.`,
      data: {
        notificationType: "withdrawal_request_created",
        withdrawalId: request._id.toString(),
        targetPath: "/withdrawals",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted.",
      data: buildWithdrawal(request),
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminWithdrawals = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can view withdrawal requests.",
      });
    }

    const status = String(req.query.status || "pending").trim().toLowerCase();
    const query = {};
    if (["pending", "approved", "rejected", "paid"].includes(status)) {
      query.status = status;
    }

    const withdrawals = await WithdrawalRequest.find(query)
      .populate("providerId", "_id firstName lastName email avatar walletBalance totalEarnings totalWithdrawn payoutInfo payoutVerificationStatus")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const items = withdrawals.map((doc) => ({
      id: doc._id,
      providerId: doc.providerId?._id || doc.providerId,
      providerName: `${doc.providerId?.firstName || ""} ${doc.providerId?.lastName || ""}`.trim() || doc.providerId?.email || "Provider",
      providerEmail: doc.providerId?.email || "",
      providerAvatar: doc.providerId?.avatar || "",
      providerWalletBalance: Number(doc.providerId?.walletBalance || 0),
      providerTotalEarnings: Number(doc.providerId?.totalEarnings || 0),
      providerTotalWithdrawn: Number(doc.providerId?.totalWithdrawn || 0),
      amount: Number(doc.amount) || 0,
      status: doc.status,
      note: doc.note || "",
      requestedAt: doc.requestedAt || doc.createdAt || null,
      reviewedAt: doc.reviewedAt || null,
      processedAt: doc.processedAt || null,
      payoutInfo: doc.providerId?.payoutInfo || {},
      payoutVerificationStatus: doc.providerId?.payoutVerificationStatus || "unverified",
    }));

    return res.status(200).json({
      success: true,
      data: items,
    });
  } catch (error) {
    return next(error);
  }
};

const reviewWithdrawal = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "superAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can review withdrawals.",
      });
    }

    const withdrawal = await WithdrawalRequest.findById(req.params.id).populate("providerId", "_id firstName lastName email avatar walletBalance totalEarnings totalWithdrawn payoutInfo");
    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found.",
      });
    }

    const action = String(req.body.action || "").trim().toLowerCase();
    const note = String(req.body.note || "").trim();
    if (!["approve", "reject", "paid"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be approve, reject or paid.",
      });
    }

    if (action === "reject") {
      withdrawal.status = "rejected";
      withdrawal.reviewedAt = new Date();
      withdrawal.processedAt = null;
      if (note) withdrawal.note = note;
      await withdrawal.save();

      emitToUser(String(withdrawal.providerId._id || withdrawal.providerId), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "warning",
        title: "Withdrawal request rejected",
        description: note || "Your withdrawal request was rejected by admin.",
        data: {
          notificationType: "withdrawal_request_rejected",
          withdrawalId: withdrawal._id.toString(),
          targetPath: "/provider/withdrawals",
        },
        unread: true,
        createdAt: new Date().toISOString(),
      });
    } else if (action === "approve") {
      withdrawal.status = "approved";
      withdrawal.reviewedAt = new Date();
      if (note) withdrawal.note = note;
      await withdrawal.save();

      emitToUser(String(withdrawal.providerId._id || withdrawal.providerId), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "success",
        title: "Withdrawal request approved",
        description: "Admin approved your withdrawal request. Pending payout processing.",
        data: {
          notificationType: "withdrawal_request_approved",
          withdrawalId: withdrawal._id.toString(),
          targetPath: "/provider/withdrawals",
        },
        unread: true,
        createdAt: new Date().toISOString(),
      });
    } else if (action === "paid") {
      if (withdrawal.status === "paid") {
        return res.status(200).json({
          success: true,
          message: "Withdrawal is already marked as paid.",
          data: buildWithdrawal(withdrawal),
        });
      }

      withdrawal.status = "paid";
      withdrawal.reviewedAt = withdrawal.reviewedAt || new Date();
      withdrawal.processedAt = new Date();
      await withdrawal.save();

      const amount = Number(withdrawal.amount) || 0;
      await User.findByIdAndUpdate(withdrawal.providerId._id || withdrawal.providerId, {
        $inc: {
          walletBalance: -amount,
          totalWithdrawn: amount,
        },
      });

      emitToUser(String(withdrawal.providerId._id || withdrawal.providerId), "notification:new", {
        id: `NTF-${Date.now()}`,
        type: "success",
        title: "Withdrawal paid",
        description: `Your withdrawal of $${amount.toFixed(2)} has been marked as paid.`,
        data: {
          notificationType: "withdrawal_paid",
          withdrawalId: withdrawal._id.toString(),
          targetPath: "/provider/withdrawals",
        },
        unread: true,
        createdAt: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      message:
        action === "reject"
          ? "Withdrawal request rejected."
          : action === "approve"
            ? "Withdrawal request approved."
            : "Withdrawal marked as paid.",
      data: buildWithdrawal(withdrawal),
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getMyWithdrawals,
  requestWithdrawal,
  getAdminWithdrawals,
  reviewWithdrawal,
};
