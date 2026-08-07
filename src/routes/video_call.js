const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { getCallDeclineInfo } = require("../services/call_decline_limit");

// GET /video-call/status/:conversationId - get active request for a conversation
router.get("/status/:conversationId", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.conversationId);
    if (isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const request = await prisma.videoCallRequest.findFirst({
      where: {
        conversationId,
        // "ended" is included so a pair with a previously COMPLETED call can
        // re-call directly without sending a new approval request.
        status: { in: ["pending", "approved", "ended"] },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!request) {
      return res.json({ request: null });
    }

    res.json({
      request: {
        id: request.id,
        conversation_id: request.conversationId,
        sender_id: request.senderId,
        receiver_id: request.receiverId,
        status: request.status,
        created_at: request.createdAt.toISOString(),
        updated_at: request.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /video-call/decline-status/:conversationId - per-pair decline history
// for the current user against their partner in the conversation.
router.get("/decline-status/:conversationId", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.conversationId);
    if (isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: true },
    });
    if (!conversation || !conversation.match) {
      return res.json({
        declined_count: 0,
        last_declined_at: null,
        blocked: false,
        remaining_seconds: 0,
      });
    }

    const match = conversation.match;
    const partnerId =
      match.user1Id === userId ? match.user2Id : match.user1Id;

    const info = await getCallDeclineInfo(prisma, userId, partnerId);
    res.json(info);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
