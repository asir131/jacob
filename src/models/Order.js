const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    gigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Gig",
      required: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    packageName: {
      type: String,
      required: true,
      trim: true,
    },
    packageTitle: {
      type: String,
      required: true,
      trim: true,
    },
    packagePrice: {
      type: Number,
      required: true,
      default: 0,
    },
    scheduledDate: {
      type: Date,
      required: true,
    },
    scheduledTime: {
      type: String,
      required: true,
      trim: true,
    },
    serviceAddress: {
      type: String,
      required: true,
      trim: true,
    },
    specialInstructions: {
      type: String,
      default: "",
      trim: true,
    },
    deliveryNote: {
      type: String,
      default: "",
      trim: true,
    },
    deliveryImages: [
      {
        type: String,
        default: "",
      },
    ],
    orderStartedAt: {
      type: Date,
      default: null,
    },
    requirementSubmittedAt: {
      type: Date,
      default: null,
    },
    deliveryPendingAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "accepting_delivery", "completed"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Order", orderSchema);
