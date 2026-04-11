const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const {
  createOrder,
  getProviderDashboard,
  getClientDashboard,
  listProviderOrders,
  listClientOrders,
  getProviderOrderDetail,
  getClientOrderDetail,
  acceptProviderOrder,
  declineProviderOrder,
  submitProviderDelivery,
  requestClientRevision,
  respondProviderRevision,
  cancelClientRevisionRequest,
  sendClientResolutionMessage,
  createClientCheckoutSession,
  confirmClientCheckoutPayment,
  submitClientOrderReview,
  finalizeClientOrder,
} = require("../controllers/orderController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.post("/", requireAuth, createOrder);
router.get("/provider/dashboard", requireAuth, getProviderDashboard);
router.get("/provider", requireAuth, listProviderOrders);
router.get("/provider/:id", requireAuth, getProviderOrderDetail);
router.get("/client/dashboard", requireAuth, getClientDashboard);
router.get("/client", requireAuth, listClientOrders);
router.get("/client/:id", requireAuth, getClientOrderDetail);
router.patch("/provider/:id/accept", requireAuth, acceptProviderOrder);
router.patch("/provider/:id/decline", requireAuth, declineProviderOrder);
router.patch("/provider/:id/revision-response", requireAuth, respondProviderRevision);
router.patch("/provider/:id/deliver", requireAuth, upload.array("deliveryImages", 4), submitProviderDelivery);
router.patch("/client/:id/request-revision", requireAuth, requestClientRevision);
router.patch("/client/:id/cancel-revision", requireAuth, cancelClientRevisionRequest);
router.post("/client/:id/resolution-message", requireAuth, sendClientResolutionMessage);
router.post("/client/:id/stripe-checkout", requireAuth, createClientCheckoutSession);
router.post("/client/:id/stripe-confirm", requireAuth, confirmClientCheckoutPayment);
router.post("/client/:id/review", requireAuth, submitClientOrderReview);
router.patch("/client/:id/finalize", requireAuth, finalizeClientOrder);

module.exports = router;
