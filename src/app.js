const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const gigRoutes = require("./routes/gigRoutes");
const profileRoutes = require("./routes/profileRoutes");
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
app.use("/api/profile", profileRoutes);

app.use(errorHandler);

module.exports = app;
