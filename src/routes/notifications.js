const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { formatUserResponse } = require("../helpers/user_response");

// GET /notifications â€” user's notifications
router.get("/", authenticateToken, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const results = await Promise.all(
      notifications.map(async (n) => {
        let user_name = "Someone";
        let user = null;
        if (n.relatedId) {
          user = await prisma.user.findUnique({
            where: { id: n.relatedId },
            include: { images: { orderBy: { sortOrder: "asc" } } },
          });
          if (user) {
            const formatted = formatUserResponse(user, req);
            user_name = formatted.full_name || formatted.name || "Someone";
          }
        }
        return {
          id: n.id,
          type: n.type,
          user_name,
          title: n.title,
          subtitle: n.body,
          related_id: n.relatedId,
          is_read: n.isRead,
          created_at: n.createdAt.toISOString(),
        };
      })
    );

    res.json({ results });
  } catch (error) {
    console.error("Notifications error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /notifications/read â€” mark all as read
router.put("/read", authenticateToken, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Notifications read error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /notifications/unread-count
router.get("/unread-count", authenticateToken, async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, isRead: false },
    });
    res.json({ count });
  } catch (error) {
    console.error("Unread count error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
