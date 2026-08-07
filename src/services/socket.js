const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { prisma } = require("../middleware/prisma");
const { sendPush, sendPushToUser } = require("./fcm");
const { getCallDeclineInfo, declineBlockMessage } = require("./call_decline_limit");
const presenceSettings = require("./presence_settings");

const onlineUsers = new Map();
let ioInstance = null;

// A call may only ring for this long; if the callee does not answer in time
// the request is marked ended and both sides are notified of a missed call.
const RING_TIMEOUT_MS = 60 * 1000;
const callRingTimers = new Map();

// Rebuild a server-hosted image URL using the host the connecting client used,
// so avatars uploaded from an emulator (10.0.2.2) or LAN IP resolve correctly
// for the device receiving them.
function normalizeSocketImageUrl(imageUrl, socket) {
  if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
  try {
    const url = new URL(imageUrl);
    if (!url.pathname.startsWith("/uploads/")) return imageUrl;
    const host = socket?.handshake?.headers?.host || url.host;
    const secure = socket?.handshake?.secure;
    return `${secure ? "https" : "http"}://${host}${url.pathname}`;
  } catch (e) {
    return imageUrl;
  }
}

// Stamp the persisted "video_call_request" system message(s) belonging to a
// request with a terminal status so the request card does NOT reappear as an
// active Accept/Decline card after a reload (the status was previously only
// applied in-memory on the client).
async function stampCallRequestMessage(prisma, conversationId, requestId, status) {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId, type: "system" },
    });
    const matches = messages.filter(
      (m) =>
        m.systemData &&
        m.systemData.type === "video_call_request" &&
        Number(m.systemData.request_id) === Number(requestId)
    );
    let content = null;
    if (status === "ended") content = "Call ended";
    else if (status === "expired") content = "Call request expired";
    else if (status === "declined") content = "Call request declined";
    for (const m of matches) {
      const sd = m.systemData || {};
      await prisma.message.update({
        where: { id: m.id },
        data: {
          content: content || m.content,
          systemData: {
            type: "video_call_request",
            sender_id: sd.sender_id,
            request_id: sd.request_id,
            status,
          },
        },
      });
    }
  } catch (err) {
    console.error("[socket] stampCallRequestMessage error:", err.message);
  }
}

