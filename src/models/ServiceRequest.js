const mongoose = require("mongoose");

const serviceRequestSchema = new mongoose.Schema(
  {
    requestNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    categorySlug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    categoryName: {
      type: String,
      required: true,
      trim: true,
    },
    serviceAddress: {
      type: String,
      required: true,
      trim: true,
    },
    serviceLocationLat: {
      type: Number,
      default: null,
    },
    serviceLocationLng: {
      type: Number,
      default: null,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    preferredDate: {
      type: Date,
      default: null,
    },
    preferredTime: {
      type: String,
      default: "",
      trim: true,
    },
    budget: {
      type: Number,
      default: 0,
    },
    imageUrls: [
      {
        type: String,
        default: "",
      },
    ],
    status: {
      type: String,
      enum: ["open", "accepted", "cancelled"],
      default: "open",
    },
    acceptedProviderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    linkedOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    linkedOrderNumber: {
      type: String,
      default: "",
      trim: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    ignoredByProviderIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  {
    timestamps: true,
  }
);

serviceRequestSchema.index({ status: 1, createdAt: -1 });
serviceRequestSchema.index({ categorySlug: 1, createdAt: -1 });

module.exports = mongoose.model("ServiceRequest", serviceRequestSchema);
