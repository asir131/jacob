const express = require("express");
const { listApprovedCategories } = require("../controllers/categoryController");

const router = express.Router();

router.get("/", listApprovedCategories);

module.exports = router;
