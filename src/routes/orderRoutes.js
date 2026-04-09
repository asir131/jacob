const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const {
  createOrder,
  listProviderOrders,
  getProviderOrderDetail,
  acceptProviderOrder,
  declineProviderOrder,
  submitProviderDelivery,
  finalizeClientOrder,
} = require("../controllers/orderController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.post("/", requireAuth, createOrder);
router.get("/provider", requireAuth, listProviderOrders);
router.get("/provider/:id", requireAuth, getProviderOrderDetail);
router.patch("/provider/:id/accept", requireAuth, acceptProviderOrder);
router.patch("/provider/:id/decline", requireAuth, declineProviderOrder);
router.patch("/provider/:id/deliver", requireAuth, upload.array("deliveryImages", 4), submitProviderDelivery);
router.patch("/client/:id/finalize", requireAuth, finalizeClientOrder);

module.exports = router;
