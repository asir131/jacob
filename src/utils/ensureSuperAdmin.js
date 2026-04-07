const bcrypt = require("bcryptjs");
const User = require("../models/User");

const ensureSuperAdmin = async () => {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();

  if (!adminEmail || !adminPassword) {
    console.warn("Super admin bootstrap skipped: ADMIN_EMAIL or ADMIN_PASSWORD is missing.");
    return;
  }

  const firstName = process.env.ADMIN_FIRST_NAME?.trim() || "Admin";
  const lastName = process.env.ADMIN_LAST_NAME?.trim() || "User";
  const hashedPassword = await bcrypt.hash(adminPassword, 10);

  const existingAdmin = await User.findOne({ email: adminEmail });

  if (!existingAdmin) {
    await User.create({
      firstName,
      lastName,
      email: adminEmail,
      password: hashedPassword,
      role: "superAdmin",
      isVerified: true,
    });

    console.log("Super admin created from environment variables.");
    return;
  }

  existingAdmin.firstName = firstName;
  existingAdmin.lastName = lastName;
  existingAdmin.password = hashedPassword;
  existingAdmin.role = "superAdmin";
  existingAdmin.isVerified = true;
  await existingAdmin.save();

  console.log("Super admin synced from environment variables.");
};

module.exports = ensureSuperAdmin;
