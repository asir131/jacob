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
      required: true,
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
    role: {
      type: String,
      enum: ["client", "provider", "superAdmin"],
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
    isVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
