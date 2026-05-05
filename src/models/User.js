const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: function () {
        return !["admin", "superAdmin"].includes(this.role);
      },
      default: "",
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    authProvider: {
      type: String,
      enum: ["password", "google"],
      default: "password",
      trim: true,
    },
    googleId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["client", "provider", "admin", "superAdmin"],
      required: true,
    },
    avatar: {
      type: String,
      default: "",
    },
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    address: {
      type: String,
      default: "",
      trim: true,
    },
    preferredLanguage: {
      type: String,
      default: "English (US)",
      trim: true,
    },
    businessBio: {
      type: String,
      default: "",
      trim: true,
    },
    experienceLevel: {
      type: String,
      default: "",
      trim: true,
    },
    serviceCity: {
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
    serviceLocationLat: {
      type: Number,
      default: null,
    },
    serviceLocationLng: {
      type: Number,
      default: null,
    },
    payoutInfo: {
      accountHolderName: {
        type: String,
        default: "",
        trim: true,
      },
      bankAccountNumber: {
        type: String,
        default: "",
        trim: true,
      },
      routingNumber: {
        type: String,
        default: "",
        trim: true,
      },
      bankName: {
        type: String,
        default: "",
        trim: true,
      },
      accountType: {
        type: String,
        enum: ["checking", "savings", ""],
        default: "",
        trim: true,
      },
      nidFrontImageUrl: {
        type: String,
        default: "",
        trim: true,
      },
      nidBackImageUrl: {
        type: String,
        default: "",
        trim: true,
      },
      submittedAt: {
        type: Date,
        default: null,
      },
      reviewedAt: {
        type: Date,
        default: null,
      },
      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      rejectionReason: {
        type: String,
        default: "",
        trim: true,
      },
    },
    payoutVerificationStatus: {
      type: String,
      enum: ["unverified", "pending", "verified", "rejected"],
      default: "unverified",
    },
    walletBalance: {
      type: Number,
      default: 0,
    },
    totalEarnings: {
      type: Number,
      default: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
    },
    averageRating: {
      type: Number,
      default: 0,
    },
    reviewCount: {
      type: Number,
      default: 0,
    },
    clientWebsiteReviewSubmittedAt: {
      type: Date,
      default: null,
    },
    providerWebsiteReviewSubmittedAt: {
      type: Date,
      default: null,
    },
    clientWebsiteReviewDeferredOrderCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    providerWebsiteReviewDeferredOrderCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    sellerLevel: {
      type: String,
      enum: ["New", "Level 1", "Level 2", "Level 3", "Top Rated"],
      default: "New",
      trim: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    savedServiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Gig",
        default: [],
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
