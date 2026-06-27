const ProviderAvailabilityBlock = require("../models/ProviderAvailabilityBlock");

const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || process.env.ORDER_REMINDER_TIMEZONE || "Asia/Dhaka";

const getDateKeyInTimeZone = (value, timeZone = DEFAULT_TIME_ZONE) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 10);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const normalizeDateKey = (value) => {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return getDateKeyInTimeZone(value);
};

const dateFromKey = (dateKey) => {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
};

const parseTimeToMinutes = (value) => {
  const text = String(value || "").trim();
  const meridiem = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (meridiem) {
    const rawHour = Number(meridiem[1]);
    const minute = Number(meridiem[2]);
    if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;
    const period = meridiem[3].toUpperCase();
    const hour = period === "PM" ? (rawHour % 12) + 12 : rawHour % 12;
    return hour * 60 + minute;
  }

  const clock = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const isWeeklyMatch = (block, targetDateKey) => {
  if (block.recurrence !== "weekly") return block.dateKey === targetDateKey;
  const startDate = dateFromKey(block.dateKey);
  const targetDate = dateFromKey(targetDateKey);
  if (!startDate || !targetDate || targetDate < startDate) return false;
  return startDate.getDay() === targetDate.getDay();
};

const blockMatchesSchedule = (block, scheduledDate, scheduledTime) => {
  const targetDateKey = normalizeDateKey(scheduledDate);
  if (!targetDateKey || !isWeeklyMatch(block, targetDateKey)) return false;
  if (block.scope === "full_day") return true;

  const bookingMinutes = parseTimeToMinutes(scheduledTime);
  const startMinutes = parseTimeToMinutes(block.startTime);
  const endMinutes = parseTimeToMinutes(block.endTime);
  if (bookingMinutes === null || startMinutes === null || endMinutes === null) return false;
  if (endMinutes <= startMinutes) return bookingMinutes === startMinutes;
  return bookingMinutes >= startMinutes && bookingMinutes < endMinutes;
};

const serializeAvailabilityBlock = (block) => {
  if (!block) return null;
  return {
    id: String(block._id || block.id || ""),
    providerId: String(block.providerId || ""),
    scope: block.scope || "time_slot",
    dateKey: block.dateKey || "",
    startTime: block.startTime || "",
    endTime: block.endTime || "",
    note: block.note || "",
    recurrence: block.recurrence || "none",
    status: block.status || "active",
    createdAt: block.createdAt || null,
    updatedAt: block.updatedAt || null,
  };
};

const findBlockingAvailability = async ({ providerId, scheduledDate, scheduledTime }) => {
  const dateKey = normalizeDateKey(scheduledDate);
  if (!providerId || !dateKey) return null;
  const blocks = await ProviderAvailabilityBlock.find({
    providerId,
    status: "active",
    $or: [{ dateKey }, { recurrence: "weekly", dateKey: { $lte: dateKey } }],
  }).lean();
  return blocks.find((block) => blockMatchesSchedule(block, dateKey, scheduledTime)) || null;
};

module.exports = {
  blockMatchesSchedule,
  findBlockingAvailability,
  getDateKeyInTimeZone,
  normalizeDateKey,
  parseTimeToMinutes,
  serializeAvailabilityBlock,
};
