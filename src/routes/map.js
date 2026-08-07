const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { requireProfilePhoto } = require("../middleware/require_photo");
const { formatUserResponse } = require("../helpers/user_response");

// GET /map/visibility
router.get("/visibility", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { is_visible_on_map: true },
    });
    res.json({ visible: user?.is_visible_on_map ?? true });
  } catch (error) {
    res.json({ visible: true });
  }
});

// POST /map/visibility
router.post("/visibility", authenticateToken, requireProfilePhoto, async (req, res) => {
  try {
    const { visible } = req.body;
    const value = visible !== undefined ? visible : true;
    await prisma.user.update({
      where: { id: req.user.id },
      data: { is_visible_on_map: value },
    });
    res.json({ visible: value });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /map/nearby â€” show visible users with location
router.get("/nearby", authenticateToken, async (req, res) => {
  try {
    const { verified } = req.query;
    const currentUserId = req.user.id;

    // Get blocked user IDs so we exclude them
    const blocks = await prisma.blockedUser.findMany({
      where: { userId: currentUserId },
      select: { blockedUserId: true },
    });
    const blockedIds = blocks.map((b) => b.blockedUserId);

    // Get swiped user IDs (only likes/super_likes â€” passes should NOT hide users from map)
    const swiped = await prisma.swipe.findMany({
      where: {
        swiperId: currentUserId,
        action: { in: ['like', 'super_like'] },
      },
      select: { targetId: true },
    });
    const swipedIds = swiped.map((s) => s.targetId);

    // Get matched user IDs
    const matches = await prisma.match.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
      },
      select: { user1Id: true, user2Id: true },
    });
    const matchedIds = matches.map((m) =>
      m.user1Id === currentUserId ? m.user2Id : m.user1Id
    );

    // Exclude users who blocked the current user as well
    const blockedBy = await prisma.blockedUser.findMany({
      where: { blockedUserId: currentUserId },
      select: { userId: true },
    });
    const blockedByIds = blockedBy.map((b) => b.userId);

    const excludeIds = [...new Set([...blockedIds, ...blockedByIds, ...swipedIds, ...matchedIds])];

    const users = await prisma.user.findMany({
      where: {
        id: { not: currentUserId, notIn: excludeIds },
        is_visible_on_map: true,
        is_location_hidden: false,
        latitude: { not: null },
        longitude: { not: null },
        AND: [
          {
            // No active ban (expired bans are allowed back).
            OR: [
              { is_banned: false },
              { ban_expires_at: { not: null, lt: new Date() } },
            ],
          },
          {
            // Only verified accounts (email and/or photo) are shown to others.
            OR: [
              { is_email_verified: true },
              { is_verified: true },
            ],
          },
        ],
      },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });

    let result = users.map((u) => formatUserResponse(u, req));

    if (verified === "true") {
      result = result.filter((u) => u.is_verified === true);
    }

    // Sort boosted users first
    result.sort((a, b) => {
      const aBoosted = a.boost_expires_at && new Date(a.boost_expires_at) > new Date();
      const bBoosted = b.boost_expires_at && new Date(b.boost_expires_at) > new Date();
      if (aBoosted && !bBoosted) return -1;
      if (!aBoosted && bBoosted) return 1;
      return 0;
    });

    res.json({ users: result });
  } catch (error) {
    console.error("Map nearby error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
