const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { formatUserResponse } = require("../helpers/user_response");

// POST /verify/photo — mark user as verified (device-side liveness passed)
router.post("/photo", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { is_verified: true },
    });
    res.json({
      status: "verified",
      message: "Identity verified successfully",
      user: formatUserResponse(user, req, { includePrivateLocation: true }),
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
