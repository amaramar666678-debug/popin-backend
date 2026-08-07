const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { requireProfilePhoto } = require("../middleware/require_photo");
const { isUserOnline } = require("../services/socket");
const { sendPush } = require("../services/fcm");

// POST /conversations - find or create a conversation between current user and another user
router.post("/", authenticateToken, requireProfilePhoto, async (req, res) => {
  try {
    const { target_user_id, direct_message } = req.body;
    if (!target_user_id) {
      return res.status(400).json({ error: "target_user_id is required" });
    }

    const currentUserId = req.user.id;
    const targetId = parseInt(target_user_id);
    if (isNaN(targetId)) {
      return res.status(400).json({ error: "invalid target_user_id" });
    }

    // Check if a match already exists
    const user1Id = currentUserId < targetId ? currentUserId : targetId;
    const user2Id = currentUserId < targetId ? targetId : currentUserId;

    let match = await prisma.match.findFirst({
      where: { user1Id, user2Id },
      include: { conversation: true },
    });

    // Auto-create match + conversation in a single transaction if it doesn't exist
    if (!match) {
      const isDirect = direct_message === true;
      match = await prisma.$transaction(async (tx) => {
        const newMatch = await tx.match.create({
          data: { user1Id, user2Id, matchedAt: new Date() },
        });
        const conversation = await tx.conversation.create({
          data: {
            matchId: newMatch.id,
            is_direct_message: isDirect,
            initiated_by_user_id: isDirect ? currentUserId : null,
          },
        });
        return tx.match.findUnique({
          where: { id: newMatch.id },
          include: { conversation: true },
        });
      });

      // Notify the target user about the new match
      const currentUser = await prisma.user.findUnique({
        where: { id: currentUserId },
        include: { images: { orderBy: { sortOrder: "asc" } } },
      });
      if (currentUser) {
        const { getIO, normalizeImageUrlForUser } = require("../services/socket");
        const io = getIO();
        const primaryImage =
          currentUser.images.find((img) => img.isPrimary) || currentUser.images[0];
        if (io) {
          io.to(`user:${targetId}`).emit("match:new", {
            matchedUser: {
              user: {
                id: currentUserId,
                fullName: currentUser.name || currentUser.username || "User",
                profilePictureUrl: primaryImage
                  ? normalizeImageUrlForUser(primaryImage.imageUrl, targetId)
                  : null,
              },
            },
            conversationId: match.conversation?.id || 0,
          });
        }
        sendPush(targetId, {
          title: "New Match!",
          body: `${currentUser.name || currentUser.username || "Someone"} wants to chat with you!`,
          data: { type: "match", userId: currentUserId },
        }).catch(() => {});
      }
    }

    // Ensure conversation exists (handle edge case where match exists but conversation doesn't)
    if (!match.conversation) {
      await prisma.conversation.create({
        data: { matchId: match.id },
      });
      match = await prisma.match.findUnique({
        where: { id: match.id },
        include: { conversation: true },
      });
    }

    res.json({
      conversation_id: match.conversation?.id || 0,
      match_id: match.id,
      is_direct_message: match.conversation?.is_direct_message ?? false,
    });
  } catch (error) {
    console.error("[POST /conversations]", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conversations/:id/messages - get messages for a conversation
router.get("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const currentUserId = req.user.id;

    // Verify the user is part of the match this conversation belongs to
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        match: {
          select: { user1Id: true, user2Id: true },
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: "conversation not found" });
    }

    if (
      conversation.match.user1Id !== currentUserId &&
      conversation.match.user2Id !== currentUserId
    ) {
      return res.status(403).json({ error: "access denied" });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId, isDeleted: false },
      orderBy: { sentAt: "asc" },
      take: Math.min(parseInt(req.query.limit) || 100, 200),
    });

    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        conversation_id: m.conversationId,
        sender_id: m.senderId,
        content: m.isDeleted ? '' : m.content,
        type: m.type || 'text',
        system_data: m.systemData || null,
        sender_color: m.senderColor || null,
        sent_at: m.sentAt.toISOString(),
        delivered_at: m.deliveredAt?.toISOString() ?? null,
        read_at: m.readAt?.toISOString() ?? null,
        is_read: m.readAt != null,
        is_deleted: m.isDeleted,
        edited_at: m.editedAt?.toISOString() ?? null,
        reaction: m.reaction ?? null,
        voice_url: m.voiceUrl ?? null,
        voice_duration: m.voiceDuration ?? null,
        image_url: m.imageUrl ?? null,
        is_sensitive: !!m.isSensitive,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /conversations/:id/messages - send a message
router.post("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const { content, type, system_data, voice_url, voice_duration, image_url, is_sensitive } = req.body;
    const isVoice = type === 'voice';
    const isImage = !!image_url;
    if ((!content || !content.trim()) && !isVoice && !isImage) {
      return res.status(400).json({ error: "content is required" });
    }

    // Strict link filter — block any message that looks like a URL/domain.
    const { isSafeMessage } = require("../helpers/link_filter");
    if (type !== 'system' && !isVoice && !isImage && !isSafeMessage(content)) {
      console.log(
        `[conversations] blocked link attempt from user ${req.user.id} in conversation ${conversationId}`
      );
      return res.status(403).json({ error: "message blocked: links are not allowed" });
    }

    const currentUserId = req.user.id;
    const isSystem = type === 'system';

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) {
      return res.status(404).json({ error: "conversation not found" });
    }

    if (
      conversation.match.user1Id !== currentUserId &&
      conversation.match.user2Id !== currentUserId
    ) {
      return res.status(403).json({ error: "access denied" });
    }

    const otherUserId =
      conversation.match.user1Id === currentUserId
        ? conversation.match.user2Id
        : conversation.match.user1Id;

    const isRecipientOnline = isUserOnline(otherUserId);

    // Skip credit check for system messages and non-direct (matched) conversations.
    // Only the initiator of a direct message pays, and only once (first message).
    if (!isSystem && conversation.is_direct_message && conversation.initiated_by_user_id === currentUserId) {
      const existingMessageCount = await prisma.message.count({
        where: { conversationId, senderId: currentUserId, type: { not: 'system' } },
      });

      if (existingMessageCount === 0) {
        const sender = await prisma.user.findUnique({ where: { id: currentUserId } });
        if (sender.message_credits <= 0) {
          return res.status(403).json({ error: "insufficient messages" });
        }
        await prisma.user.update({
          where: { id: currentUserId },
          data: {
            message_credits: sender.message_credits - 1,
            ...(sender.message_credits - 1 <= 0 && !sender.message_refill_at
              ? { message_refill_at: new Date(Date.now() + 24 * 60 * 60 * 1000) }
              : {}),
          },
        });
      }
    }

    const senderColor = (await prisma.user.findUnique({ where: { id: currentUserId }, select: { chat_color: true } }))?.chat_color || null;

    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId: currentUserId,
        content: isVoice || isImage ? '' : (content || '').trim(),
        type: isSystem ? 'system' : isImage ? 'image' : isVoice ? 'voice' : 'text',
        systemData: system_data || undefined,
        senderColor: senderColor,
        voiceUrl: isVoice ? voice_url || null : null,
        voiceDuration: isVoice ? parseInt(voice_duration) || null : null,
        imageUrl: isImage ? image_url : null,
        isSensitive: !!is_sensitive,
        deliveredAt: isRecipientOnline ? new Date() : null,
      },
    });

    // Emit socket event for real-time delivery
    const { getIO } = require("../services/socket");
    const io = getIO();
    const payload = {
      id: message.id,
      conversation_id: message.conversationId,
      sender_id: message.senderId,
      content: message.content,
      type: message.type || 'text',
      voice_url: message.voiceUrl || null,
      voice_duration: message.voiceDuration || null,
      image_url: message.imageUrl || null,
      is_sensitive: !!message.isSensitive,
      system_data: message.systemData || null,
      sent_at: message.sentAt.toISOString(),
      delivered_at: message.deliveredAt?.toISOString() ?? null,
      is_read: false,
      sender_color: senderColor,
    };
    io.to(`user:${otherUserId}`).emit("chat:receive", payload);
    io.to(`user:${currentUserId}`).emit("chat:receive", payload);

    // The recipient's unread-messages badge changed.
    const { emitCounters } = require("../services/counters");
    emitCounters(otherUserId);

    if (!isRecipientOnline) {
      const devices = await prisma.device.findMany({
        where: { userId: otherUserId },
      });
      const sender = await prisma.user.findUnique({ where: { id: currentUserId } });
      const senderName = sender?.name || sender?.email || "Someone";
      for (const device of devices) {
        sendPush({
          token: device.fcmToken,
          title: senderName,
          body: isVoice ? "ðŸŽ¤ Voice message" : content.trim(),
          data: {
            type: "new_message",
            conversation_id: String(conversationId),
            sender_id: String(currentUserId),
          },
        });
      }
    }

    res.status(201).json({
      id: message.id,
      conversation_id: message.conversationId,
      sender_id: message.senderId,
      content: message.content,
      type: message.type || 'text',
      voice_url: message.voiceUrl || null,
      voice_duration: message.voiceDuration || null,
      image_url: message.imageUrl || null,
      is_sensitive: !!message.isSensitive,
      sender_color: senderColor,
      sent_at: message.sentAt.toISOString(),
      delivered_at: message.deliveredAt?.toISOString() ?? null,
      read_at: null,
      is_read: false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /conversations/:id/messages/:messageId - edit a message
router.put("/:id/messages/:messageId", authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const conversationId = parseInt(req.params.id);
    if (isNaN(messageId) || isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content is required" });
    }
    // Strict link filter — a message cannot be edited to become a link.
    const { isSafeMessage } = require("../helpers/link_filter");
    if (!isSafeMessage(content)) {
      return res.status(403).json({ error: "message blocked: links are not allowed" });
    }
    const currentUserId = req.user.id;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.senderId !== currentUserId) {
      return res.status(403).json({ error: "not your message" });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content: content.trim(), editedAt: new Date() },
    });

    const { getIO } = require("../services/socket");
    const io = getIO();
    const payload = {
      id: updated.id,
      conversation_id: updated.conversationId,
      content: updated.content,
      edited_at: updated.editedAt.toISOString(),
    };
    io.to(`user:${currentUserId}`).emit("chat:edited", payload);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });
    if (conversation) {
      const otherUserId = conversation.match.user1Id === currentUserId
        ? conversation.match.user2Id : conversation.match.user1Id;
      io.to(`user:${otherUserId}`).emit("chat:edited", payload);
    }

    res.json({ ok: true, edited_at: updated.editedAt.toISOString() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /conversations/:id/messages/:messageId - delete a message (soft-delete)
router.delete("/:id/messages/:messageId", authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    if (isNaN(messageId)) {
      return res.status(400).json({ error: "invalid message id" });
    }
    const currentUserId = req.user.id;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.senderId !== currentUserId) {
      return res.status(403).json({ error: "not your message" });
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { isDeleted: true },
    });

    const { getIO } = require("../services/socket");
    const io = getIO();
    const payload = { id: messageId, conversation_id: message.conversationId };
    io.to(`user:${currentUserId}`).emit("chat:deleted", payload);

    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });
    if (conversation) {
      const otherUserId = conversation.match.user1Id === currentUserId
        ? conversation.match.user2Id : conversation.match.user1Id;
      io.to(`user:${otherUserId}`).emit("chat:deleted", payload);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /conversations/:id/read - mark messages as read
router.post("/:id/read", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const currentUserId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) {
      return res.status(404).json({ error: "conversation not found" });
    }

    if (
      conversation.match.user1Id !== currentUserId &&
      conversation.match.user2Id !== currentUserId
    ) {
      return res.status(403).json({ error: "access denied" });
    }

    const otherUserId =
      conversation.match.user1Id === currentUserId
        ? conversation.match.user2Id
        : conversation.match.user1Id;

    const now = new Date();

    const result = await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: otherUserId,
        readAt: null,
      },
      data: { readAt: now },
    });

    if (result.count > 0) {
      const { getIO } = require("../services/socket");
      const io = getIO();
      io.to(`user:${otherUserId}`).emit("message:read", {
        conversation_id: conversationId,
        read_at: now.toISOString(),
        count: result.count,
      });
    }

    // My own unread-messages badge changed.
    const { emitCounters } = require("../services/counters");
    emitCounters(currentUserId);

    res.json({
      marked_read: result.count,
      read_at: now.toISOString(),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /conversations/:id/mute - toggle mute notifications
router.put("/:id/mute", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) return res.status(400).json({ error: "invalid conversation id" });

    const currentUserId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) return res.status(404).json({ error: "conversation not found" });

    if (conversation.match.user1Id !== currentUserId && conversation.match.user2Id !== currentUserId) {
      return res.status(403).json({ error: "access denied" });
    }

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { is_muted: req.body.muted ?? !conversation.is_muted },
    });

    res.json({ muted: updated.is_muted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /conversations/:id - delete entire conversation (and messages)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) return res.status(400).json({ error: "invalid conversation id" });

    const currentUserId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) return res.status(404).json({ error: "conversation not found" });

    if (conversation.match.user1Id !== currentUserId && conversation.match.user2Id !== currentUserId) {
      return res.status(403).json({ error: "access denied" });
    }

    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.match.delete({ where: { id: conversation.matchId } });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /conversations/:id/messages - clear current user's sent messages only
