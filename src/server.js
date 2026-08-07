const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { prisma } = require("./middleware/prisma");

const app = express();
const server = http.createServer(app);

app.use(helmet());

// CORS: only allow explicit origins from CORS_ORIGINS (comma-separated env).
// Missing env = same-origin only (no cross-origin browser clients).
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length
      ? {
          origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            return callback(new Error("Not allowed by CORS"));
          },
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        }
      : { origin: false }
  )
);

app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// Auth brute-force protection: 10 attempts / 15 min per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// ── Health checks ──
app.get("/live", (req, res) => res.json({ status: "ok" }));

app.get("/ready", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "up" });
  } catch (err) {
    console.error("[ready] DB check failed:", err.message);
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), pid: process.pid });
});

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Popin API running" });
});

// Routes
app.use("/auth", authLimiter, require("./routes/auth"));
app.use("/profile", require("./routes/profile"));
app.use("/delete-account", require("./routes/delete_account_web"));
app.use("/upload", require("./routes/upload"));
app.use("/matches", require("./routes/matching"));
app.use("/swipe", require("./routes/swipe"));
app.use("/users", require("./routes/users"));
app.use("/map", require("./routes/map"));
app.use("/location", require("./routes/location"));
app.use("/verify", require("./routes/verification"));
app.use("/credits", require("./routes/credits"));
app.use("/billing", require("./routes/billing"));
app.use("/liked-me", require("./routes/liked_me"));
app.use("/reels", require("./routes/reels"));
app.use("/ws", require("./routes/ws"));
app.use("/conversations", require("./routes/conversations"));
app.use("/video-call", require("./routes/video_call"));
app.use("/blocks", require("./routes/blocks"));
app.use("/reports", require("./routes/reports"));
app.use("/notifications", require("./routes/notifications"));
app.use("/counters", require("./routes/counters"));
app.use("/boost", require("./routes/boost"));
app.use("/presence", require("./routes/presence"));

// Global error handler (must be after all routes)
app.use((err, req, res, next) => {
  console.error("[global-error]", err.message, err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

// Prevent server crash on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err?.message || err);
});

// Firebase
const { initFirebase } = require("./services/fcm");
initFirebase();

// Socket.io
const { setupSocket } = require("./services/socket");
setupSocket(server);
console.log("[socket.io] initialized");

// Telegram support bot
const { initTelegramBot } = require("./services/telegramBot");
initTelegramBot();

// Disappearing messages cron - run every 5 minutes
const cron = require("node-cron");
const { getIO } = require("./services/socket");

cron.schedule("*/5 * * * *", async () => {
  try {
    // Find all conversations with disappearing_messages set
    const conversations = await prisma.conversation.findMany({
      where: { disappearing_messages: { not: null } },
      select: { id: true, disappearing_messages: true, match: true },
    });

    for (const conv of conversations) {
      const hours = conv.disappearing_messages;
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

      // Delete messages older than the cutoff
      const deleted = await prisma.message.deleteMany({
        where: {
          conversationId: conv.id,
          sentAt: { lt: cutoff },
        },
      });

      if (deleted.count > 0) {
        console.log(`[disappearing] Deleted ${deleted.count} messages from conversation ${conv.id} (older than ${hours}h)`);
        // Notify connected users
        const io = getIO();
        if (io && conv.match) {
          io.to(`user:${conv.match.user1Id}`).emit("chat:disappearing_deleted", {
            conversation_id: conv.id,
            deleted_count: deleted.count,
          });
          io.to(`user:${conv.match.user2Id}`).emit("chat:disappearing_deleted", {
            conversation_id: conv.id,
            deleted_count: deleted.count,
          });
        }
      }
    }
  } catch (err) {
    console.error("[disappearing-cron] Error:", err.message);
  }
});
console.log("[disappearing-cron] scheduled (every 5 minutes)");

// Ban cleanup cron - clear expired bans (every 5 minutes)
cron.schedule("*/5 * * * *", async () => {
  try {
    const result = await prisma.user.updateMany({
      where: { is_banned: true, ban_expires_at: { lte: new Date() } },
      data: { is_banned: false, ban_reason: null, ban_expires_at: null },
    });
    if (result.count > 0) {
      console.log(`[unban-cron] Cleared ${result.count} expired bans`);
    }
  } catch (err) {
    console.error("[unban-cron] Error:", err.message);
  }
});
console.log("[unban-cron] scheduled (every 5 minutes)");

// Use the PORT injected by the runtime (Cloud Run sets PORT) and fall back to
// 3000 for local/docker-compose development.
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} (0.0.0.0)`);
});