function setupSocket(server) {
  const allowedOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins.length ? allowedOrigins : false,
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1e6, // 1 MB per socket message
  });
  ioInstance = io;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error("Invalid token"));
      }
      if (decoded.type !== "access") {
        return next(new Error("Invalid token"));
      }
      socket.userId = decoded.id;
      next();
    });
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;
    const roomName = `user:${userId}`;
    socket.join(roomName);
    onlineUsers.set(userId, {
      socketId: socket.id,
      host: socket.handshake?.headers?.host || "",
      secure: !!socket.handshake?.secure,
    });

    // Stealth mode: a hidden user is omitted from the online list every client
    // receives, and their connection is never announced to others.
    const isHidden = presenceSettings.isHidden(userId);
    socket.emit("users:online", visibleOnlineUserIds());
    if (!isHidden) {
      socket.broadcast.emit("user:connected", { user_id: userId });
    }
    console.log(`[socket] User ${userId} connected${isHidden ? " (hidden)" : ""}`);

    // Record presence for the orange/green status dot (last_seen_at).
    // Skipped while the user hides their online status so no "recently active"
    // trace is left behind for other users to see.
    const touchLastSeen = () => {
      if (presenceSettings.isHidden(userId)) return;
      prisma.user
        .update({ where: { id: userId }, data: { last_seen_at: new Date() } })
        .catch((err) =>
          console.error("[socket] update last_seen_at error:", err.message),
        );
    };
    touchLastSeen();
    const heartbeat = setInterval(touchLastSeen, 60000);

    socket.on("presence:set", (data, ack) => {
      try {
        const hidden = !!data?.hidden;
        presenceSettings.setHidden(userId, hidden);
        // Push the updated visible list to every connected client so the user
        // instantly appears/disappears for everyone else.
        broadcastOnlineUsers();
        if (ack) ack({ ok: true, hidden });
      } catch (err) {
        console.error("[socket] presence:set error:", err.message);
        if (ack) ack({ error: err.message });
      }
    });

    socket.on("chat:send", async (data, ack) => {
      try {
        const { conversation_id, content, message_id, sender_color, type, voice_url, voice_duration, image_url, is_sensitive } = data;
        const isImage = !!image_url;
        const msgType = isImage ? "image" : type === "voice" ? "voice" : "text";
        const isVoice = msgType === "voice";
        if (!conversation_id || (!content || !content.trim()) && !isVoice && !isImage) {
          if (ack) ack({ error: "conversation_id and content are required" });
          return;
        }

        // Strict link filter — block any message that looks like a URL/domain.
        const { isSafeMessage } = require("../helpers/link_filter");
        if (!isVoice && !isImage && !isSafeMessage(content)) {
          console.log(
            `[socket] blocked link attempt from user ${userId} in conversation ${conversation_id}`
          );
          if (ack) ack({ error: "message blocked: links are not allowed" });
          return;
        }

        const conversation = await prisma.conversation.findUnique({
          where: { id: parseInt(conversation_id) },
          include: { match: { select: { user1Id: true, user2Id: true } } },
        });

        if (!conversation) {
          if (ack) ack({ error: "conversation not found" });
          return;
        }

        const otherUserId =
          conversation.match.user1Id === userId
            ? conversation.match.user2Id
            : conversation.match.user1Id;

        const isRecipientOnline = onlineUsers.has(otherUserId);

        const existingMessageCount = await prisma.message.count({
          where: {
            conversationId: parseInt(conversation_id),
            senderId: userId,
            isDeleted: false,
            type: { not: 'system' },
          },
        });

        if (existingMessageCount === 0) {
          const sender = await prisma.user.findUnique({ where: { id: userId } });
          if (sender.message_credits <= 0) {
            if (ack) ack({ error: "insufficient messages" });
            return;
          }
          await prisma.user.update({
            where: { id: userId },
            data: {
              message_credits: sender.message_credits - 1,
              ...(sender.message_credits - 1 <= 0 && !sender.message_refill_at
                ? { message_refill_at: new Date(Date.now() + 24 * 60 * 60 * 1000) }
                : {}),
            },
          });
        }

        const senderColor = sender_color || (await prisma.user.findUnique({ where: { id: userId }, select: { chat_color: true } }))?.chat_color || null;

        const message = await prisma.message.create({
          data: {
            conversationId: parseInt(conversation_id),
            senderId: userId,
            content: isVoice || isImage ? "" : (content || "").trim(),
            type: msgType,
            senderColor: senderColor,
            voiceUrl: isVoice ? voice_url || null : null,
            voiceDuration: isVoice ? parseInt(voice_duration) || null : null,
            imageUrl: isImage ? image_url : null,
            isSensitive: !!is_sensitive,
            deliveredAt: isRecipientOnline ? new Date() : null,
          },
        });

        const payload = {
          id: message.id,
          message_id: message_id || null,
          conversation_id: message.conversationId,
          sender_id: message.senderId,
          content: message.content,
          type: message.type,
          voice_url: message.voiceUrl || null,
          voice_duration: message.voiceDuration || null,
          image_url: message.imageUrl || null,
          is_sensitive: !!message.isSensitive,
          sent_at: message.sentAt.toISOString(),
          delivered_at: message.deliveredAt?.toISOString() ?? null,
          is_read: false,
          sender_color: senderColor,
        };

        io.to(`user:${otherUserId}`).emit("chat:receive", payload);
        io.to(`user:${userId}`).emit("chat:receive", payload);
        // The recipient's unread-messages badge changed.
        require("./counters").emitCounters(otherUserId);
        if (isRecipientOnline) {
          io.to(`user:${userId}`).emit("message:delivered", {
            message_id: message.id,
            conversation_id: message.conversationId,
            delivered_at: message.deliveredAt.toISOString(),
          });
        } else {
          const devices = await prisma.device.findMany({
            where: { userId: otherUserId },
          });
          const sender = await prisma.user.findUnique({ where: { id: userId } });
          const senderName = sender?.name || sender?.email || "Someone";
          for (const device of devices) {
            sendPush({
              token: device.fcmToken,
              title: senderName,
              body: isImage ? "📷 Photo" : isVoice ? "🎤 Voice message" : content.trim(),
              data: {
                type: "new_message",
                conversation_id: String(conversation_id),
                sender_id: String(userId),
              },
            });
          }
        }

        if (ack) ack({ ok: true, message: payload });
      } catch (err) {
        console.error("[socket] chat:send error:", err.message);
        if (ack) ack({ error: err.message });
      }
    });

    socket.on("typing:start", (data) => {
      const { recipient_id } = data;
      if (!recipient_id) return;
      io.to(`user:${recipient_id}`).emit("typing:start", {
        conversation_id: data.conversation_id,
        user_id: userId,
        type: "start",
      });
    });

    socket.on("typing:stop", (data) => {
      const { recipient_id } = data;
      if (!recipient_id) return;
      io.to(`user:${recipient_id}`).emit("typing:stop", {
        conversation_id: data.conversation_id,
        user_id: userId,
        type: "stop",
      });
    });

    socket.on("video_call:request", async (data) => {
      try {
        const { recipient_id, conversation_id } = data;
        if (!recipient_id || !conversation_id) {
          socket.emit("video_call:error", { error: "recipient_id and conversation_id required" });
          return;
        }
        console.log(`[socket] Video call request from ${userId} to ${recipient_id}`);
        console.log(`[socket]   recipient_id type: ${typeof recipient_id}, value: ${recipient_id}`);
        console.log(`[socket]   online users: ${Array.from(onlineUsers.keys())}`);
        console.log(`[socket]   recipient online? ${onlineUsers.has(parseInt(recipient_id))}`);

        // Direct-message paywall: a call request in a DM conversation is only
        // allowed after the initiator has sent their first message (text or
        // photo). This prevents bypassing the 1-credit direct-message rule.
        const conversation = await prisma.conversation.findUnique({
          where: { id: parseInt(conversation_id) },
          include: { match: { select: { user1Id: true, user2Id: true } } },
        });
        if (!conversation) {
          socket.emit("video_call:error", { error: "conversation not found" });
          return;
        }
        if (conversation.is_direct_message) {
          const sentCount = await prisma.message.count({
            where: {
              conversationId: conversation.id,
              senderId: userId,
              isDeleted: false,
              type: { not: 'system' },
            },
          });
          if (sentCount === 0) {
            socket.emit("video_call:error", {
              error: "You must send a message or a photo first before requesting a call.",
              code: "dm_requires_first_message",
            });
            return;
          }
        }

        // Per-user rate limit: after DECLINE_LIMIT (3) declined requests to
        // this user, block further requests to that user only (others are
        // unaffected).
        const declineInfo = await getCallDeclineInfo(prisma, userId, parseInt(recipient_id));
        if (declineInfo.blocked) {
          socket.emit("video_call:error", {
            error: declineBlockMessage(declineInfo),
            code: "decline_limit",
            declined_count: declineInfo.declined_count,
            remaining_seconds: declineInfo.remaining_seconds,
          });
          return;
        }

        // Deactivate old pending requests for this conversation
        const oldRequests = await prisma.videoCallRequest.findMany({
          where: { conversationId: parseInt(conversation_id), status: "pending" },
        });
        if (oldRequests.length > 0) {
          await prisma.videoCallRequest.updateMany({
            where: { id: { in: oldRequests.map((r) => r.id) } },
            data: { status: "expired" },
          });
          for (const r of oldRequests) {
            // Persist the expiry on the request card so it never shows
            // Accept/Decline again after a reload.
            await stampCallRequestMessage(prisma, r.conversationId, r.id, "expired");
            io.to(`user:${r.senderId}`).emit("video_call:request_expired", {
              id: r.id,
              conversation_id: r.conversationId,
            });
            io.to(`user:${r.receiverId}`).emit("video_call:request_expired", {
              id: r.id,
              conversation_id: r.conversationId,
            });
          }
        }

        const request = await prisma.videoCallRequest.create({
          data: {
            conversationId: parseInt(conversation_id),
            senderId: userId,
            receiverId: parseInt(recipient_id),
            status: "pending",
          },
        });

        // Resolve the caller's real name + avatar from the DB so the callee
        // never sees a fallback like "Someone" or a missing picture.
        let callerName = data.caller_name || "Someone";
        let callerAvatar = "";
        try {
          const caller = await prisma.user.findUnique({
            where: { id: userId },
            include: { images: { orderBy: { sortOrder: "asc" } } },
          });
          if (caller) {
            callerName = caller.name || caller.username || caller.email || callerName;
            const imgs = caller.images || [];
            const primary = imgs.find((img) => img.isPrimary);
            callerAvatar = primary ? primary.imageUrl : imgs.length > 0 ? imgs[0].imageUrl : "";
            callerAvatar = normalizeSocketImageUrl(callerAvatar, socket);
          }
        } catch (err) {
          console.error("[socket] video_call:request caller fetch error:", err.message);
        }

        // Persist a system message so the request shows up in the Messages list
        // and counts toward the unread badge. The chat room shows the request
        // card live via the dedicated video_call:* socket events.
        let message = null;
        try {
          message = await prisma.message.create({
            data: {
              conversationId: request.conversationId,
              senderId: userId,
              content: `${callerName} wants a video call. Do you want to approve?`,
              type: "system",
              systemData: {
                type: "video_call_request",
                sender_id: String(userId),
                request_id: request.id,
              },
            },
          });
        } catch (err) {
          console.error("[socket] video_call:request message create error:", err.message);
        }

        // Notify both sides so the conversation list refreshes in real time
        if (message) {
          const msgPayload = {
            id: message.id,
            conversation_id: message.conversationId,
            sender_id: message.senderId,
            content: message.content,
            type: message.type,
            system_data: message.systemData,
            sent_at: message.sentAt.toISOString(),
          };
          io.to(`user:${recipient_id}`).emit("chat:receive", msgPayload);
          io.to(`user:${userId}`).emit("chat:receive", msgPayload);
          // The recipient's unread-messages badge changed.
          require("./counters").emitCounters(recipient_id);
        }
        io.to(`user:${recipient_id}`).emit("video_call:request_received", {
          id: request.id,
          conversation_id: request.conversationId,
          caller_id: request.senderId,
          caller_name: callerName,
          caller_avatar: callerAvatar,
          status: "pending",
        });
        io.to(`user:${userId}`).emit("video_call:request_sent", {
          id: request.id,
          conversation_id: request.conversationId,
          status: "pending",
        });

        // Send push if recipient is offline
        if (!onlineUsers.has(parseInt(recipient_id))) {
          sendPushToUser({
            userId: parseInt(recipient_id),
            title: "📞 Video Call",
            body: `${callerName} is calling you!`,
            data: {
              type: "video_call",
              request_id: String(request.id),
              conversation_id: String(request.conversationId),
              caller_id: String(userId),
              caller_name: callerName,
            },
            prisma,
          });
        }
      } catch (err) {
        console.error("[socket] video_call:request error:", err.message);
        socket.emit("video_call:error", { error: err.message });
      }
    });

    socket.on("video_call:respond", async (data) => {
      try {
        const { request_id, accepted } = data;
        if (!request_id) return;
        console.log(`[socket] Video call response for request ${request_id}: ${accepted ? "approved" : "declined"}`);

        const request = await prisma.videoCallRequest.findUnique({ where: { id: parseInt(request_id) } });
        if (!request || request.status !== "pending") return;

        const newStatus = accepted ? "approved" : "declined";
        const expiresAt = accepted ? new Date(Date.now() + 5 * 60 * 1000) : null;
        await prisma.videoCallRequest.update({
          where: { id: parseInt(request_id) },
          data: { status: newStatus, expiresAt },
        });

        // A declined request must not show Accept/Decline again after reload.
        if (!accepted) {
          await stampCallRequestMessage(prisma, request.conversationId, request.id, "declined");
        }

        const event = accepted ? "video_call:request_approved" : "video_call:request_declined";
        const payload = {
          id: request.id,
          conversation_id: request.conversationId,
          status: newStatus,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
        };
        if (!accepted) {
          const declineInfo = await getCallDeclineInfo(prisma, request.senderId, request.receiverId);
          payload.declined_count = declineInfo.declined_count;
          payload.blocked = declineInfo.blocked;
          payload.remaining_seconds = declineInfo.remaining_seconds;
          payload.last_declined_at = declineInfo.last_declined_at;
        }
        io.to(`user:${request.senderId}`).emit(event, payload);
        io.to(`user:${request.receiverId}`).emit(event, payload);
      } catch (err) {
        console.error("[socket] video_call:respond error:", err.message);
      }
    });

    socket.on("video_call:start", async (data) => {
      try {
        const { request_id, conversation_id } = data;
        console.log(`[socket] Video call start from ${userId} (type ${typeof userId})`);

        // Find the active approved request. An "ended" request is also valid:
        // it means the pair already approved a previous call ("Ready"), so a
        // re-call must NOT require a new approval — it just refreshes it.
        const isUsableRequest = (r) => r && (r.status === "approved" || r.status === "ended");
        let request = null;
        if (request_id) {
          request = await prisma.videoCallRequest.findUnique({
            where: { id: parseInt(request_id) },
          });
          console.log(`[socket]   found by request_id ${request_id}: ${request ? request.status : "none"}`);
        }
        if (!isUsableRequest(request)) {
          if (conversation_id) {
            request = await prisma.videoCallRequest.findFirst({
              where: {
                conversationId: parseInt(conversation_id),
                status: { in: ["approved", "ended"] },
                OR: [{ senderId: userId }, { receiverId: userId }],
              },
              orderBy: { updatedAt: "desc" },
            });
            console.log(`[socket]   fallback by conversation ${conversation_id}: ${request ? request.status : "none"}`);
          }
        }

        if (!isUsableRequest(request)) {
          console.log(`[socket]   ❌ No approved request found for user ${userId}`);
          socket.emit("video_call:error", { error: "No approved request found" });
          return;
        }

        // Check expiry — a matched pair (approved "Ready" state) can call
        // again at any time, so refresh the approval instead of erroring out.
        // A previously "ended" request is re-approved for this new call.
        if (request.status === "ended" ||
            (request.expiresAt && new Date(request.expiresAt) < new Date())) {
          await prisma.videoCallRequest.update({
            where: { id: request.id },
            data: {
              status: "approved",
              expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            },
          });
          console.log(`[socket]   ✓ Request ${request.id} refreshed approval for re-call`);
        }

        const myId = parseInt(userId);
        const recipientId = request.senderId === myId ? request.receiverId : request.senderId;
        console.log(`[socket]   senderId=${request.senderId} receiverId=${request.receiverId} userId=${userId} → recipientId=${recipientId}`);

        // Include the caller's real name + avatar so the callee can render it
        // in the global incoming-call banner even when outside the chat room.
        let callerName = data.caller_name || "Someone";
        let callerAvatar = "";
        try {
          const caller = await prisma.user.findUnique({
            where: { id: myId },
            include: { images: { orderBy: { sortOrder: "asc" } } },
          });
          if (caller) {
            callerName = caller.name || caller.username || caller.email || callerName;
          }
          const imgs = (caller && caller.images) || [];
          const primary = imgs.find((img) => img.isPrimary);
          callerAvatar = primary ? primary.imageUrl : imgs.length > 0 ? imgs[0].imageUrl : "";
        } catch (err) {
          console.error("[socket] video_call:start avatar fetch error:", err.message);
        }

        io.to(`user:${recipientId}`).emit("video_call:incoming", {
          id: request.id,
          conversation_id: request.conversationId,
          caller_id: userId,
          caller_name: callerName,
          caller_avatar: callerAvatar,
        });
        io.to(`user:${userId}`).emit("video_call:calling", {
          id: request.id,
          conversation_id: request.conversationId,
          recipient_id: recipientId,
        });

        // Start the 1-minute ring timer. If neither side answers in time the
        // request is marked ended and both sides receive a "missed call" event.
        if (callRingTimers.has(request.id)) {
          clearTimeout(callRingTimers.get(request.id));
        }
        callRingTimers.set(
          request.id,
          setTimeout(async () => {
            callRingTimers.delete(request.id);
            try {
              const req = await prisma.videoCallRequest.findUnique({
                where: { id: request.id },
              });
              // Already answered or ended → nothing to do.
              if (!req || req.status !== "approved") return;
              await prisma.videoCallRequest.update({
                where: { id: request.id },
                // "missed" (not "ended") — so an "ended" request is
                // unambiguously a completed call that can be re-called
                // without a new approval.
                data: { status: "missed" },
              });
              const timeoutPayload = {
                id: request.id,
                conversation_id: request.conversationId,
                duration: 0,
                missed: true,
              };
              io.to(`user:${req.senderId}`).emit("video_call:ended", timeoutPayload);
              io.to(`user:${req.receiverId}`).emit("video_call:ended", timeoutPayload);
              console.log(`[socket] Ring timeout for request ${request.id} — marked as missed`);
            } catch (err) {
              console.error("[socket] ring timeout error:", err.message);
            }
          }, RING_TIMEOUT_MS),
        );

        // Send push if recipient went offline between approval and start
        if (!onlineUsers.has(recipientId)) {
          sendPushToUser({
            userId: recipientId,
            title: "📞 Video Call",
            body: `${callerName} is calling you!`,
            data: {
              type: "video_call",
              request_id: String(request.id),
              conversation_id: String(request.conversationId),
              caller_id: String(userId),
              caller_name: callerName,
            },
            prisma,
          });
        }
      } catch (err) {
        console.error("[socket] video_call:start error:", err.message);
      }
    });

    socket.on("video_call:answer", async (data) => {
      try {
        const { request_id, accepted } = data;
        if (!request_id) return;
        console.log(`[socket] Video call answer for request ${request_id}: ${accepted ? "answered" : "rejected"}`);

        const request = await prisma.videoCallRequest.findUnique({ where: { id: parseInt(request_id) } });
        if (!request) return;

        // The ring is over (answered or rejected) — stop the 1-minute timer.
        if (callRingTimers.has(request.id)) {
          clearTimeout(callRingTimers.get(request.id));
          callRingTimers.delete(request.id);
        }

        const callerId = request.senderId;
        const otherId = request.receiverId;

        if (accepted) {
          io.to(`user:${callerId}`).emit("video_call:accepted", {
            id: request.id,
            conversation_id: request.conversationId,
            accepted: true,
          });
          io.to(`user:${otherId}`).emit("video_call:accepted", {
            id: request.id,
            conversation_id: request.conversationId,
            accepted: true,
          });
        } else {
          // Persist the decline so the per-pair rate limit counts it.
          await prisma.videoCallRequest.update({
            where: { id: request.id },
            data: { status: "declined" },
          });
          const declineInfo = await getCallDeclineInfo(prisma, callerId, otherId);
          io.to(`user:${callerId}`).emit("video_call:declined", {
            id: request.id,
            conversation_id: request.conversationId,
            accepted: false,
            declined_count: declineInfo.declined_count,
            blocked: declineInfo.blocked,
            remaining_seconds: declineInfo.remaining_seconds,
            last_declined_at: declineInfo.last_declined_at,
          });
          io.to(`user:${otherId}`).emit("video_call:rejected_self", {
            id: request.id,
            conversation_id: request.conversationId,
          });
        }
      } catch (err) {
        console.error("[socket] video_call:answer error:", err.message);
      }
    });

    socket.on("video_call:end", async (data) => {
      try {
        const { request_id, conversation_id, duration } = data;

        // Resolve the request. Re-calls after a completed call may arrive with
        // request_id = 0 (no active request in memory) — fall back to the most
        // recent approved/ended request for the conversation so the duration
        // is still recorded for both sides.
        let request = null;
        if (request_id) {
          request = await prisma.videoCallRequest.findUnique({
            where: { id: parseInt(request_id) },
          });
        }
        if (!request && conversation_id) {
          request = await prisma.videoCallRequest.findFirst({
            where: {
              conversationId: parseInt(conversation_id),
              status: { in: ["approved", "ended"] },
              OR: [{ senderId: userId }, { receiverId: userId }],
            },
            orderBy: { updatedAt: "desc" },
          });
        }
        if (!request) return;
        console.log(`[socket] Video call end for request ${request.id}`);

        // The call is over — stop the 1-minute ring timer.
        if (callRingTimers.has(request.id)) {
          clearTimeout(callRingTimers.get(request.id));
          callRingTimers.delete(request.id);
        }

        // Mark the request as ended so it is no longer an "active" request
        // (GET /video-call/status/:conversationId only returns pending/approved
        // and ended — ended means the pair can re-call directly). The call-
        // request card must NOT reappear as active after the call is over, so
        // also stamp the persisted request message with the terminal status.
        if (request.status !== "ended") {
          await prisma.videoCallRequest.update({
            where: { id: request.id },
            data: { status: "ended" },
          });
          console.log(`[socket]   ✓ Request ${request.id} marked as ended`);
        }
        await stampCallRequestMessage(prisma, request.conversationId, request.id, "ended");

        const otherId = request.senderId === userId ? request.receiverId : request.senderId;
        const durationSec = Math.max(0, parseInt(duration) || 0);

        // Close the remote caller/callee screen.
        io.to(`user:${otherId}`).emit("video_call:ended", {
          id: request.id,
          conversation_id: request.conversationId,
          duration: durationSec,
        });

        // When the call actually took place, persist a shared "call record"
        // system message and broadcast it to the other party so the call
        // duration shows for BOTH sides (and survives a reload).
        if (durationSec > 0) {
          try {
            const minutes = String(Math.floor(durationSec / 60)).padStart(2, "0");
            const seconds = String(durationSec % 60).padStart(2, "0");
            const message = await prisma.message.create({
              data: {
                conversationId: request.conversationId,
                senderId: request.senderId,
                content: `Video call • ${minutes}:${seconds}`,
                type: "system",
                systemData: { type: "call_record", duration: durationSec },
                deliveredAt: onlineUsers.has(otherId) ? new Date() : null,
              },
            });
            io.to(`user:${otherId}`).emit("chat:receive", {
              id: message.id,
              conversation_id: message.conversationId,
              sender_id: message.senderId,
              content: message.content,
              type: "system",
              system_data: message.systemData || null,
              sent_at: message.sentAt.toISOString(),
              delivered_at: message.deliveredAt?.toISOString() ?? null,
              is_read: false,
            });
          } catch (err) {
            console.error("[socket] call_record persist error:", err.message);
          }
        }
      } catch (err) {
        console.error("[socket] video_call:end error:", err.message);
      }
    });

    // WebRTC signaling relay
    socket.on("call.offer", (data) => {
      const { receiver_id, payload } = data;
      if (!receiver_id || !payload) return;
      console.log(`[socket] Relay call.offer from ${userId} to ${receiver_id}`);
      io.to(`user:${receiver_id}`).emit("call.offer", {
        sender_id: userId,
        payload,
      });
    });

    socket.on("call.answer", (data) => {
      const { receiver_id, payload } = data;
      if (!receiver_id || !payload) return;
      console.log(`[socket] Relay call.answer from ${userId} to ${receiver_id}`);
      io.to(`user:${receiver_id}`).emit("call.answer", {
        payload,
      });
    });

    socket.on("call.ice", (data) => {
      const { receiver_id, payload } = data;
      if (!receiver_id || !payload) return;
      console.log(`[socket] Relay call.ice from ${userId} to ${receiver_id}`);
      io.to(`user:${receiver_id}`).emit("call.ice", {
        payload,
      });
    });

    socket.on("call.end", (data) => {
      const { receiver_id, duration } = data;
      if (!receiver_id) return;
      console.log(`[socket] Relay call.end from ${userId} to ${receiver_id}`);
      io.to(`user:${receiver_id}`).emit("call.end", {
        sender_id: userId,
        receiver_id,
        duration,
      });
    });

    socket.on("chat:set_disappearing", async (data) => {
      try {
        const { conversation_id, duration } = data;
        if (!conversation_id) return;

        const conversation = await prisma.conversation.findUnique({
          where: { id: parseInt(conversation_id) },
          include: { match: { select: { user1Id: true, user2Id: true } } },
        });
        if (!conversation) return;

        await prisma.conversation.update({
          where: { id: parseInt(conversation_id) },
          data: { disappearing_messages: duration },
        });

        const otherUserId = conversation.match.user1Id === userId
          ? conversation.match.user2Id
          : conversation.match.user1Id;

        const payload = {
          conversation_id: parseInt(conversation_id),
          duration: duration,
          set_by: userId,
        };

        io.to(`user:${otherUserId}`).emit("chat:disappearing_updated", payload);
        io.to(`user:${userId}`).emit("chat:disappearing_updated", payload);

        console.log(`[socket] Disappearing messages set for conversation ${conversation_id}: ${duration === null ? 'off' : duration + 'h'}`);
      } catch (err) {
        console.error("[socket] set_disappearing error:", err.message);
      }
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(userId);
      io.emit("user:disconnected", { user_id: userId });
      console.log(`[socket] User ${userId} disconnected`);
      clearInterval(heartbeat);

      // Record presence so the dot shows orange (0-30 min) then disappears.
      // Skipped for hidden users to avoid leaving a "recently active" trace.
      if (!presenceSettings.isHidden(userId)) {
        prisma.user
          .update({ where: { id: userId }, data: { last_seen_at: new Date() } })
          .catch((err) =>
            console.error("[socket] update last_seen_at (disconnect) error:", err.message),
          );
      }
    });
  });

  return io;
}

