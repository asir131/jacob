const SupportMessage = require("../models/SupportMessage");
const { emitToRole } = require("../socket");

const normalizeSupportMessage = (item) => ({
  id: String(item._id),
  fullName: item.fullName || "",
  email: item.email || "",
  subject: item.subject || "",
  message: item.message || "",
  status: item.status || "pending",
  createdAt: item.createdAt || null,
  updatedAt: item.updatedAt || null,
  resolvedAt: item.resolvedAt || null,
});

const createSupportMessage = async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();

    if (!fullName || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Full name, email, subject, and message are required.",
      });
    }

    const supportMessage = await SupportMessage.create({
      fullName,
      email,
      subject,
      message,
      userId: req.user?.id || null,
    });

    emitToRole("superAdmin", "notification:new", {
      id: `SUP-${Date.now()}`,
      type: "system",
      title: "New support message",
      description: `${fullName} sent a support request: ${subject}`,
      data: {
        notificationType: "support_message",
        providerName: fullName,
        categoryName: "Support",
        targetPath: "/support",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Support message sent successfully.",
      data: normalizeSupportMessage(supportMessage),
    });
  } catch (error) {
    return next(error);
  }
};

const listSupportMessages = async (req, res, next) => {
  try {
    const items = await SupportMessage.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      message: "Support messages fetched successfully.",
      data: items.map(normalizeSupportMessage),
    });
  } catch (error) {
    return next(error);
  }
};

const updateSupportMessageStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const nextStatus = String(req.body.status || "").trim().toLowerCase();

    if (!["solved", "ignored"].includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: "Valid status is required.",
      });
    }

    const item = await SupportMessage.findById(id);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Support message not found.",
      });
    }

    item.status = nextStatus;
    item.resolvedBy = req.user?.id || null;
    item.resolvedAt = new Date();
    await item.save();

    return res.status(200).json({
      success: true,
      message: "Support message updated successfully.",
      data: normalizeSupportMessage(item),
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createSupportMessage,
  listSupportMessages,
  updateSupportMessageStatus,
};
