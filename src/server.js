const dotenv = require("dotenv");
dotenv.config();

const http = require("http");
const app = require("./app");
const connectDB = require("./config/db");
const { initSocket } = require("./socket");
const ensureSuperAdmin = require("./utils/ensureSuperAdmin");
const { startOrderReminderJob } = require("./jobs/orderReminderJob");

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    await ensureSuperAdmin();

    const server = http.createServer(app);
    initSocket(server);
    startOrderReminderJob();

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
