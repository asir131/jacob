const mongoose = require("mongoose");
const ProviderAvailabilityBlock = require("../models/ProviderAvailabilityBlock");
const { emitToUser } = require("../socket");
const {
  normalizeDateKey,
  parseTimeToMinutes,
  serializeAvailabilityBlock,
} = require("../utils/providerAvailability");

const createNotificationId = () => `NTF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const ensureProvider = (req, res) => {
  if (!req.user || !["provider", "superAdmin"].includes(req.user.role)) {
    res.status(403).json({
      success: false,
      message: "Only providers can manage availability.",
    });
    return false;
  }
  return true;
};

const buildListQuery = ({ providerId, from, to }) => {
  const fromKey = from ? normalizeDateKey(from) : "";
  const toKey = to ? normalizeDateKey(to) : "";
  const query = { providerId, status: "active" };
  if (fromKey || toKey) {
    const range = {};
    if (fromKey) range.$gte = fromKey;
    if (toKey) range.$lte = toKey;
    query.$or = [{ dateKey: range }, { recurrence: "weekly", dateKey: { $lte: toKey || fromKey || "9999-12-31" } }];
  }
  return query;
};

const listProviderAvailabilityBlocks = async (req, res, next) => {
  try {
    if (!ensureProvider(req, res)) return;
    const blocks = await ProviderAvailabilityBlock.find(
      buildListQuery({ providerId: req.user.id, from: req.query.from, to: req.query.to })
    )
      .sort({ dateKey: 1, startTime: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: { items: blocks.map(serializeAvailabilityBlock) },
    });
  } catch (error) {
    return next(error);
  }
};

const listPublicProviderAvailabilityBlocks = async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(providerId)) {
      return res.status(400).json({ success: false, message: "Invalid provider id." });
    }

    const blocks = await ProviderAvailabilityBlock.find(
      buildListQuery({ providerId, from: req.query.from, to: req.query.to })
    )
      .select("_id providerId scope dateKey startTime endTime recurrence status")
      .sort({ dateKey: 1, startTime: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: { items: blocks.map(serializeAvailabilityBlock) },
    });
  } catch (error) {
    return next(error);
  }
};

const createProviderAvailabilityBlock = async (req, res, next) => {
  try {
    if (!ensureProvider(req, res)) return;

    const scope = String(req.body.scope || "time_slot").trim();
    const dateKey = normalizeDateKey(req.body.dateKey || req.body.date);
    const startTime = String(req.body.startTime || "").trim();
    const endTime = String(req.body.endTime || "").trim();
    const recurrence = String(req.body.recurrence || "none").trim();
    const note = String(req.body.note || "").trim().slice(0, 240);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ success: false, message: "Please select a valid date." });
    }
    if (!["full_day", "time_slot"].includes(scope)) {
      return res.status(400).json({ success: false, message: "Invalid block type." });
    }
    if (!["none", "weekly"].includes(recurrence)) {
      return res.status(400).json({ success: false, message: "Invalid recurrence option." });
    }
    if (scope === "time_slot") {
      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = parseTimeToMinutes(endTime);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return res.status(400).json({
          success: false,
          message: "Please enter a valid start and end time for the blocked slot.",
        });
      }
    }

    const block = await ProviderAvailabilityBlock.create({
      providerId: req.user.id,
      scope,
      dateKey,
      startTime: scope === "time_slot" ? startTime : "",
      endTime: scope === "time_slot" ? endTime : "",
      note,
      recurrence,
      status: "active",
    });

    emitToUser(String(req.user.id), "notification:new", {
      id: createNotificationId(),
      type: "system",
      title: "Availability updated",
      description: scope === "full_day" ? "A full day was blocked on your calendar." : "A time slot was blocked on your calendar.",
      data: {
        notificationType: "availability_block_created",
        blockId: block._id.toString(),
        targetPath: "/provider/dashboard",
      },
      unread: true,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Availability block saved.",
      data: { block: serializeAvailabilityBlock(block.toObject()) },
    });
  } catch (error) {
    return next(error);
  }
};

const deleteProviderAvailabilityBlock = async (req, res, next) => {
  try {
    if (!ensureProvider(req, res)) return;
    const block = await ProviderAvailabilityBlock.findOneAndUpdate(
      { _id: req.params.id, providerId: req.user.id, status: "active" },
      { $set: { status: "cancelled" } },
      { new: true }
    ).lean();

    if (!block) {
      return res.status(404).json({ success: false, message: "Availability block not found." });
    }

    return res.status(200).json({
      success: true,
      message: "Availability block removed.",
      data: { block: serializeAvailabilityBlock(block) },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createProviderAvailabilityBlock,
  deleteProviderAvailabilityBlock,
  listProviderAvailabilityBlocks,
  listPublicProviderAvailabilityBlocks,
};
