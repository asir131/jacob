const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const gigRoutes = require("./routes/gigRoutes");
const profileRoutes = require("./routes/profileRoutes");
const orderRoutes = require("./routes/orderRoutes");
const serviceRequestRoutes = require("./routes/serviceRequestRoutes");
const withdrawalRoutes = require("./routes/withdrawalRoutes");
const faqRoutes = require("./routes/faqRoutes");
const supportRoutes = require("./routes/supportRoutes");
const { handleStripeWebhook } = require("./controllers/orderController");
const chatRoutes = require("./routes/chatRoutes");
const errorHandler = require("./middlewares/errorHandler");

const app = express();
const corsOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.length > 1 ? corsOrigins : corsOrigins[0],
    credentials: true,
  })
);

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/gigs", gigRoutes);
app.use("/api/service-requests", serviceRequestRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/faqs", faqRoutes);
app.use("/api/support", supportRoutes);

app.use(errorHandler);

module.exports = app;
