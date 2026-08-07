const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { sendPushToUser } = require("../services/fcm");
const { verifyAndGrantPurchase } = require("../services/playBilling");

const HEART_REFILL_HOURS = 16;
const HEART_REFILL_AMOUNT = 30;
const MESSAGE_REFILL_HOURS = 24;
const MESSAGE_REFILL_AMOUNT = 2;
const EYE_REFILL_HOURS = 18;
const EYE_REFILL_AMOUNT = 2;
const REWIND_REFILL_HOURS = 16;
const REWIND_REFILL_AMOUNT = 1;
const AD_COOLDOWN_MINUTES = 60;
const AD_HEART_REWARD = 1;

// In-memory ad session tracking (resets on server restart)
const adSessions = new Map(); // userId -> { token, createdAt, completedCount, lastCompletedAt }
const adIpTracker = new Map(); // ip -> [timestamps]

function generateAdToken() {
  return require("crypto").randomBytes(16).toString("hex");
}

// Secure purchase path shared by all /credits/purchase-* endpoints. The product
// id comes from the route (never from the client) and the reward amount is
// defined in the server-side catalog (playBilling.js). Requires a real Google
// Play purchaseToken; replay attempts are rejected via the ledger.
async function handleSecurePurchase(req, res, productId, responseField, message) {
  try {
    const { purchaseToken, orderId } = req.body || {};
    if (!purchaseToken) {
      return res.status(400).json({ error: "purchaseToken is required" });
    }
    await verifyAndGrantPurchase({ userId: req.user.id, productId, purchaseToken, orderId });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ success: true, [responseField]: user[responseField], message });
  } catch (error) {
    if (error?.isBillingError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error(`[credits/${productId}]`, error?.message || error);
    res.status(500).json({ error: "Internal server error" });
  }
}

function getAdSession(userId) {
  return adSessions.get(userId);
}

function createAdSession(userId) {
  const token = generateAdToken();
  const session = {
    token,
    createdAt: Date.now(),
    completedCount: 0,
    lastCompletedAt: null,
  };
  adSessions.set(userId, session);
  return session;
}

function isAdSessionValid(userId, token) {
  const session = adSessions.get(userId);
  if (!session) return false;
  if (session.token !== token) return false;
  if (Date.now() - session.createdAt > 5 * 60 * 1000) {
    adSessions.delete(userId);
    return false;
  }
  return true;
}

function detectSuspiciousPattern(userId, ip) {
  const session = adSessions.get(userId);
  if (!session) return false;

  // Too many completions in short time
  if (session.completedCount >= 3) {
    const timeSinceFirst = Date.now() - session.createdAt;
    if (timeSinceFirst < 5 * 60 * 1000) return true;
  }

  // Rapid completions (less than 10 seconds apart)
  if (session.lastCompletedAt) {
    if (Date.now() - session.lastCompletedAt < 10 * 1000) return true;
  }

  // IP-based tracking: too many requests from same IP
  if (ip) {
    const now = Date.now();
    const timestamps = adIpTracker.get(ip) || [];
    const recent = timestamps.filter((t) => now - t < 60 * 1000);
    if (recent.length >= 5) return true;
    recent.push(now);
    adIpTracker.set(ip, recent);
  }

  return false;
}

async function autoRefill(user) {
  const updates = {};
  const refilled = { hearts: false, messages: false, eyes: false, rewinds: false };
  const now = new Date();

  if (user.hearts <= 0 && user.heart_refill_at && new Date(user.heart_refill_at) <= now) {
    updates.hearts = HEART_REFILL_AMOUNT;
    updates.heart_refill_at = null;
    refilled.hearts = true;
  }
  if (user.message_credits <= 0 && user.message_refill_at && new Date(user.message_refill_at) <= now) {
    updates.message_credits = MESSAGE_REFILL_AMOUNT;
    updates.message_refill_at = null;
    refilled.messages = true;
  }
  if (user.eye_credits <= 0 && user.eye_refill_at && new Date(user.eye_refill_at) <= now) {
    updates.eye_credits = EYE_REFILL_AMOUNT;
    updates.eye_refill_at = null;
    refilled.eyes = true;
  }
  if (user.rewind_credits <= 0 && user.rewind_refill_at && new Date(user.rewind_refill_at) <= now) {
    updates.rewind_credits = REWIND_REFILL_AMOUNT;
    updates.rewind_refill_at = null;
    refilled.rewinds = true;
  }
  if (Object.keys(updates).length === 0) return { user, refilled };

  const updated = await prisma.user.update({ where: { id: user.id }, data: updates });
  return { user: updated, refilled };
}

