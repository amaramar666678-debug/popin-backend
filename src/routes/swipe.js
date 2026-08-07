const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { requireProfilePhoto } = require("../middleware/require_photo");
const { formatUserResponse } = require("../helpers/user_response");
const { sendPushToUser } = require("../services/fcm");
const { getIO } = require("../services/socket");

const REWIND_REFILL_HOURS = 16;

// POST /swipe/undo â€” undo last swipe, costs 1 rewind credit
router.post("/undo", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if ((user.rewind_credits ?? 0) <= 0) {
      return res.status(429).json({ error: "No rewind credits left", rewind_credits: 0 });
    }

    const lastSwipe = await prisma.swipe.findFirst({
      where: { swiperId: userId },
      orderBy: { id: "desc" },
    });
    if (!lastSwipe) {
      return res.status(404).json({ error: "No swipe to undo" });
    }

    await prisma.swipe.delete({ where: { id: lastSwipe.id } });

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        rewind_credits: user.rewind_credits - 1,
        ...(user.rewind_credits - 1 <= 0 && !user.rewind_refill_at
          ? { rewind_refill_at: new Date(Date.now() + REWIND_REFILL_HOURS * 60 * 60 * 1000) }
          : {}),
      },
    });

    res.json({
      rewind_credits: updatedUser.rewind_credits,
      undone_swipe: { target_id: lastSwipe.targetId, action: lastSwipe.action },
    });

    // Undoing a like removes it from the target's liked-me list/badge.
    if (lastSwipe.action === "like" || lastSwipe.action === "super_like") {
      const { emitCounters } = require("../services/counters");
      emitCounters(lastSwipe.targetId);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /swipe
router.post("/", authenticateToken, requireProfilePhoto, async (req, res) => {
  try {
    const { target_user_id, action } = req.body;
    if (!target_user_id || !action) {
      return res.status(400).json({ error: "target_user_id and action are required" });
    }

    const swiperId = req.user.id;
    const targetId = parseInt(target_user_id);
    if (isNaN(targetId)) {
      return res.status(400).json({ error: "invalid target_user_id" });
    }

    // Upsert swipe manually
    const existingSwipe = await prisma.swipe.findFirst({
      where: { swiperId, targetId },
    });
    if (existingSwipe) {
      await prisma.swipe.update({
        where: { id: existingSwipe.id },
        data: {
          action,
          // Reset the timer so a super_like starts its 24h star window now
          ...(action === "super_like" ? { createdAt: new Date() } : {}),
        },
      });
    } else {
      await prisma.swipe.create({
        data: { swiperId, targetId, action },
      });
    }

    // Deduct heart for likes
    if (action === "like") {
      const swiper = await prisma.user.findUnique({ where: { id: swiperId } });
      if (swiper.hearts <= 0) {
        return res.status(403).json({ error: "insufficient hearts" });
      }
      await prisma.user.update({
        where: { id: swiperId },
        data: {
          hearts: swiper.hearts - 1,
          ...(swiper.hearts - 1 <= 0 && !swiper.heart_refill_at
            ? { heart_refill_at: new Date(Date.now() + 16 * 60 * 60 * 1000) }
            : {}),
        },
      });
    }

    let isMatch = false;
    let matchId = null;
    let matchedAt = null;
    let matchedUser = null;
    let conversationId = null;

    if (action === "like" || action === "super_like") {
      const reciprocalSwipe = await prisma.swipe.findFirst({
        where: { swiperId: targetId, targetId: swiperId },
      });

      if (reciprocalSwipe && (reciprocalSwipe.action === "like" || reciprocalSwipe.action === "super_like")) {
        isMatch = true;

        const user1Id = swiperId < targetId ? swiperId : targetId;
        const user2Id = swiperId < targetId ? targetId : swiperId;

        // Upsert match manually
        let match = await prisma.match.findFirst({
          where: { user1Id, user2Id },
        });
        if (!match) {
          match = await prisma.match.create({
            data: { user1Id, user2Id },
          });
        }
        matchId = String(match.id);
        matchedAt = match.matchedAt.toISOString();

        // Upsert conversation manually
        const existingConv = await prisma.conversation.findFirst({
          where: { matchId: match.id },
        });
        if (!existingConv) {
          const conv = await prisma.conversation.create({
            data: { matchId: match.id },
          });
          conversationId = conv.id;
        } else {
          conversationId = existingConv.id;
          // A real mutual match upgrades any earlier direct-message
          // conversation into a regular matched conversation, so the
          // direct-message restrictions (first-message/call paywalls)
          // stop applying to it.
          if (existingConv.is_direct_message) {
            await prisma.conversation.update({
              where: { id: existingConv.id },
              data: { is_direct_message: false, initiated_by_user_id: null },
            });
          }
        }

        const targetUser = await prisma.user.findUnique({
          where: { id: targetId },
          include: { images: { orderBy: { sortOrder: "asc" } } },
        });
        if (targetUser) {
          matchedUser = formatUserResponse(targetUser, req);
        }

        // Also fetch swiper data so the target gets swiper's info
        const swiperUser = await prisma.user.findUnique({
          where: { id: swiperId },
          include: { images: { orderBy: { sortOrder: "asc" } } },
        });
        const swiperName = swiperUser?.name || swiperUser?.email || "Someone";
        const swiperFormatted = swiperUser ? formatUserResponse(swiperUser, req) : null;

        // A super like drops a "sent you a star" system message into the chat
        if (action === "super_like" && conversationId) {
          await prisma.message.create({
            data: {
              conversationId,
              senderId: swiperId,
              content: `${swiperName} sent you a star`,
              type: "system",
              systemData: { type: "super_like" },
            },
          });
        }

        // Send push notification to matched user
        sendPushToUser({
          userId: targetId,
          title: "ðŸ’– New Match!",
          body: `You matched with ${swiperName}!`,
          data: {
            type: "match",
            match_id: String(match.id),
            conversation_id: String(conversationId),
            user_id: String(swiperId),
            user_name: swiperName,
          },
          prisma,
        });

        // Create notification in DB + emit socket event
        const notification = await prisma.notification.create({
          data: {
            userId: targetId,
            type: "match",
            title: "New Match!",
            body: `You matched with ${swiperName}!`,
            relatedId: swiperId,
          },
        });
        const io = getIO();
        if (io) {
          io.to(`user:${targetId}`).emit("match_created", {
            user: matchedUser,
            match_id: String(match.id),
            conversation_id: conversationId,
            matched_at: matchedAt,
            ...(action === "super_like"
              ? {
                  sender_id: swiperId,
                  is_super_like: true,
                  sent_at: new Date().toISOString(),
                }
              : {}),
            notification: {
              id: notification.id,
              type: notification.type,
              title: notification.title,
              body: notification.body,
              created_at: notification.createdAt.toISOString(),
            },
          });
          // Emit to the SWIPER user (they see the target's data)
          if (swiperFormatted) {
            io.to(`user:${swiperId}`).emit("match_created", {
              user: matchedUser,
              match_id: String(match.id),
              conversation_id: conversationId,
              matched_at: matchedAt,
              ...(action === "super_like"
                ? {
                    sender_id: swiperId,
                    is_super_like: true,
                    sent_at: new Date().toISOString(),
                  }
                : {}),
              notification: {
                id: notification.id,
                type: notification.type,
                title: notification.title,
                body: notification.body,
                created_at: notification.createdAt.toISOString(),
              },
            });
          }
        }
      } else if (action === "super_like" && !isMatch) {
        const user1Id = swiperId < targetId ? swiperId : targetId;
        const user2Id = swiperId < targetId ? targetId : swiperId;

        let match = await prisma.match.findFirst({
          where: { user1Id, user2Id },
        });
        if (!match) {
          match = await prisma.match.create({
            data: { user1Id, user2Id },
          });
        }
        matchId = String(match.id);
        matchedAt = match.matchedAt.toISOString();

        const existingConv = await prisma.conversation.findFirst({
          where: { matchId: match.id },
        });
        if (!existingConv) {
          const conv = await prisma.conversation.create({
            data: { matchId: match.id },
          });
          conversationId = conv.id;
        } else {
          conversationId = existingConv.id;
        }

        const targetUser = await prisma.user.findUnique({
          where: { id: targetId },
          include: { images: { orderBy: { sortOrder: "asc" } } },
        });
        if (targetUser) {
          matchedUser = formatUserResponse(targetUser, req);
        }

        const swiper = await prisma.user.findUnique({ where: { id: swiperId } });
        const swiperName = swiper?.name || swiper?.email || "Someone";

        // Drop a "sent you a star" system message into the chat
        if (conversationId) {
          await prisma.message.create({
            data: {
              conversationId,
              senderId: swiperId,
              content: `${swiperName} sent you a star`,
              type: "system",
              systemData: { type: "super_like" },
            },
          });
        }

        sendPushToUser({
          userId: targetId,
          title: "â­ Super Like!",
          body: `${swiperName} sent you a Super Like!`,
          data: {
            type: "super_like",
            match_id: String(match.id),
            conversation_id: String(conversationId),
            user_id: String(swiperId),
            user_name: swiperName,
          },
          prisma,
        });

        // Create notification in DB + emit socket event
        const notification = await prisma.notification.create({
          data: {
            userId: targetId,
            type: "super_like",
            title: "Super Like!",
            body: `${swiperName} sent you a Super Like!`,
            relatedId: swiperId,
          },
        });
        const io = getIO();
        if (io) {
          io.to(`user:${targetId}`).emit("match_created", {
            user: matchedUser,
            match_id: String(match.id),
            conversation_id: conversationId,
            matched_at: matchedAt,
            sender_id: swiperId,
            is_super_like: true,
            sent_at: new Date().toISOString(),
            notification: {
              id: notification.id,
              type: notification.type,
              title: notification.title,
              body: notification.body,
              created_at: notification.createdAt.toISOString(),
            },
          });
          // Emit to the SWIPER as well so their chat list refreshes
          io.to(`user:${swiperId}`).emit("match_created", {
            user: matchedUser,
            match_id: String(match.id),
            conversation_id: conversationId,
            matched_at: matchedAt,
            sender_id: swiperId,
            is_super_like: true,
            sent_at: new Date().toISOString(),
            notification: {
              id: notification.id,
              type: notification.type,
              title: notification.title,
              body: notification.body,
              created_at: notification.createdAt.toISOString(),
            },
          });
        }
      }
    }

    res.json({
      is_match: isMatch,
      match_id: matchId,
      conversation_id: conversationId,
      matched_at: matchedAt,
      matched_user_id: isMatch ? targetId : null,
      matched_user: matchedUser,
    });

    // Push fresh unread badges in real time: the target's likes list changed
    // on a like, and a new match removes that like from the swiper's list.
    const { emitCounters } = require("../services/counters");
    if (action === "like" || action === "super_like") {
      emitCounters(targetId);
    }
    if (matchId != null) {
      emitCounters(swiperId);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
