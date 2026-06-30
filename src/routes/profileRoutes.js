const express = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/requireAuth");
const requireAdmin = require("../middlewares/requireAdmin");
const requireSuperAdmin = require("../middlewares/requireSuperAdmin");
const {
  getMyProfile,
  getPublicProviderProfile,
  listAdminCustomers,
  getAdminCustomerDetails,
  listAdminProviders,
  getAdminProviderDetails,
  uploadAvatar,
  updateProfile,
  changePassword,
  deleteMyAccount,
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
  saveService,
  removeSavedService,
  getMySavedServices,
  submitPayoutInfo,
  listProviderVerifications,
  getProviderVerificationDetails,
  approveProviderVerification,
  rejectProviderVerification,
} = require("../controllers/profileController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.get("/me", requireAuth, getMyProfile);
router.get("/me/saved-services", requireAuth, getMySavedServices);
router.post("/me/saved-services/:gigId", requireAuth, saveService);
router.delete("/me/saved-services/:gigId", requireAuth, removeSavedService);
router.get("/provider/:providerId/public", getPublicProviderProfile);
router.get("/admin/customers", requireAuth, requireAdmin, listAdminCustomers);
router.get("/admin/customers/:customerId", requireAuth, requireAdmin, getAdminCustomerDetails);
router.get("/admin/providers", requireAuth, requireAdmin, listAdminProviders);
router.get("/admin/providers/:providerId", requireAuth, requireAdmin, getAdminProviderDetails);
router.get("/admin/admins", requireAuth, requireSuperAdmin, listAdminAccounts);
router.post("/admin/admins", requireAuth, requireSuperAdmin, createAdminAccount);
router.patch("/admin/admins/:adminId", requireAuth, requireSuperAdmin, updateAdminAccount);
router.post("/avatar", requireAuth, upload.single("image"), uploadAvatar);
router.put("/me", requireAuth, updateProfile);
router.delete("/me", requireAuth, deleteMyAccount);
router.post("/change-password", requireAuth, changePassword);
router.post(
  "/provider/payout-info",
  requireAuth,
  upload.fields([
    { name: "nidFront", maxCount: 1 },
    { name: "nidBack", maxCount: 1 },
  ]),
  submitPayoutInfo
);
router.get("/admin/provider-verifications", requireAuth, requireAdmin, listProviderVerifications);
router.get("/admin/provider-verifications/:providerId", requireAuth, requireAdmin, getProviderVerificationDetails);
router.post("/admin/provider-verifications/:providerId/approve", requireAuth, requireAdmin, approveProviderVerification);
router.post("/admin/provider-verifications/:providerId/reject", requireAuth, requireAdmin, rejectProviderVerification);

module.exports = router;