async function getRefreshedUser(userId) {
  let user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const result = await autoRefill(user);
  user = result.user;

  // Send push for refills
  if (result.refilled.hearts) {
    sendPushToUser({
      userId,
      title: "â¤ï¸ Hearts Refilled",
      body: `Your hearts have been refilled to ${HEART_REFILL_AMOUNT}!`,
      data: { type: "hearts_refilled", amount: String(HEART_REFILL_AMOUNT) },
      prisma,
    });
  }
  if (result.refilled.messages) {
    sendPushToUser({
      userId,
      title: "ðŸ’¬ Messages Refilled",
      body: `Your messages have been refilled to ${MESSAGE_REFILL_AMOUNT}!`,
      data: { type: "messages_refilled", amount: String(MESSAGE_REFILL_AMOUNT) },
      prisma,
    });
  }
  if (result.refilled.eyes) {
    sendPushToUser({
      userId,
      title: "ðŸ‘ï¸ Eyes Refilled",
      body: `Your eye credits have been refilled to ${EYE_REFILL_AMOUNT}!`,
      data: { type: "eyes_refilled", amount: String(EYE_REFILL_AMOUNT) },
      prisma,
    });
  }
  if (result.refilled.rewinds) {
    sendPushToUser({
      userId,
      title: "â†©ï¸ Rewind Refilled",
      body: `Your rewind credits have been refilled to ${REWIND_REFILL_AMOUNT}!`,
      data: { type: "rewinds_refilled", amount: String(REWIND_REFILL_AMOUNT) },
      prisma,
    });
  }

  return user;
}

