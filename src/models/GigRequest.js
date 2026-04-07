const mongoose = require("mongoose");

const gigRequestSchema = new mongoose.Schema(
  {
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
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
    isCustomCategory: {
      type: Boolean,
      default: false,
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
    customCategoryIconName: {
      type: String,
      default: "",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    requirements: {
      type: String,
      default: "",
      trim: true,
    },
    packages: [
      {
        name: {
          type: String,
          default: "",
          trim: true,
        },
        title: {
          type: String,
          default: "",
          trim: true,
        },
        description: {
          type: String,
          default: "",
          trim: true,
        },
        deliveryTime: {
          type: String,
          default: "",
          trim: true,
        },
        price: {
          type: Number,
          default: 0,
        },
      },
    ],
    images: [
      {
        type: String,
        default: "",
      },
    ],
    baseCity: {
      type: String,
      default: "",
      trim: true,
    },
    locationLat: {
      type: Number,
      default: null,
    },
    locationLng: {
      type: Number,
      default: null,
    },
    travelRadiusKm: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending_approval", "published", "rejected"],
      default: "pending_approval",
    },
    categoryRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    gigRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Gig",
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("GigRequest", gigRequestSchema);
