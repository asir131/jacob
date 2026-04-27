const mongoose = require("mongoose");

const gigAnalyticsEventSchema = new mongoose.Schema(
  {
    gigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Gig",
      required: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: ["services_impression", "service_detail_view"],
      required: true,
      index: true,
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

gigAnalyticsEventSchema.index({ gigId: 1, clientId: 1, eventType: 1 }, { unique: true });

module.exports = mongoose.model("GigAnalyticsEvent", gigAnalyticsEventSchema);
