const express = require("express");
const {
  sendNotificationToUser,
  sendNotificationToSelf,
} = require("../controllers/notificationController");

const router = express.Router();

router.post("/send", sendNotificationToUser);
router.post("/send-self", sendNotificationToSelf);

module.exports = router;
