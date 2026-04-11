const express = require("express");
const requireAuth = require("../middlewares/requireAuth");
const {
  getMyWithdrawals,
  requestWithdrawal,
  getAdminWithdrawals,
  reviewWithdrawal,
} = require("../controllers/withdrawalController");

const router = express.Router();

router.get("/me", requireAuth, getMyWithdrawals);
router.post("/me/request", requireAuth, requestWithdrawal);
router.get("/admin", requireAuth, getAdminWithdrawals);
router.post("/admin/:id/review", requireAuth, reviewWithdrawal);

module.exports = router;
