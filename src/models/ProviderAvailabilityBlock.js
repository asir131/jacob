const mongoose = require("mongoose");

const providerAvailabilityBlockSchema = new mongoose.Schema(
  {
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    scope: {
      type: String,
      enum: ["full_day", "time_slot"],
      default: "time_slot",
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    startTime: {
      type: String,
      default: "",
      trim: true,
    },
    endTime: {
      type: String,
      default: "",
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
      maxlength: 240,
    },
    recurrence: {
      type: String,
      enum: ["none", "weekly"],
      default: "none",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "cancelled"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

providerAvailabilityBlockSchema.index({ providerId: 1, dateKey: 1, status: 1 });
providerAvailabilityBlockSchema.index({ providerId: 1, recurrence: 1, status: 1 });

module.exports = mongoose.model("ProviderAvailabilityBlock", providerAvailabilityBlockSchema);
