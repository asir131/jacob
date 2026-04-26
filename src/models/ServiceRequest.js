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
    requestSource: {
      type: String,
      enum: ["existing_category", "custom_category"],
      default: "existing_category",
      index: true,
    },
    customCategoryName: {
      type: String,
      default: "",
      trim: true,
    },
    customCategoryDescription: {
      type: String,
      default: "",
      trim: true,
    },
    customCategoryApprovalStatus: {
      type: String,
      enum: ["not_requested", "pending", "approved", "rejected"],
      default: "not_requested",
      index: true,
    },
    customCategoryRequestedAt: {
      type: Date,
      default: null,
    },
    customCategoryReviewedAt: {
      type: Date,
      default: null,
    },
    customCategoryReviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    customCategoryRejectionReason: {
      type: String,
      default: "",
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
    acceptedVia: {
      type: String,
      enum: ["direct", "admin_invitation", ""],
      default: "",
      trim: true,
    },
    negotiationConversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    adminInvitations: [
      {
        providerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        invitedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        invitedAt: {
          type: Date,
          default: Date.now,
        },
        status: {
          type: String,
          enum: ["pending", "accepted", "declined", "expired", "unavailable"],
          default: "pending",
          index: true,
        },
        respondedAt: {
          type: Date,
          default: null,
        },
      },
    ],
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
serviceRequestSchema.index({ requestSource: 1, customCategoryApprovalStatus: 1, createdAt: -1 });

module.exports = mongoose.model("ServiceRequest", serviceRequestSchema);
