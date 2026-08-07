const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { requireProfilePhoto } = require("../middleware/require_photo");
const { formatUserResponse } = require("../helpers/user_response");

// POST /matches - get candidates
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { limit = 50, country_code, region } = req.body;
    const currentUserId = req.user.id;

    const regionCountryMap = {
      usa: ['US'],
      european_union: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'],
      russia: ['RU'],
      north_america: ['US','CA','MX','GT','HN','SV','NI','CR','PA','BZ','CU','JM','HT','DO','TT','BS','BB','AG','LC','KN','DM','VC','GD','JM'],
      south_america: ['BR','AR','CO','CL','PE','VE','EC','BO','PY','UY','GY','SR','FK'],
      asia: ['CN','JP','KR','IN','ID','TH','VN','PH','MY','SG','MM','KH','LA','BD','PK','NP','LK','TW','HK','MO','MN','KZ','UZ','TM','KG','TJ','AF','IQ','IR','SA','AE','QA','BH','KW','OM','JO','LB','IL','PS','SY','YE','TR','GE','AM','AZ'],
      africa: ['NG','EG','ZA','KE','ET','GH','TZ','UG','DZ','MA','TN','LY','SD','SS','CM','CI','SN','ML','BF','NE','TD','MG','MZ','AO','ZW','Zambia','Malawi','RW','UG','SO','DJ','ER','MG','MU','SC','Comoros','CV','ST','GQ','GA','CG','CD','BF','TG','BJ','GW','GN','SL','LR','GM','MR','Djibouti'],
    };

    let countryCodeFilter = country_code;
    if (!countryCodeFilter && region && region !== 'all' && regionCountryMap[region]) {
      countryCodeFilter = { in: regionCountryMap[region] };
    }

    const swiped = await prisma.swipe.findMany({
      where: { swiperId: currentUserId },
      select: { targetId: true },
    });
    const swipedIds = swiped.map((s) => s.targetId);

    const matches = await prisma.match.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
      },
      select: { user1Id: true, user2Id: true },
    });
    const matchedIds = matches.map((m) =>
      m.user1Id === currentUserId ? m.user2Id : m.user1Id
    );

    const excludeIds = [...new Set([...swipedIds, ...matchedIds, currentUserId])];

    const users = await prisma.user.findMany({
      where: {
        id: { notIn: excludeIds },
        ...(countryCodeFilter
          ? typeof countryCodeFilter === 'object'
            ? { country_code: countryCodeFilter }
            : { country_code: countryCodeFilter }
          : {}),
      },
      include: {
        images: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { id: "desc" },
      take: Math.min(limit, 100),
    });

    const results = users.map((u) => ({
      user: formatUserResponse(u, req),
      match_score: Math.random(),
      common_interests: [],
      distance_km: Math.random() * 50,
    }));

    res.json({ results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /matches - get user's matches with conversations
router.get("/", authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const matches = await prisma.match.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
      },
      include: {
        conversation: {
          include: {
            messages: {
              orderBy: { sentAt: "desc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { matchedAt: "desc" },
    });

    // Get blocked user IDs
    const blocks = await prisma.blockedUser.findMany({
      where: { userId: currentUserId },
      select: { blockedUserId: true },
    });
    const blockedIds = blocks.map((b) => b.blockedUserId);

    // Super likes sent to ME within the last 24h â†’ blue star badge in chat list
    const starCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const starSwipes = await prisma.swipe.findMany({
      where: {
        targetId: currentUserId,
        action: "super_like",
        createdAt: { gte: starCutoff },
      },
      select: { swiperId: true },
    });
    const starSwiperIds = new Set(starSwipes.map((s) => s.swiperId));

    const results = await Promise.all(
      matches
        .filter((match) => {
          const conv = match.conversation;
          // Direct-message conversations only become visible once the first
          // message is actually sent. Real matches always show even if empty.
          if (conv && conv.is_direct_message && (conv.messages?.length ?? 0) === 0) {
            return false;
          }
          const otherId = match.user1Id === currentUserId ? match.user2Id : match.user1Id;
          return !blockedIds.includes(otherId);
        })
        .map(async (match) => {
        const otherUserId =
          match.user1Id === currentUserId ? match.user2Id : match.user1Id;
        const otherUser = await prisma.user.findUnique({
          where: { id: otherUserId },
          include: {
            images: { orderBy: { sortOrder: "asc" } },
          },
        });

        const lastMessage = match.conversation?.messages?.[0] || null;

        const unreadCount = match.conversation
          ? await prisma.message.count({
              where: {
                conversationId: match.conversation.id,
                senderId: { not: currentUserId },
                readAt: null,
              },
            })
          : 0;

        return {
          match_id: match.id,
          matched_at: match.matchedAt.toISOString(),
          is_super_like: starSwiperIds.has(otherUserId),
          user: formatUserResponse(otherUser, req),
          conversation: match.conversation
            ? {
                id: match.conversation.id,
                last_message:
                  lastMessage?.type === "voice"
                    ? "ðŸŽ¤ Voice message"
                    : lastMessage?.content || null,
                last_message_type: lastMessage?.type || null,
                last_message_system_data: lastMessage?.systemData || null,
                last_message_sender_id: lastMessage?.senderId ?? null,
                last_message_at:
                  lastMessage?.sentAt?.toISOString() || null,
                unread_count: unreadCount,
              }
            : null,
        };
      })
    );

    res.json({ results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /matches/new - get recent mutual matches (for "New Matches" section)
router.get("/new", authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const matches = await prisma.match.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
        matchedAt: { gte: since },
      },
      include: {
        conversation: {
          include: {
            messages: { orderBy: { sentAt: "desc" }, take: 1 },
          },
        },
      },
      orderBy: { matchedAt: "desc" },
      take: 20,
    });

    const results = await Promise.all(
      matches
        .filter((match) => {
          const conv = match.conversation;
          if (conv && conv.is_direct_message && (conv.messages?.length ?? 0) === 0) {
            return false;
          }
          return true;
        })
        .map(async (match) => {
        const otherId = match.user1Id === currentUserId ? match.user2Id : match.user1Id;
        const otherUser = await prisma.user.findUnique({
          where: { id: otherId },
          include: { images: { orderBy: { sortOrder: "asc" } } },
        });
        return {
          match_id: match.id,
          matched_at: match.matchedAt.toISOString(),
          user: formatUserResponse(otherUser, req),
        };
      })
    );

    res.json({ results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
