// Per-pair video call request rate limit.
// After DECLINE_LIMIT requests from `callerId` to `calleeId` have been
// declined within the cooldown window, further requests from that caller to
// that callee are blocked. Other users/pairs are unaffected.

const DECLINE_LIMIT = 3;
const DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns the decline history for one directional pair (caller -> callee).
 * Only declines inside the cooldown window are counted, so the block is
 * lifted once the window passes.
 */
async function getCallDeclineInfo(prisma, callerId, calleeId) {
  const since = new Date(Date.now() - DECLINE_COOLDOWN_MS);
  const declined = await prisma.videoCallRequest.findMany({
    where: {
      senderId: callerId,
      receiverId: calleeId,
      status: "declined",
      updatedAt: { gte: since },
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });

  const declinedCount = declined.length;
  const lastDeclinedAt = declinedCount > 0 ? declined[0].updatedAt : null;
  let remainingSeconds = 0;
  if (lastDeclinedAt) {
    remainingSeconds = Math.max(
      0,
      Math.floor(
        (DECLINE_COOLDOWN_MS - (Date.now() - lastDeclinedAt.getTime())) / 1000
      )
    );
  }

  return {
    declined_count: declinedCount,
    last_declined_at: lastDeclinedAt ? lastDeclinedAt.toISOString() : null,
    blocked: declinedCount >= DECLINE_LIMIT,
    remaining_seconds: remainingSeconds,
  };
}

function declineBlockMessage(info) {
  const minutes = Math.floor((info.remaining_seconds % 3600) / 60);
  const hours = Math.floor(info.remaining_seconds / 3600);
  const timeText =
    hours > 0
      ? `${hours} hours ${minutes} minutes`
      : `${minutes} minutes`;
  return `Your call request was declined ${info.declined_count} times by this user. You must wait ${timeText} before sending another call request.`;
}

module.exports = {
  getCallDeclineInfo,
  declineBlockMessage,
  DECLINE_LIMIT,
  DECLINE_COOLDOWN_MS,
};