function isUserOnline(userId) {
  return onlineUsers.has(userId);
}

// The list of user IDs pushed to clients, excluding users who hide their
// online status (stealth mode).
function visibleOnlineUserIds() {
  return Array.from(onlineUsers.keys()).filter(
    (id) => !presenceSettings.isHidden(id),
  );
}

// Recompute and broadcast the visible online list to every connected client.
function broadcastOnlineUsers() {
  const io = getIO();
  if (!io) return;
  io.emit("users:online", visibleOnlineUserIds());
}

// Rebuild a server-hosted image URL using the host that the given user's
// socket connected with, so each device receives an avatar URL it can reach.
function normalizeImageUrlForUser(imageUrl, userId) {
  if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
  try {
    const url = new URL(imageUrl);
    if (!url.pathname.startsWith("/uploads/")) return imageUrl;
    const info = onlineUsers.get(parseInt(userId));
    const host = info?.host;
    if (!host) return imageUrl;
    return `${info.secure ? "https" : "http"}://${host}${url.pathname}`;
  } catch (e) {
    return imageUrl;
  }
}

function getIO() {
  return ioInstance;
}

// Force-kick every live connection for a (now deleted) user. Emits a
// realtime notice first so clients can react (e.g. force logout) before the
// socket is gracefully disconnected (close=false lets the in-flight event
// and the disconnect packet reach the client).
function disconnectUser(userId) {
  const io = ioInstance;
  if (!io) return;
  try {
    io.to(`user:${userId}`).emit("account:deleted", {
      message: "account_deleted",
    });
    io.in(`user:${userId}`).disconnectSockets(false);
  } catch (err) {
    console.error("[socket] disconnectUser error:", err.message);
  }
}

module.exports = { setupSocket, isUserOnline, getIO, normalizeImageUrlForUser, broadcastOnlineUsers, disconnectUser };
