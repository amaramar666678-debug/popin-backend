const { prisma } = require("../middleware/prisma");
const { getIO } = require("./socket");

// Server is the single source of truth for unread badges. Both counts are
// derived straight from the database so they stay accurate across devices,
// reinstalls and account switches.
async function getCounters(userId) {
  const matches = await prisma.match.findMany({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { user1Id: true, user2Id: true },
  });
  const matchedIds = matches.map((m) =>
    m.user1Id === userId ? m.user2Id : m.user1Id
  );

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { likes_seen_at: true },
  });

  // Likes that arrived after the user last opened the Liked-Me list and that
  // are not (yet) a match — mirroring the /liked-me list contents.
  const swipeWhere = {
    targetId: userId,
    action: { in: ["like", "super_like"] },
    swiperId: { notIn: [userId, ...matchedIds] },
    ...(user?.likes_seen_at
      ? { createdAt: { gt: user.likes_seen_at } }
      : {}),
  };
  const unreadLikes = await prisma.swipe.count({ where: swipeWhere });

  // Messages from the other side of any of my conversations that are still
  // unread (readAt === null).
  const unreadMessages = await prisma.message.count({
    where: {
      readAt: null,
      isDeleted: false,
      senderId: { not: userId },
      conversation: {
        match: { OR: [{ user1Id: userId }, { user2Id: userId }] },
      },
    },
  });

  return {
    unread_likes_count: unreadLikes,
    unread_messages_count: unreadMessages,
  };
}

// Push fresh counters to a user's connected devices in real time.
async function emitCounters(userId) {
  try {
    const io = getIO();
    if (!io) return;
    const counters = await getCounters(userId);
    io.to(`user:${userId}`).emit("counters", counters);
  } catch (err) {
    console.error("[counters] emit error:", err.message);
  }
}

module.exports = { getCounters, emitCounters };
