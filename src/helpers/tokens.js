const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { prisma } = require("../middleware/prisma");

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      type: "refresh",
      // Unique id so every issuance produces a distinct token (JWT is
      // otherwise deterministic for an identical payload, which would
      // collide on the stored hash during rotation).
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );
}

// Issue a new token pair and persist the refresh token (hash) with rotation.
async function issueTokens(user, meta = {}) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const record = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      userAgent: meta.userAgent || null,
    },
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    refresh_token_id: record.id,
    refresh_expires_at: expiresAt.toISOString(),
  };
}

// Rotate a refresh token: verify signature, validate the DB record, revoke
// the old one, and issue a fresh pair. Any re-use of a revoked token invalidates
// the whole chain (token theft detection).
async function rotateRefreshToken(rawToken, meta = {}) {
  const decoded = await new Promise((resolve, reject) => {
    jwt.verify(rawToken, process.env.JWT_SECRET, (err, d) =>
      err ? reject(err) : resolve(d)
    );
  });

  if (!decoded || decoded.type !== "refresh") {
    const err = new Error("Invalid refresh token");
    err.status = 401;
    throw err;
  }

  const tokenHash = hashToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
  });

  if (!existing) {
    const err = new Error("Invalid refresh token");
    err.status = 401;
    throw err;
  }

  if (existing.revokedAt) {
    // Token already used or logged out — revoke the entire chain.
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const err = new Error("Refresh token re-use detected; session revoked");
    err.status = 401;
    throw err;
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    const err = new Error("Refresh token expired");
    err.status = 401;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: existing.userId } });
  if (!user) {
    const err = new Error("User not found");
    err.status = 401;
    throw err;
  }

  const pair = await issueTokens(user, meta);

  // Revoke the old token, link it to its replacement.
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), replacedBy: pair.refresh_token_id },
  });

  return { ...pair, user };
}

// Revoke a specific refresh token (logout) or all sessions for a user.
async function revokeRefreshToken(rawToken, { all = false, userId = null } = {}) {
  if (all && userId) {
    const r = await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }

  const tokenHash = hashToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
  });
  if (!existing) return 0;

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
  return 1;
}

module.exports = {
  ACCESS_TOKEN_TTL,
  issueTokens,
  rotateRefreshToken,
  revokeRefreshToken,
  hashToken,
  signAccessToken,
};
