const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { formatUserResponse } = require("../helpers/user_response");

// GET /liked-me â€” users who liked me (excluding already-matched users)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const matches = await prisma.match.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
      },
      select: { user1Id: true, user2Id: true },
    });
    const matchedIds = matches.map((m) =>
      m.user1Id === currentUserId ? m.user2Id : m.user1Id
    );

    const swipes = await prisma.swipe.findMany({
      where: {
        targetId: currentUserId,
        action: { in: ["like", "super_like"] },
        swiperId: { notIn: [currentUserId, ...matchedIds] },
      },
      include: { swiper: { include: { images: { orderBy: { sortOrder: "asc" } } } } },
      orderBy: { createdAt: "desc" },
    });
    const users = swipes.map((s) => ({
      ...formatUserResponse(s.swiper, req),
      interaction_type: s.action,
    }));
    res.json({ results: users, total: users.length, is_unlocked: true, can_watch_ad: false, cooldown_remaining_seconds: 0 });
  } catch (error) {
    console.error("Liked me error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /liked-me/sent â€” users I liked
router.get("/sent", authenticateToken, async (req, res) => {
  try {
    const swipes = await prisma.swipe.findMany({
      where: { swiperId: req.user.id, action: { in: ["like", "super_like"] } },
      include: { target: { include: { images: { orderBy: { sortOrder: "asc" } } } } },
      orderBy: { createdAt: "desc" },
    });
    const users = swipes.map((s) => ({
      ...formatUserResponse(s.target, req),
      interaction_type: s.action,
    }));
    res.json({ results: users, total: users.length, is_unlocked: true, can_watch_ad: false, cooldown_remaining_seconds: 0 });
  } catch (error) {
    console.error("Liked me sent error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /liked-me/views â€” users who viewed my profile
router.get("/views", authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const views = await prisma.profileView.findMany({
      where: { viewedId: currentUserId },
      include: { viewer: { include: { images: { orderBy: { sortOrder: "asc" } } } } },
      orderBy: { createdAt: "desc" },
    });

    const users = views.map((v) => formatUserResponse(v.viewer, req));
    res.json({ results: users, total: users.length, is_unlocked: true, can_watch_ad: false, cooldown_remaining_seconds: 0 });
  } catch (error) {
    console.error("Profile views error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /profile-views â€” record that I viewed someone's profile
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { viewed_user_id } = req.body;
    const viewerId = req.user.id;
    const viewedId = parseInt(viewed_user_id);

    if (!viewedId || isNaN(viewedId)) {
      return res.status(400).json({ error: "viewed_user_id is required" });
    }
    if (viewerId === viewedId) {
      return res.json({ ok: true });
    }

    await prisma.profileView.upsert({
      where: { viewerId_viewedId: { viewerId, viewedId } },
      update: { createdAt: new Date() },
      create: { viewerId, viewedId },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Record profile view error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /liked-me/seen â€” mark all current likes as seen (server-side marker)
router.post("/seen", authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { likes_seen_at: new Date() },
    });
    const { emitCounters } = require("../services/counters");
    await emitCounters(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error("Liked me seen error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /liked-me/watch-ad
router.post("/watch-ad", authenticateToken, (req, res) => {
  res.json({ success: true, unlocked: true });
});

module.exports = router;