router.delete("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    if (isNaN(conversationId)) return res.status(400).json({ error: "invalid conversation id" });

    const currentUserId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) return res.status(404).json({ error: "conversation not found" });

    if (conversation.match.user1Id !== currentUserId && conversation.match.user2Id !== currentUserId) {
      return res.status(403).json({ error: "access denied" });
    }

    // Only delete messages sent by the current user
    const result = await prisma.message.updateMany({
      where: { conversationId, senderId: currentUserId },
      data: { isDeleted: true },
    });

    // Notify the other user via socket
    const otherUserId = conversation.match.user1Id === currentUserId
      ? conversation.match.user2Id
      : conversation.match.user1Id;

    const io = require("../services/socket").getIO();
    if (io) {
      // Fetch the clearing user's name
      const clearingUser = await prisma.user.findUnique({
        where: { id: currentUserId },
        select: { fullName: true },
      });

      io.to(`user:${otherUserId}`).emit("messages_cleared_notice", {
        conversation_id: conversationId,
        cleared_by: currentUserId,
        cleared_by_name: clearingUser?.fullName || 'Partner',
        deleted_count: result.count,
      });
    }

    res.json({ ok: true, deleted_count: result.count });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /conversations/:id/messages/:messageId/react - add/toggle reaction
router.put("/:id/messages/:messageId/react", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    const messageId = parseInt(req.params.messageId);
    if (isNaN(conversationId) || isNaN(messageId)) {
      return res.status(400).json({ error: "invalid id" });
    }

    const { reaction } = req.body;
    if (!reaction || typeof reaction !== "string") {
      return res.status(400).json({ error: "reaction is required" });
    }

    const currentUserId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: { select: { user1Id: true, user2Id: true } } },
    });

    if (!conversation) {
      return res.status(404).json({ error: "conversation not found" });
    }

    if (
      conversation.match.user1Id !== currentUserId &&
      conversation.match.user2Id !== currentUserId
    ) {
      return res.status(403).json({ error: "access denied" });
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId, conversationId },
    });

    if (!message) {
      return res.status(404).json({ error: "message not found" });
    }

    const newReaction = message.reaction === reaction ? null : reaction;

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { reaction: newReaction },
    });

    const otherUserId = conversation.match.user1Id === currentUserId
      ? conversation.match.user2Id
      : conversation.match.user1Id;

    const io = require("../services/socket").getIO();
    if (io) {
      io.emit("chat:reaction", {
        message_id: updated.id,
        conversation_id: conversationId,
        sender_id: currentUserId,
        receiver_id: otherUserId,
        reaction: newReaction,
      });
    }

    res.json({ reaction: newReaction });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /conversations/:id/disappearing - set disappearing messages duration (hours) or null to disable
router.put("/:id/disappearing", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    const { duration } = req.body; // null, 24, 168, 2160

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { match: true },
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const currentUserId = req.user.id;
    if (conversation.match.user1Id !== currentUserId && conversation.match.user2Id !== currentUserId) {
      return res.status(403).json({ error: "Not part of this conversation" });
    }

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { disappearing_messages: duration },
    });

    const otherUserId = conversation.match.user1Id === currentUserId
      ? conversation.match.user2Id
      : conversation.match.user1Id;

    const io = require("../services/socket").getIO();
    if (io) {
      io.to(`user:${otherUserId}`).emit("chat:disappearing_updated", {
        conversation_id: conversationId,
        duration: duration,
        set_by: currentUserId,
      });
    }

    res.json({ disappearing_messages: updated.disappearing_messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conversations/:id/disappearing - get current disappearing messages setting
router.get("/:id/disappearing", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json({ disappearing_messages: conversation.disappearing_messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
