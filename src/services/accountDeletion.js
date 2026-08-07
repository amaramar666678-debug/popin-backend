const path = require("path");
const fs = require("fs");
const { disconnectUser } = require("./socket");

const uploadDir = path.join(__dirname, "..", "..", "uploads");

/**
 * Permanently purge a user and every piece of data tied to them, in FK
 * dependency order. Used by both the in-app endpoint (POST /profile/delete)
 * and the public web-based deletion page (POST /delete-account) so the two
 * flows always behave identically.
 *
 * Removes:
 *  - account record
 *  - profile images (rows + files on disk)
 *  - messages / conversations / matches (radical delete policy)
 *  - swipes, profile views, blocks, reports, notifications, devices
 *  - location (stored on the user row)
 *  - refresh tokens (all sessions) + purchase ledger
 *  - live socket connections (force-disconnect + "account:deleted" event)
 */
async function deleteUserData(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { images: true },
  });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  // Conversations/matches this user is part of.
  const matches = await prisma.match.findMany({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { id: true, conversation: { select: { id: true } } },
  });
  const matchIds = matches.map((m) => m.id);
  const conversationIds = matches
    .map((m) => m.conversation?.id)
    .filter((id) => id != null);

  if (conversationIds.length > 0) {
    await prisma.message.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    await prisma.videoCallRequest.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  }
  await prisma.videoCallRequest.deleteMany({
    where: { OR: [{ senderId: userId }, { receiverId: userId }] },
  });
  if (matchIds.length > 0) {
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  }

  await prisma.swipe.deleteMany({
    where: { OR: [{ swiperId: userId }, { targetId: userId }] },
  });
  await prisma.profileView.deleteMany({
    where: { OR: [{ viewerId: userId }, { viewedId: userId }] },
  });
  await prisma.blockedUser.deleteMany({
    where: { OR: [{ userId: userId }, { blockedUserId: userId }] },
  });
  await prisma.report.deleteMany({
    where: { OR: [{ reporterId: userId }, { reportedUserId: userId }] },
  });
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.device.deleteMany({ where: { userId } });
  await prisma.purchaseLedger.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });

  // Profile image files on disk (best-effort; missing files are ignored).
  for (const img of user.images || []) {
    try {
      const filePath = path.join(uploadDir, path.basename(img.imageUrl));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error("[accountDeletion] file cleanup error:", err.message);
    }
  }
  await prisma.image.deleteMany({ where: { userId } });

  // Final: the user row (removes any remaining cascade relations).
  await prisma.user.delete({ where: { id: userId } });

  // Kill live sockets so the deleted account stops receiving realtime data.
  disconnectUser(userId);
}

module.exports = { deleteUserData };
