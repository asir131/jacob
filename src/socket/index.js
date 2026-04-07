const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

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
