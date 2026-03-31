const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const { uploadAvatar, updateProfile, changePassword } = require("../controllers/profileController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.post("/avatar", requireAuth, upload.single("image"), uploadAvatar);
router.put("/me", requireAuth, updateProfile);
router.post("/change-password", requireAuth, changePassword);

module.exports = router;