// GET /credits
router.get("/", authenticateToken, async (req, res) => {
  try {
    const user = await getRefreshedUser(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    // Calculate claim windows for frontend countdown
    let next_claim_at = null;
    let claim_expiry_at = null;
    let daily_claimed = false;
    if (user.last_reward_claim_date) {
      const lastClaim = new Date(user.last_reward_claim_date);
      const nextClaim = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000);
      const expiry = new Date(nextClaim.getTime() + 3 * 60 * 60 * 1000);
      const now = new Date();
      next_claim_at = nextClaim.toISOString();
      claim_expiry_at = expiry.toISOString();
      // claimed if current time is before next_claim window
      daily_claimed = now < nextClaim;
      // if past expiry, streak should reset (handled in daily-reward claim)
    }

    // â”€â”€ Auto-create notifications for ready rewards â”€â”€
    const now = new Date();

    // Mystery Box ready?
    const MYSTERY_COOLDOWN = 10800; // 3 hours
    let mysteryReady = true;
    if (user.mystery_box_at) {
      const elapsed = (now - new Date(user.mystery_box_at).getTime()) / 1000;
      mysteryReady = elapsed >= MYSTERY_COOLDOWN;
    }
    if (mysteryReady) {
      const existing = await prisma.notification.findFirst({
        where: { userId: user.id, type: "mystery_box", isRead: false },
      });
      if (!existing) {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: "mystery_box",
            title: "Mystery Box Ready! ðŸŽ",
            body: "Your mystery box is ready! Tap to open and claim your reward.",
          },
        });
      }
    }

    // Daily Reward claimable?
    if (!daily_claimed) {
      const existing = await prisma.notification.findFirst({
        where: { userId: user.id, type: "daily_reward", isRead: false },
      });
      if (!existing) {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: "daily_reward",
            title: "Daily Reward Ready! ðŸŽ‰",
            body: "Your daily reward is waiting! Tap to claim now.",
          },
        });
      }
    }

    // Eye ready to claim?
    const eyeReady = !user.eye_refill_at || new Date() >= new Date(user.eye_refill_at);
    if (eyeReady) {
      const existing = await prisma.notification.findFirst({
        where: { userId: user.id, type: "eye_ready", isRead: false },
      });
      if (!existing) {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: "eye_ready",
            title: "ðŸ‘ï¸ Eye Ready!",
            body: "Your free eye is ready to claim! Go to Rewards Center.",
          },
        });
      }
    }

    res.json({
      hearts: user.hearts,
      super_likes: user.super_likes,
      message_credits: user.message_credits,
      eye_credits: user.eye_credits ?? EYE_REFILL_AMOUNT,
      rewind_credits: user.rewind_credits ?? 0,
      eye_refill_at: user.eye_refill_at?.toISOString() ?? null,
      next_eye_claim_at: user.next_eye_claim_at?.toISOString() ?? null,
      heart_refill_at: user.heart_refill_at,
      message_refill_at: user.message_refill_at,
      rewind_refill_at: user.rewind_refill_at?.toISOString() ?? null,
      last_ad_at: user.last_ad_at,
      streak_count: user.streak_count || 0,
      last_reward_claim_date: user.last_reward_claim_date,
      mystery_box_at: user.mystery_box_at,
      next_claim_at,
      claim_expiry_at,
      daily_claimed,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/ad-session â€” start an ad session, returns session token
router.post("/ad-session", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check ad cooldown
    if (user.last_ad_at) {
      const elapsed = Date.now() - new Date(user.last_ad_at).getTime();
      if (elapsed < AD_COOLDOWN_MINUTES * 60 * 1000) {
        const remaining = Math.ceil((AD_COOLDOWN_MINUTES * 60 * 1000 - elapsed) / 60000);
        return res.status(429).json({ error: `Wait ${remaining} min before next ad` });
      }
    }

    const session = createAdSession(req.user.id);
    res.json({ session_token: session.token, expires_in: 300 });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/watch-ad
router.post("/watch-ad", authenticateToken, async (req, res) => {
  try {
    const { type, session_token } = req.body; // "hearts" only
    if (type !== "hearts") {
      return res.status(400).json({ error: "Only hearts ad is available" });
    }

    // Validate session token
    if (!session_token || !isAdSessionValid(req.user.id, session_token)) {
      return res.status(403).json({ error: "Invalid or expired ad session. Please try again." });
    }

    // Detect suspicious patterns
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (detectSuspiciousPattern(req.user.id, ip)) {
      adSessions.delete(req.user.id);
      return res.status(403).json({ error: "Suspicious activity detected. Please watch the ad normally." });
    }

    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check ad cooldown (15 min)
    if (user.last_ad_at) {
      const elapsed = Date.now() - new Date(user.last_ad_at).getTime();
      if (elapsed < AD_COOLDOWN_MINUTES * 60 * 1000) {
        const remaining = Math.ceil((AD_COOLDOWN_MINUTES * 60 * 1000 - elapsed) / 60000);
        return res.status(429).json({ error: `Wait ${remaining} min before next ad` });
      }
    }

    // Update session
    const session = adSessions.get(req.user.id);
    if (session) {
      session.completedCount++;
      session.lastCompletedAt = Date.now();
      adSessions.set(req.user.id, session);
    }

    const update = { last_ad_at: new Date() };
    if (type === "hearts") {
      update.hearts = user.hearts + AD_HEART_REWARD;
    }
    user = await prisma.user.update({ where: { id: user.id }, data: update });
    res.json({ hearts: user.hearts, message_credits: user.message_credits });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/purchase-hearts
router.post("/purchase-hearts", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "hearts_pack_70", "hearts", "70 Hearts purchased")
);

// POST /credits/purchase-messages
router.post("/purchase-messages", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "messages_pack_20", "message_credits", "20 Messages purchased")
);

// POST /credits/purchase-super-likes
router.post("/purchase-super-likes", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "super_likes_pack_10", "super_likes", "10 Super likes purchased")
);

// POST /credits/purchase-rewinds
router.post("/purchase-rewinds", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "rewinds_pack_10", "rewind_credits", "10 Rewinds purchased")
);

// POST /credits/daily-reward â€” claim daily login reward with 24h/48h streak logic
router.post("/daily-reward", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const now = new Date();
    const lastClaim = user.last_reward_claim_date ? new Date(user.last_reward_claim_date) : null;

    if (lastClaim) {
      const diffHours = (now - lastClaim) / (1000 * 60 * 60);

      if (diffHours < 24) {
        const remainingHours = Math.ceil(24 - diffHours);
        return res.status(429).json({
          error: `Already claimed today. Come back in ${remainingHours}h.`,
          daily_claimed: true,
          streak_count: user.streak_count,
        });
      }

      if (diffHours > 48) {
        // Missed more than 24h â†’ streak reset to day 1
        const updated = await prisma.user.update({
          where: { id: req.user.id },
          data: {
            streak_count: 1,
            last_reward_claim_date: now,
            hearts: user.hearts + 2,
          },
        });
        return res.json({
          message: "Streak reset! Back to Day 1.",
          streak: 1,
          reset: true,
          hearts: updated.hearts,
          daily_claimed: true,
        });
      }
    }

    // Increment streak (1-7 cycle)
    let nextStreak = (user.streak_count || 0) + 1;
    if (nextStreak > 7) nextStreak = 1;

    // Rewards table per day
    const rewardsTable = {
      1: { hearts: 2, messages: 1, stars: 0 },
      2: { hearts: 3, messages: 0, stars: 1 },
      3: { hearts: 5, messages: 1, stars: 1 },
      4: { hearts: 9, messages: 1, stars: 1 },
      5: { hearts: 12, messages: 2, stars: 1 },
      6: { hearts: 15, messages: 2, stars: 2 },
      7: { hearts: 18, messages: 3, stars: 2 },
    };
    const reward = rewardsTable[nextStreak] || rewardsTable[1];

    const updateData = {
      streak_count: nextStreak,
      last_reward_claim_date: now,
      hearts: user.hearts + reward.hearts,
      message_credits: user.message_credits + reward.messages,
    };
    if (reward.stars > 0) {
      updateData.super_likes = user.super_likes + reward.stars;
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
    });

    res.json({
      message: `Day ${nextStreak} reward claimed!`,
      streak: nextStreak,
      reward,
      hearts: updated.hearts,
      message_credits: updated.message_credits,
      super_likes: updated.super_likes,
      daily_claimed: true,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/mystery-box â€” open a mystery box (10 hour cooldown)
router.post("/mystery-box", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const now = Date.now();
    const COOLDOWN = 10800; // 3 hours in seconds

    if (user.mystery_box_at) {
      const elapsed = (now - new Date(user.mystery_box_at).getTime()) / 1000;
      if (elapsed < COOLDOWN) {
        return res.status(429).json({
          error: "Mystery box on cooldown",
          next_in: Math.ceil(COOLDOWN - elapsed),
          mystery_cooldown: Math.ceil(COOLDOWN - elapsed),
        });
      }
    }

    // Weighted probability system
    const roll = Math.random() * 100;
    let reward;

    if (roll < 3) {
      // 3% rare: 6 hearts
      reward = { type: "hearts", amount: 6 };
    } else if (roll < 30) {
      // 27% common: 2-4 hearts
      reward = { type: "hearts", amount: Math.floor(Math.random() * 3) + 2 };
    } else if (roll < 45) {
      // 15% rare: 3 messages
      reward = { type: "messages", amount: 3 };
    } else if (roll < 70) {
      // 25% common: 1-2 messages
      reward = { type: "messages", amount: Math.floor(Math.random() * 2) + 1 };
    } else if (roll < 80) {
      // 10% rare: 2 stars
      reward = { type: "super_likes", amount: 2 };
    } else {
      // 20% common: 1 star
      reward = { type: "super_likes", amount: 1 };
    }

    const updateData = { mystery_box_at: new Date() };
    if (reward.type === "hearts") {
      updateData.hearts = user.hearts + reward.amount;
    } else if (reward.type === "messages") {
      updateData.message_credits = user.message_credits + reward.amount;
    } else {
      updateData.super_likes = user.super_likes + reward.amount;
    }

    const updated = await prisma.user.update({ where: { id: req.user.id }, data: updateData });

    res.json({
      reward: reward.type,
      amount: reward.amount,
      next_in: COOLDOWN,
      mystery_cooldown: COOLDOWN,
      hearts: updated.hearts,
      message_credits: updated.message_credits,
      super_likes: updated.super_likes,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// â”€â”€ Eye Credits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /credits/eyes/use â€” consume 1 eye credit to reveal a blurred profile
router.post("/eyes/use", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.eye_credits <= 0) {
      return res.status(429).json({ error: "No eye credits left", eye_credits: 0 });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        eye_credits: user.eye_credits - 1,
        ...(user.eye_credits - 1 <= 0 && !user.eye_refill_at
          ? { eye_refill_at: new Date(Date.now() + EYE_REFILL_HOURS * 60 * 60 * 1000) }
          : {}),
      },
    });

    res.json({ eye_credits: updated.eye_credits });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/claim-eye â€” claim a free eye after 18h cooldown (manual from Rewards Center)
router.post("/claim-eye", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.eye_refill_at && new Date() < new Date(user.eye_refill_at)) {
      const remainingMs = new Date(user.eye_refill_at).getTime() - Date.now();
      return res.status(429).json({
        error: "Eye not ready yet",
        eye_refill_at: user.eye_refill_at,
        remaining_seconds: Math.ceil(remainingMs / 1000),
      });
    }

    const nextClaimAt = new Date(Date.now() + EYE_REFILL_HOURS * 60 * 60 * 1000);

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        eye_credits: (user.eye_credits ?? EYE_REFILL_AMOUNT) + 1,
        eye_refill_at: nextClaimAt,
      },
    });

    await prisma.notification.create({
      data: {
        userId: req.user.id,
        type: "reward",
        title: "ðŸ‘ï¸ Eye Claimed!",
        body: "You earned a new eye credit. Use it to reveal who viewed your profile!",
      },
    });

    res.json({
      eye_credits: updated.eye_credits,
      eye_refill_at: nextClaimAt.toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /credits/eyes â€” fetch eye credits + next claim availability
router.get("/eyes", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const canClaim = !user.eye_refill_at || new Date() >= new Date(user.eye_refill_at);

    res.json({
      eye_credits: user.eye_credits ?? EYE_REFILL_AMOUNT,
      eye_refill_at: user.eye_refill_at?.toISOString() ?? null,
      can_claim_eye: canClaim,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/buy-eye - purchase eye credits
router.post("/buy-eye", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "eye_credits_pack_1", "eye_credits", "1 Eye credit added")
);

// POST /credits/watch-ad-eye â€” watch ad to earn 1 eye credit
router.post("/watch-ad-eye", authenticateToken, async (req, res) => {
  try {
    const { session_token } = req.body;

    // Validate session token
    if (!session_token || !isAdSessionValid(req.user.id, session_token)) {
      return res.status(403).json({ error: "Invalid or expired ad session. Please try again." });
    }

    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (detectSuspiciousPattern(req.user.id, ip)) {
      adSessions.delete(req.user.id);
      return res.status(403).json({ error: "Suspicious activity detected." });
    }

    const session = adSessions.get(req.user.id);
    if (session) {
      session.completedCount++;
      session.lastCompletedAt = Date.now();
      adSessions.set(req.user.id, session);
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { eye_credits: { increment: 1 }, last_ad_at: new Date() },
    });

    res.json({ eye_credits: user.eye_credits });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// â”€â”€ Rewind Credits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /credits/rewind/use â€” consume 1 rewind credit to undo last swipe
router.post("/rewind/use", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.rewind_credits <= 0) {
      return res.status(429).json({ error: "No rewind credits left", rewind_credits: 0 });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        rewind_credits: user.rewind_credits - 1,
        ...(user.rewind_credits - 1 <= 0 && !user.rewind_refill_at
          ? { rewind_refill_at: new Date(Date.now() + REWIND_REFILL_HOURS * 60 * 60 * 1000) }
          : {}),
      },
    });

    res.json({ rewind_credits: updated.rewind_credits });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /credits/buy-rewind - purchase rewind credits
router.post("/buy-rewind", authenticateToken, (req, res) =>
  handleSecurePurchase(req, res, "rewinds_pack_10", "rewind_credits", "10 Rewinds added")
);

module.exports = router;
