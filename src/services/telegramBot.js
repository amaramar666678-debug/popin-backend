const { Telegraf } = require("telegraf");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Admin group chat ID (starts with -100 for supergroups). Complaints are
// forwarded ONLY here — never to a personal chat.
const ADMIN_GROUP_CHAT_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;

if (!TOKEN) {
  console.warn("[telegram-bot] TELEGRAM_BOT_TOKEN not set — bot disabled");
  module.exports = { initTelegramBot: () => {}, stopTelegramBot: () => {} };
  return;
}

if (!ADMIN_GROUP_CHAT_ID) {
  console.warn("[telegram-bot] TELEGRAM_ADMIN_GROUP_ID not set — complaints will NOT be forwarded");
}

const bot = new Telegraf(TOKEN);

// Tracks whether a user has triggered complaint mode and is writing their complaint.
// Key: userId (number), Value: "WAITING_FOR_COMPLAINT"
const userState = new Map();

// ── /start ──────────────────────────────────────────────────────────
bot.start((ctx) => {
  userState.delete(ctx.from.id);
  const name = ctx.from.first_name || "there";
  ctx.reply(
    `👋 *Welcome to Popin Support, ${name}!*\n\n` +
      `I can help you in two ways:\n\n` +
      `🔹 *FAQ* — Ask about login, stars, video calls, verification, photos, credits, matches, blocking, deleting account. I reply instantly.\n\n` +
      `🔹 *Support team* — Type *"شكوى"* (or "complaint") and I'll ask you to write your issue in one message, then forward it to the human support team.\n\n` +
      `How can I help you? 💙`,
    { parse_mode: "Markdown" }
  );
});

// ── /cancel ──────────────────────────────────────────────────────────
bot.command("cancel", (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply("✅ Complaint mode cancelled. You're back to the main menu. Ask me anything or type *شكوى* to start a new complaint.", { parse_mode: "Markdown" });
});

// ── FAQ auto-reply map ───────────────────────────────────────────────
const faqReplies = {
  login: "🔑 *Login Issues*\n\nMake sure your email and password are correct. Tap \"Forgot Password\" on the login screen to reset. Still stuck? Type *شكوى* and our team will help.",
  "كلمة السر": "🔑 *نسيت كلمة المرور*\n\nاضغط على \"Forgot Password\" في شاشة تسجيل الدخول لإعادة تعيين كلمة المرور. المشكلة مستمرة؟ اكتب *شكوى* للدعم.",
  "تسجيل دخول": "🔑 *مشاكل تسجيل الدخول*\n\nتأكد من بريدك الإلكتروني وكلمة المرور. استخدم \"Forgot Password\" لإعادة التعيين.",
  banned: "🚫 *Account Suspended*\n\nAccounts are suspended for violating community guidelines (fake photos, harassment, spam). Think it's a mistake? Type *شكوى* to appeal.",
  حظر: "🚫 *حظر الحساب*\n\nيُحظر الحساب عند مخالفة الإرشادات (صور مزيفة، إزعاج، سبام). تعتقد أنه خطأ؟ اكتب *شكوى* لتقديم استئناف.",
  star: "⭐ *Stars (Super Likes)*\n\nTap the star icon on a profile to send. Each star costs 1 credit. Blue badge shows in chat for 24h.",
  "سوبر لايك": "⭐ *النجوم (سوبر لايك)*\n\nاضغط أيقونة النجمة على بطاقة المستخدم. تكلف نجمة واحدة. تظهر شارة زرقاء في الشات 24 ساعة.",
  credit: "💎 *Credits*\n\nMessage credits refill daily. Star & Eye credits → Store. Daily bonuses → Rewards screen.",
  رصيد: "💎 *الأرصدة*\n\nرسائل: تتجدد يومياً. نجوم وعيون: من المتجر. مكافآت يومية: شاشة Rewards.",
  video: "📹 *Video Calls*\n\nTap video icon in chat → partner approves → tap again to start. Duration saved in chat.",
  "مكالمة فيديو": "📹 *مكالمات الفيديو*\n\nأيقونة الفيديو في الشات → موافقة الطرف الآخر → اضغط للبدء. المدة تُحفظ.",
  verify: "🔵 *Verification*\n\nEdit Profile → \"Verify My Photo\" → take a selfie. Blue badge for verified users.",
  توثيق: "🔵 *توثيق الحساب*\n\nEdit Profile → \"Verify My Photo\" → التقط سيلفي. شارة زرقاء للحسابات الموثقة.",
  photo: "🖼️ *Photos*\n\nUp to 3 photos in Edit Profile. Tap crown = primary. Long-press = delete.",
  صور: "🖼️ *الصور*\n\nحتى 3 صور في Edit Profile. التاج = أساسية. ضغطة طويلة = حذف.",
  delete: "🗑️ *Delete Account*\n\nSettings → \"Delete Account\". Removes profile, matches, messages permanently.",
  "حذف حساب": "🗑️ *حذف الحساب*\n\nالإعدادات → \"Delete Account\". يحذف كل شيء نهائياً.",
  report: "⚠️ *Report / Block*\n\nReport from profile (⋮). Block → Settings → \"Blocked Users\".",
  "تبليغ عن": "⚠️ *تبليغ / حظر*\n\nتبليغ من الملف الشخصي. حظر → الإعدادات → \"Blocked Users\".",
  match: "💖 *Matches*\n\nSwipe right = like, left = pass. Both like = match! \"Liked Me\" tab shows who liked you.",
  مطابقة: "💖 *المطابقات*\n\nسحب يمين = إعجاب، يسار = تخطي. إعجاب متبادل = تطابق! تبويب \"Liked Me\".",
  help: "🤖 *Usage*\n\nFAQ keywords: `login`, `star`, `video`, `verify`, `photo`, `credit`, `match`, `delete`, `report`\nComplaint: type *شكوى* then write your message.",
  مساعدة: "🤖 *الاستخدام*\n\nأسئلة: `login`, `star`, `video`, `verify`...\nشكوى: اكتب *شكوى* ثم اكتب رسالتك.",
  اهلا: "👋 أهلاً! أنا بوت دعم Popin. اسألني أو اكتب *شكوى* للدعم البشري.",
  hello: "👋 Hello! I'm the Popin support bot. Ask me anything or type *شكوى* for human support.",
  hi: "👋 Hey! Ask me about the app or type *شكوى* for the support team.",
  سلام: "👋 أهلاً! اسألني عن التطبيق أو اكتب *شكوى* للدعم.",
};

