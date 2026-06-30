const nodemailer = require("nodemailer");

const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const sendOtpEmail = async ({ email, firstName, otp }) => {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Your OTP for signup verification",
    text: `Hi ${firstName || "there"}, your OTP is ${otp}. It will expire in 10 minutes.`,
  });
};

const sendPasswordResetOtpEmail = async ({ email, firstName, otp }) => {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Your OTP for password reset",
    text: `Hi ${firstName || "there"}, your password reset OTP is ${otp}. It will expire in 10 minutes.`,
  });
};

module.exports = {
  sendOtpEmail,
  sendPasswordResetOtpEmail,
};
