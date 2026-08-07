const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");

const BOOST_DURATION_MINUTES = 20;
const BOOST_COST_SUPERLIKES = 3;

// POST /boost â€” activate boost (costs 3 super likes, lasts 20 min, cumulative)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check super likes balance
    if (user.super_likes < BOOST_COST_SUPERLIKES) {
      return res.status(400).json({
        error: `Not enough super likes. Need ${BOOST_COST_SUPERLIKES}, have ${user.super_likes}`,
        super_likes: user.super_likes,
      });
    }

    // Cumulative: if already boosted, add 20 min to remaining time
    const now = new Date();
    let baseTime = now;
    if (user.boost_expires_at && new Date(user.boost_expires_at) > now) {
      baseTime = new Date(user.boost_expires_at);
    }

    const expiresAt = new Date(baseTime.getTime() + BOOST_DURATION_MINUTES * 60 * 1000);
    const remainingMs = expiresAt - now;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        super_likes: user.super_likes - BOOST_COST_SUPERLIKES,
        boost_expires_at: expiresAt,
      },
    });

    res.json({
      message: "Boost activated!",
      boost_expires_at: expiresAt.toISOString(),
      boost_remaining_minutes: Math.ceil(remainingMs / 60000),
      boost_remaining_seconds: Math.ceil(remainingMs / 1000),
      super_likes: updated.super_likes,
    });
  } catch (error) {
    console.error("Boost error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /boost/status â€” check current boost status
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const isActive = user.boost_expires_at && new Date(user.boost_expires_at) > new Date();
    const remainingMs = isActive ? new Date(user.boost_expires_at) - new Date() : 0;

    res.json({
      is_boosted: isActive,
      boost_expires_at: user.boost_expires_at?.toISOString() ?? null,
      boost_remaining_minutes: isActive ? Math.ceil(remainingMs / 60000) : 0,
      boost_remaining_seconds: isActive ? Math.ceil(remainingMs / 1000) : 0,
      super_likes: user.super_likes,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