// ── Complaint trigger words (any language) ───────────────────────────
const isComplaintTrigger = (text) => {
  const t = text.toLowerCase();
  return t.includes("شكوى") || t.includes("complaint") ||
         t.includes("مشكلة") || t.includes("مشكله") ||
         t.includes("issue") || t.includes("bug") ||
         t.includes("اشتكي") || t.includes("اشتكى") ||
         t.includes("تبليغ") || t.includes("شكوه");
};

// ── Main message handler ────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();
  const userId = ctx.from.id;

  // ── Step 1: Check if user has pending complaint to submit ──
  if (userState.get(userId) === "WAITING_FOR_COMPLAINT") {
    userState.delete(userId);
    const username = ctx.from.username ? `@${ctx.from.username}` : "no username";
    const firstName = ctx.from.first_name || "User";

    await ctx.reply(
      "✅ *Your complaint has been received!*\n\n" +
        "The support team will review it and get back to you as soon as possible.\n\n" +
        "⏳ Typical response time: within 24 hours. Thank you for your patience! 💙",
      { parse_mode: "Markdown" }
    );

    // Forward complaint to the admin group ONLY (never shown to the user)
    const adminMsg =
      `🚨 *New Complaint*\n\n` +
      `👤 *Name:* ${firstName} (${username})\n` +
      `🆔 *User ID:* \`${userId}\`\n` +
      `📝 *Message:* ${text}`;

    try {
      if (!ADMIN_GROUP_CHAT_ID) {
        console.warn("[telegram-bot] ADMIN_GROUP_CHAT_ID not set — skipping forward");
      } else {
        await bot.telegram.sendMessage(ADMIN_GROUP_CHAT_ID, adminMsg, { parse_mode: "Markdown" });
        console.log(`[telegram-bot] Complaint forwarded from ${userId} → admin group`);
      }
    } catch (err) {
      console.error("[telegram-bot] Failed to forward complaint:", err.message);
    }
    return;
  }

  // ── Step 2: Detect complaint trigger → ask user to write it ──
  if (isComplaintTrigger(lowerText)) {
    userState.set(userId, "WAITING_FOR_COMPLAINT");
    await ctx.reply(
      "✍️ *Please write your complaint in one message so I can send it to the support team.*\n\n" +
        "اكتب شكواك في رسالة واحدة لكي أرسلها لطاقم الدعم الفني.\n\n" +
        "To cancel, type /cancel",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Step 3: FAQ auto-reply ──
  for (const [keyword, reply] of Object.entries(faqReplies)) {
    if (lowerText.includes(keyword.toLowerCase())) {
      await ctx.reply(reply, { parse_mode: "Markdown" });
      return;
    }
  }

  // ── Step 4: Unrecognized → suggest options ──
  await ctx.reply(
    "🤔 I'm not sure what you mean.\n\n" +
      "📌 *FAQ topics:* `login`, `star`, `video`, `verify`, `photo`, `credit`, `match`, `delete`, `report`\n\n" +
      "👤 *Human support:* type *شكوى* and I'll ask you to write your complaint.",
    { parse_mode: "Markdown" }
  );
});

// ── Launch ──────────────────────────────────────────────────────────
function initTelegramBot() {
  bot.launch();
  console.log("[telegram-bot] Bot started (telegraf · polling)");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

function stopTelegramBot() {
  bot.stop();
  console.log("[telegram-bot] Bot stopped");
}

module.exports = { initTelegramBot, stopTelegramBot };
