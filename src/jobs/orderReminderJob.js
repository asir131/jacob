const Order = require("../models/Order");
const { emitToUser } = require("../socket");

const REMINDER_TIMEZONE = process.env.ORDER_REMINDER_TIMEZONE || process.env.APP_TIMEZONE || "Asia/Dhaka";
const ACTIVE_ORDER_STATUSES = [
  "pending",
  "accepted",
  "accepting_delivery",
  "revision_requested",
  "under_revision",
  "after_sell_revision_requested",
  "under_after_sell_revision",
];

let reminderTimer = null;
let reminderRunning = false;

const getDateKeyInTimeZone = (value, timeZone = REMINDER_TIMEZONE) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const getPart = (type) => parts.find((part) => part.type === type)?.value || "";
  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  return year && month && day ? `${year}-${month}-${day}` : "";
};

const parseScheduledTime = (scheduledTime = "") => {
  const value = String(scheduledTime || "").trim().toUpperCase();
  if (!value) return null;

  const amPmMatch = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (amPmMatch) {
    let hours = Number(amPmMatch[1]);
    const minutes = Number(amPmMatch[2]);
    const period = amPmMatch[3];
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
    if (hours < 1 || hours > 12) return null;
    if (period === "AM") {
      if (hours === 12) hours = 0;
    } else if (hours !== 12) {
      hours += 12;
    }
    return { hours, minutes };
  }

  const twentyFourHourMatch = value.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    const hours = Number(twentyFourHourMatch[1]);
    const minutes = Number(twentyFourHourMatch[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }
    return { hours, minutes };
  }

  return null;
};

const buildScheduledDateTime = (scheduledDate, scheduledTime) => {
  const dateKey = getDateKeyInTimeZone(scheduledDate);
  const parsedTime = parseScheduledTime(scheduledTime);
  if (!dateKey || !parsedTime) return null;

  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  if (![year, month, day].every(Number.isFinite)) return null;

  return new Date(year, month - 1, day, parsedTime.hours, parsedTime.minutes, 0, 0);
};

const buildReminderNotification = ({ order, recipientRole }) => {
  const orderId = String(order._id || "");
  const orderNumber = String(order.orderNumber || "");
  const orderTitle =
    String(order.packageTitle || "").trim() ||
    String(order.categoryName || "").trim() ||
    String(order.gigId?.title || "").trim() ||
    "your order";
  const targetPath =
    recipientRole === "provider"
      ? `/provider/orders/${orderId}`
      : `/client/orders/${orderNumber || orderId}`;

  return {
    id: `NTF-${Date.now()}-${recipientRole}-${orderId}`,
    type: "system",
    title: "Order reminder",
    description:
      recipientRole === "provider"
        ? `Reminder: ${orderTitle} is scheduled in 24 hours.`
        : `Reminder: your scheduled service for ${orderTitle} starts in 24 hours.`,
    unread: true,
    createdAt: new Date().toISOString(),
    data: {
      notificationType: "order_24h_reminder",
      orderId,
      orderNumber,
      targetPath,
    },
  };
};

const runOrderReminderJob = async () => {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date();
    const windowStart = now.getTime();
    const windowEnd = windowStart + 15 * 60 * 1000;

    const candidateOrders = await Order.find({
      status: { $in: ACTIVE_ORDER_STATUSES },
      scheduledReminderSentAt: null,
      scheduledDate: {
        $gte: new Date(Date.now() + 23 * 60 * 60 * 1000),
        $lte: new Date(Date.now() + 25 * 60 * 60 * 1000),
      },
    })
      .populate("gigId", "_id title")
      .select("_id orderNumber packageTitle categoryName scheduledDate scheduledTime clientId providerId gigId")
      .lean();

    const dueOrders = candidateOrders.filter((order) => {
      const scheduledAt = buildScheduledDateTime(order.scheduledDate, order.scheduledTime);
      if (!scheduledAt) return false;
      const reminderAt = scheduledAt.getTime() - 24 * 60 * 60 * 1000;
      return reminderAt >= windowStart && reminderAt < windowEnd;
    });

    if (!dueOrders.length) return;

    const processedIds = [];

    for (const order of dueOrders) {
      const clientId = String(order.clientId || "");
      const providerId = String(order.providerId || "");
      if (!clientId || !providerId) continue;

      emitToUser(clientId, "notification:new", buildReminderNotification({ order, recipientRole: "client" }));
      emitToUser(providerId, "notification:new", buildReminderNotification({ order, recipientRole: "provider" }));
      processedIds.push(order._id);
    }

    if (processedIds.length) {
      await Order.updateMany(
        { _id: { $in: processedIds } },
        { $set: { scheduledReminderSentAt: new Date() } }
      );
    }
  } catch (error) {
    console.error("Order reminder job failed:", error.message);
  } finally {
    reminderRunning = false;
  }
};

const startOrderReminderJob = () => {
  if (reminderTimer) return;

  setTimeout(() => {
    void runOrderReminderJob();
  }, 15000);

  reminderTimer = setInterval(() => {
    void runOrderReminderJob();
  }, 15 * 60 * 1000);
};

module.exports = {
  runOrderReminderJob,
  startOrderReminderJob,
};
