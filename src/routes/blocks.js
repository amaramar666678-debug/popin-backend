const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");

// POST /blocks - block a user
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { blocked_user_id } = req.body;
    if (!blocked_user_id) return res.status(400).json({ error: "blocked_user_id is required" });

    const currentUserId = req.user.id;
    const targetId = parseInt(blocked_user_id);
    if (isNaN(targetId) || targetId === currentUserId) {
      return res.status(400).json({ error: "invalid user id" });
    }

    const existing = await prisma.blockedUser.findUnique({
      where: { userId_blockedUserId: { userId: currentUserId, blockedUserId: targetId } },
    });

    if (existing) return res.status(409).json({ error: "already blocked" });

    const block = await prisma.blockedUser.create({
      data: { userId: currentUserId, blockedUserId: targetId },
    });

    res.status(201).json({ id: block.id, blocked_user_id: block.blockedUserId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /blocks/:id - unblock a user
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const blockId = parseInt(req.params.id);
    if (isNaN(blockId)) return res.status(400).json({ error: "invalid block id" });

    const currentUserId = req.user.id;

    const block = await prisma.blockedUser.findUnique({ where: { id: blockId } });
    if (!block || block.userId !== currentUserId) {
      return res.status(403).json({ error: "not your block" });
    }

    await prisma.blockedUser.delete({ where: { id: blockId } });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /blocks - list blocked users with their info
router.get("/", authenticateToken, async (req, res) => {
  try {
    const blocks = await prisma.blockedUser.findMany({
      where: { userId: req.user.id },
      include: {
        blockedUser: {
          include: { images: { orderBy: { sortOrder: "asc" } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const { formatUserResponse } = require("../helpers/user_response");

    const items = blocks.map((b) => ({
      id: b.id,
      blocked_user: formatUserResponse(b.blockedUser, req),
      blocked_at: b.createdAt.toISOString(),
    }));

    res.json({ blocks: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
