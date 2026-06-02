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
      required: false,
      default: null,
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
    repeatRootOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    repeatSourceOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    repeatIteration: {
      type: Number,
      default: 1,
      min: 1,
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
    packageDeliveryTime: {
      type: String,
      default: "",
      trim: true,
    },
    packageDeliveryTimeUnit: {
      type: String,
      default: "",
      trim: true,
    },
    categoryName: {
      type: String,
      default: "",
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
    clientAddressSnapshot: {
      type: String,
      default: "",
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
    revisionRequestNote: {
      type: String,
      default: "",
      trim: true,
    },
    revisionResponseNote: {
      type: String,
      default: "",
      trim: true,
    },
    revisionRequestedAt: {
      type: Date,
      default: null,
    },
    revisionRespondedAt: {
      type: Date,
      default: null,
    },
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
    scheduledReminderSentAt: {
      type: Date,
      default: null,
    },
    providerDayBeforeReminderSentAt: {
      type: Date,
      default: null,
    },
    providerMorningReminderSentAt: {
      type: Date,
      default: null,
    },
    client24HourReminderSentAt: {
      type: Date,
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "paid", "failed"],
      default: "unpaid",
    },
    paymentProvider: {
      type: String,
      default: "stripe",
      trim: true,
    },
    stripeCheckoutSessionId: {
      type: String,
      default: "",
      trim: true,
    },
    stripePaymentIntentId: {
      type: String,
      default: "",
      trim: true,
    },
    paymentCurrency: {
      type: String,
      default: "usd",
      trim: true,
    },
    paymentAmount: {
      type: Number,
      default: 0,
    },
    platformFeeAmount: {
      type: Number,
      default: 0,
    },
    providerEarningsAmount: {
      type: Number,
      default: 0,
    },
    listedPrice: {
      type: Number,
      default: 0,
    },
    customerPaidAmount: {
      type: Number,
      default: 0,
    },
    adminFeeAmount: {
      type: Number,
      default: 0,
    },
    providerNetAmount: {
      type: Number,
      default: 0,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    clientRating: {
      type: Number,
      default: null,
    },
    clientReview: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "declined",
        "accepting_delivery",
        "revision_requested",
        "under_revision",
        "after_sell_revision_requested",
        "under_after_sell_revision",
        "done_after_sell_revision",
        "completed",
      ],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Order", orderSchema);
