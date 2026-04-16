const mongoose = require("mongoose");
const FAQ = require("../models/FAQ");

const normalizeFaq = (faq) => ({
  id: String(faq._id),
  question: faq.question || "",
  answer: faq.answer || "",
  isActive: Boolean(faq.isActive),
  sortOrder: Number(faq.sortOrder || 0),
  createdAt: faq.createdAt || null,
  updatedAt: faq.updatedAt || null,
});

const getPublicFaqs = async (req, res, next) => {
  try {
    const items = await FAQ.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "FAQs fetched successfully.",
      data: items.map(normalizeFaq),
    });
  } catch (error) {
    return next(error);
  }
};

const getAdminFaqs = async (req, res, next) => {
  try {
    const items = await FAQ.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Admin FAQs fetched successfully.",
      data: items.map(normalizeFaq),
    });
  } catch (error) {
    return next(error);
  }
};

const createFaq = async (req, res, next) => {
  try {
    const question = String(req.body.question || "").trim();
    const answer = String(req.body.answer || "").trim();
    const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : true;
    const sortOrder = Number.isFinite(Number(req.body.sortOrder)) ? Number(req.body.sortOrder) : 0;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        message: "Question and answer are required.",
      });
    }

    const faq = await FAQ.create({
      question,
      answer,
      isActive,
      sortOrder,
      createdBy: req.user?.id || null,
      updatedBy: req.user?.id || null,
    });

    return res.status(201).json({
      success: true,
      message: "FAQ created successfully.",
      data: normalizeFaq(faq),
    });
  } catch (error) {
    return next(error);
  }
};

const updateFaq = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid FAQ id." });
    }

    const faq = await FAQ.findById(id);
    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found." });
    }

    const question = req.body.question !== undefined ? String(req.body.question || "").trim() : faq.question;
    const answer = req.body.answer !== undefined ? String(req.body.answer || "").trim() : faq.answer;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        message: "Question and answer are required.",
      });
    }

    faq.question = question;
    faq.answer = answer;
    if (req.body.isActive !== undefined) faq.isActive = Boolean(req.body.isActive);
    if (req.body.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) {
      faq.sortOrder = Number(req.body.sortOrder);
    }
    faq.updatedBy = req.user?.id || null;

    await faq.save();

    return res.status(200).json({
      success: true,
      message: "FAQ updated successfully.",
      data: normalizeFaq(faq),
    });
  } catch (error) {
    return next(error);
  }
};

const deleteFaq = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid FAQ id." });
    }

    const faq = await FAQ.findByIdAndDelete(id);
    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found." });
    }

    return res.status(200).json({
      success: true,
      message: "FAQ deleted successfully.",
      data: { id: String(id) },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getPublicFaqs,
  getAdminFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
};
