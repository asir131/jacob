const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    text: {
      type: String,
      default: "",
      trim: true,
    },
    attachments: [
      {
        url: {
          type: String,
          default: "",
          trim: true,
        },
        fileName: {
          type: String,
          default: "",
          trim: true,
        },
        mimeType: {
          type: String,
          default: "",
          trim: true,
        },
        resourceType: {
          type: String,
          default: "raw",
          trim: true,
        },
      },
    ],
    readAt: {
      type: Date,
      default: null,
    },
    hiddenFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: [],
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Message", messageSchema);
