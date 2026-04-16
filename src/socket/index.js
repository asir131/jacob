const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

let ioInstance = null;

const resolveToken = (socket) => {
  const authToken = socket.handshake.auth?.token;
  const headerToken = socket.handshake.headers?.authorization;
  const tokenSource = authToken || headerToken || "";

  if (!tokenSource) return null;
  return tokenSource.startsWith("Bearer ") ? tokenSource.slice(7) : tokenSource;
};

const initSocket = (httpServer) => {
  if (ioInstance) return ioInstance;

  ioInstance = new Server(httpServer, {
    cors: {
      origin: process.env.SOCKET_CORS_ORIGIN || process.env.CORS_ORIGIN || "http://localhost:3000",
      credentials: true,
    },
  });

  ioInstance.use((socket, next) => {
    try {
      const token = resolveToken(socket);
      if (!token) return next(new Error("Unauthorized socket connection"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      return next();
    } catch (error) {
      return next(new Error("Invalid socket token"));
    }
  });

  ioInstance.on("connection", (socket) => {
    const room = `user:${socket.data.userId}`;
    socket.join(room);
    if (socket.data.role) {
      socket.join(`role:${socket.data.role}`);
    }

    const relayCallEvent = (eventName, targetUserId, payload = {}) => {
      if (!targetUserId) return;
      ioInstance.to(`user:${targetUserId}`).emit(eventName, {
        ...payload,
        senderId: socket.data.userId,
        senderRole: socket.data.role,
      });
    };

    const persistCallHistory = async (payload = {}) => {
      try {
        const conversationId = String(payload.conversationId || "");
        const targetUserId = String(payload.targetUserId || "");
        const callType = payload.callType === "video" ? "video" : "voice";

        if (
          !mongoose.Types.ObjectId.isValid(conversationId) ||
          !mongoose.Types.ObjectId.isValid(targetUserId) ||
          !mongoose.Types.ObjectId.isValid(String(socket.data.userId || ""))
        ) {
          return;
        }

        const conversation = await Conversation.findById(conversationId).select("_id participants orderId");
        if (!conversation) return;

        const participantIds = Array.isArray(conversation.participants)
          ? conversation.participants.map((id) => String(id))
          : [];
        const callerId = String(socket.data.userId);

        if (!participantIds.includes(callerId) || !participantIds.includes(targetUserId)) {
          return;
        }

        const text = callType === "video" ? "Started a video call" : "Started a voice call";

        const message = await Message.create({
          conversationId: conversation._id,
          orderId: conversation.orderId || null,
          senderId: callerId,
          receiverId: targetUserId,
          text,
        });

        conversation.lastMessage = text;
        conversation.lastMessageAt = message.createdAt || new Date();
        await conversation.save({ validateBeforeSave: false });

        const normalized = {
          id: message._id,
          conversationId: message.conversationId,
          orderId: message.orderId || null,
          senderId: message.senderId,
          receiverId: message.receiverId,
          text: message.text || "",
          createdAt: message.createdAt,
          readAt: message.readAt || null,
        };

        ioInstance.to(`user:${callerId}`).emit("chat:message:new", normalized);
        ioInstance.to(`user:${targetUserId}`).emit("chat:message:new", normalized);
        ioInstance.to(`user:${callerId}`).emit("chat:conversation:updated", {
          conversationId,
          lastMessage: text,
          lastMessageAt: conversation.lastMessageAt,
        });
        ioInstance.to(`user:${targetUserId}`).emit("chat:conversation:updated", {
          conversationId,
          lastMessage: text,
          lastMessageAt: conversation.lastMessageAt,
        });
      } catch (error) {
        console.error("Failed to persist call history:", error);
      }
    };

    socket.on("call:invite", async (payload = {}) => {
      await persistCallHistory(payload);
      relayCallEvent("call:invite", payload.targetUserId, payload);
    });

    socket.on("call:signal", (payload = {}) => {
      relayCallEvent("call:signal", payload.targetUserId, payload);
    });

    socket.on("call:end", (payload = {}) => {
      relayCallEvent("call:end", payload.targetUserId, payload);
    });

    socket.emit("socket:connected", {
      userId: socket.data.userId,
      connectedAt: new Date().toISOString(),
    });
  });

  return ioInstance;
};

const getIO = () => {
  if (!ioInstance) {
    throw new Error("Socket.IO is not initialized yet.");
  }
  return ioInstance;
};

const emitToUser = (userId, eventName, payload) => {
  if (!ioInstance) return;
  ioInstance.to(`user:${userId}`).emit(eventName, payload);
};

const emitToRole = (role, eventName, payload) => {
  if (!ioInstance || !role) return;
  ioInstance.to(`role:${role}`).emit(eventName, payload);
};

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  emitToRole,
};
