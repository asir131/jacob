const mongoose = require("mongoose");

const gigSchema = new mongoose.Schema(
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
    expertType: {
      type: String,
      enum: ["solo", "team"],
      default: "solo",
      trim: true,
      lowercase: true,
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
        deliveryTimeUnit: {
          type: String,
          enum: ["Hours", "Days", "Weeks", ""],
          default: "Days",
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
    videos: [
      {
        type: String,
        default: "",
      },
    ],
    media: [
      {
        type: {
          type: String,
          enum: ["image", "video"],
          required: true,
        },
        url: {
          type: String,
          required: true,
          trim: true,
        },
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
      enum: ["draft", "pending_approval", "published", "rejected"],
      default: "draft",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Gig", gigSchema);
