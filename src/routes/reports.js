const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");

// GET /reports/check/:targetId â€” check whether the current user has already reported a user
router.get("/check/:targetId", authenticateToken, async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    if (isNaN(targetId)) {
      return res.status(400).json({ error: "invalid target id" });
    }

    const existing = await prisma.report.findFirst({
      where: { reporterId: req.user.id, reportedUserId: targetId },
    });

    res.json({ reported: !!existing });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /reports - report a user
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { reported_user_id, reason } = req.body;
    if (!reported_user_id) return res.status(400).json({ error: "reported_user_id is required" });

    const currentUserId = req.user.id;
    const targetId = parseInt(reported_user_id);
    if (isNaN(targetId) || targetId === currentUserId) {
      return res.status(400).json({ error: "invalid user id" });
    }

    const report = await prisma.report.create({
      data: { reporterId: currentUserId, reportedUserId: targetId, reason: reason || null },
    });

    // Ban policy: 2 reports from 2 distinct users within 24h â†’ 24h ban.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const distinctReporters = await prisma.report.groupBy({
      by: ["reporterId"],
      where: { reportedUserId: targetId, createdAt: { gte: cutoff } },
    });

    let banned = false;
    if (distinctReporters.length >= 2) {
      const banExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await prisma.user.update({
        where: { id: targetId },
        data: { is_banned: true, ban_reason: reason || "reports", ban_expires_at: banExpiresAt },
      });
      banned = true;
    }

    res.status(201).json({ id: report.id, banned });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
