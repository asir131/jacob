const Order = require("../models/Order");
const { emitToUser } = require("../socket");

const REMINDER_TIMEZONE = process.env.ORDER_REMINDER_TIMEZONE || process.env.APP_TIMEZONE || "Asia/Dhaka";
const PROVIDER_MORNING_REMINDER_HOUR = Math.min(
  11,
  Math.max(5, Number(process.env.PROVIDER_MORNING_REMINDER_HOUR) || 8)
);
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

const buildDateTimeAtHour = (scheduledDate, hour) => {
  const dateKey = getDateKeyInTimeZone(scheduledDate);
  if (!dateKey) return null;

  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  if (![year, month, day].every(Number.isFinite)) return null;

  return new Date(year, month - 1, day, hour, 0, 0, 0);
};

const buildProviderMorningReminderTime = (scheduledDate, scheduledTime) => {
  const scheduledAt = buildScheduledDateTime(scheduledDate, scheduledTime);
  if (!scheduledAt) return null;

  const defaultMorningReminder = buildDateTimeAtHour(scheduledDate, PROVIDER_MORNING_REMINDER_HOUR);
  if (!defaultMorningReminder) return null;

  if (defaultMorningReminder.getTime() < scheduledAt.getTime()) {
    return defaultMorningReminder;
  }

  return new Date(scheduledAt.getTime() - 2 * 60 * 60 * 1000);
};

const isReminderDue = (reminderAt, windowStart, windowEnd, scheduledAt) => {
  if (!(reminderAt instanceof Date) || Number.isNaN(reminderAt.getTime())) return false;
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) return false;
  if (reminderAt.getTime() >= scheduledAt.getTime()) return false;
  return reminderAt.getTime() >= windowStart && reminderAt.getTime() < windowEnd;
};

const buildReminderNotification = ({ order, recipientRole, reminderType }) => {
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
  const notificationMap = {
    client_24h: {
      title: "Service in 24 hours",
      description: `Reminder: your scheduled service for ${orderTitle} starts in about 24 hours.`,
      notificationType: "order_client_24h_reminder",
    },
    provider_day_before: {
      title: "Service reminder for tomorrow",
      description: `Reminder: ${orderTitle} is scheduled for tomorrow. Please review the order details.`,
      notificationType: "order_provider_day_before_reminder",
    },
    provider_morning_of: {
      title: "Today's service reminder",
      description: `Reminder: ${orderTitle} is scheduled for today. Check in with the customer before heading out.`,
      notificationType: "order_provider_morning_of_reminder",
    },
  };
  const selectedNotification = notificationMap[reminderType] || notificationMap.client_24h;

  return {
    id: `NTF-${Date.now()}-${reminderType}-${orderId}`,
    type: "system",
    title: selectedNotification.title,
    description: selectedNotification.description,
    unread: true,
    createdAt: new Date().toISOString(),
    data: {
      notificationType: selectedNotification.notificationType,
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
      scheduledDate: {
        $gte: new Date(Date.now() - 12 * 60 * 60 * 1000),
        $lte: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
      $or: [
        { client24HourReminderSentAt: null },
        { providerDayBeforeReminderSentAt: null },
        { providerMorningReminderSentAt: null },
      ],
    })
      .populate("gigId", "_id title")
      .select(
        "_id orderNumber packageTitle categoryName scheduledDate scheduledTime clientId providerId gigId client24HourReminderSentAt providerDayBeforeReminderSentAt providerMorningReminderSentAt"
      )
      .lean();

    if (!candidateOrders.length) return;

    const updateOperations = [];

    for (const order of candidateOrders) {
      const scheduledAt = buildScheduledDateTime(order.scheduledDate, order.scheduledTime);
      if (!scheduledAt || scheduledAt.getTime() <= windowStart) continue;

      const clientId = String(order.clientId || "");
      const providerId = String(order.providerId || "");
      const updates = {};

      if (!order.client24HourReminderSentAt) {
        const clientReminderAt = new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000);
        if (clientId && isReminderDue(clientReminderAt, windowStart, windowEnd, scheduledAt)) {
          emitToUser(
            clientId,
            "notification:new",
            buildReminderNotification({ order, recipientRole: "client", reminderType: "client_24h" })
          );
          updates.client24HourReminderSentAt = now;
        }
      }

      if (!order.providerDayBeforeReminderSentAt) {
        const providerDayBeforeReminderAt = new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000);
        if (providerId && isReminderDue(providerDayBeforeReminderAt, windowStart, windowEnd, scheduledAt)) {
          emitToUser(
            providerId,
            "notification:new",
            buildReminderNotification({
              order,
              recipientRole: "provider",
              reminderType: "provider_day_before",
            })
          );
          updates.providerDayBeforeReminderSentAt = now;
        }
      }

      if (!order.providerMorningReminderSentAt) {
        const providerMorningReminderAt = buildProviderMorningReminderTime(order.scheduledDate, order.scheduledTime);
        if (providerId && isReminderDue(providerMorningReminderAt, windowStart, windowEnd, scheduledAt)) {
          emitToUser(
            providerId,
            "notification:new",
            buildReminderNotification({
              order,
              recipientRole: "provider",
              reminderType: "provider_morning_of",
            })
          );
          updates.providerMorningReminderSentAt = now;
        }
      }

      if (Object.keys(updates).length > 0) {
        if (
          updates.client24HourReminderSentAt &&
          updates.providerDayBeforeReminderSentAt &&
          !order.scheduledReminderSentAt
        ) {
          updates.scheduledReminderSentAt = now;
        }

        updateOperations.push({
          updateOne: {
            filter: { _id: order._id },
            update: { $set: updates },
          },
        });
      }
    }

    if (updateOperations.length) {
      await Order.bulkWrite(updateOperations);
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
