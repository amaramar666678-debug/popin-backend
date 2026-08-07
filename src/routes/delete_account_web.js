const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const { prisma } = require("../middleware/prisma");
const { deleteUserData } = require("../services/accountDeletion");
const { sendDeletionCodeEmail } = require("../services/gmailService");

// ── Web-based account deletion (Google Play "Account Deletion" link) ──
// A public, same-origin HTML flow so users can request a permanent deletion
// from a browser without installing the app. Two proof methods:
//   1. email + password  (POST /delete-account)
//   2. email + one-time code sent to the inbox (POST /delete-account/confirm)
// No inline JavaScript is used so the pages stay compatible with Helmet CSP.

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const deletionCodes = new Map(); // email -> { code, expiresAt } (in-memory)

const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many attempts. Please try again later.",
});

const codeRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many code requests. Please try again later.",
});

const codeConfirmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many attempts. Please try again later.",
});

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} · Popin</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f6f6f7; color: #222; }
  .wrap { max-width: 460px; margin: 48px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 16px; padding: 28px; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size: 22px; margin: 0 0 8px; color: #111; }
  p { line-height: 1.55; color: #555; margin: 0 0 16px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; color: #333; }
  input { width: 100%; padding: 12px 14px; font-size: 15px; border: 1px solid #ddd; border-radius: 10px; outline: none; }
  input:focus { border-color: #FF4D8D; }
  button { width: 100%; margin-top: 20px; padding: 14px; font-size: 16px; font-weight: 700; color: #fff; background: #d93025; border: 0; border-radius: 10px; cursor: pointer; }
  .link { text-align: center; margin-top: 18px; font-size: 14px; color: #777; }
  .link a { color: #555; }
  .error { background: #fdecea; border: 1px solid #f5c6c2; color: #c5221f; padding: 12px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; }
  .success { background: #e6f4ea; border: 1px solid #b7dfc1; color: #137333; padding: 12px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; }
  .note { font-size: 13px; color: #888; margin-top: 14px; }
  .divider { text-align: center; color: #bbb; font-size: 13px; margin: 18px 0; }
</style>
</head>
<body>
<div class="wrap"><div class="card">${bodyHtml}</div></div>
</body>
</html>`;
}

function mainPage(error = null) {
  const errHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return layout(
    "Delete your account",
    `<h1>Delete your Popin account</h1>
     <p>Deleting your account is <b>permanent and cannot be undone</b>. Your profile, photos, matches, messages, location and all account data will be erased immediately.</p>
     <p class="note">If you have an active subscription on Google Play or the App Store, cancel it there <b>before</b> deleting, otherwise you may continue to be charged. The subscription is managed by the store, not by the app.</p>
     ${errHtml}
     <form method="POST" action="/delete-account">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Your password">
       <button type="submit">Delete account permanently</button>
     </form>
     <div class="divider">or</div>
     <p class="link">Use a <a href="/delete-account/request">one-time code sent to your email</a> instead.</p>
     <p class="note">You can also delete your account from inside the app: Settings → Account → Delete Account.</p>`
  );
}

function requestPage(error = null) {
  const errHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return layout(
    "Request deletion code",
    `<h1>Request a deletion code</h1>
     <p>We will email you a 6-digit code. Enter your email address to continue.</p>
     ${errHtml}
     <form method="POST" action="/delete-account/request">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
       <button type="submit">Send code</button>
     </form>
     <p class="link"><a href="/delete-account">Back</a></p>`
  );
}

function confirmPage(email, error = null) {
  const errHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return layout(
    "Confirm deletion",
    `<h1>Confirm deletion</h1>
     <p>A 6-digit code was sent to <b>${escapeHtml(email)}</b>. Enter it below to permanently delete your account.</p>
     <p class="note">Deleting your account is permanent and cannot be undone.</p>
     ${errHtml}
     <form method="POST" action="/delete-account/confirm">
       <input type="hidden" name="email" value="${escapeHtml(email)}">
       <label for="code">Confirmation code</label>
       <input id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required placeholder="123456">
       <button type="submit">Delete account permanently</button>
     </form>
     <p class="link"><a href="/delete-account/request">Resend code</a></p>`
  );
}

function resultPage(success, message) {
  const box = success
    ? `<div class="success">${escapeHtml(message)}</div>`
    : `<div class="error">${escapeHtml(message)}</div>`;
  return layout(
    success ? "Account deleted" : "Deletion failed",
    `<h1>${success ? "Your account has been deleted" : "Deletion failed"}</h1>
     ${box}
     <p>You can close this window. If you would like to use Popin again in the future, you will need to create a new account.</p>
     <p class="link"><a href="/delete-account">Back to deletion page</a></p>`
  );
}

// GET /delete-account — main form (email + password).
router.get("/", (req, res) => {
  res.send(mainPage());
});

// POST /delete-account — verify email + password and delete.
router.post("/", passwordLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password) {
    // Same generic error for missing account and wrong password (no enumeration).
    return res.status(200).send(mainPage("Invalid email or password."));
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(200).send(mainPage("Invalid email or password."));
  }

  try {
    await deleteUserData(prisma, user.id);
    res.send(
      resultPage(
        true,
        "Your account and all associated data have been permanently deleted."
      )
    );
  } catch (err) {
    console.error("[delete-account] deletion error:", err.message);
    res.status(200).send(mainPage("Deletion failed. Please try again later."));
  }
});

// GET /delete-account/request — ask for an email to send a code to.
router.get("/request", (req, res) => {
  res.send(requestPage());
});

// POST /delete-account/request — email a one-time deletion code.
// The response is identical whether or not the account exists (no enumeration).
router.post("/request", codeRequestLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const user = email
    ? await prisma.user.findUnique({ where: { email } }).catch(() => null)
    : null;

  if (user && user.email) {
    const code = generateCode();
    deletionCodes.set(user.email, { code, expiresAt: Date.now() + CODE_TTL_MS });
    try {
      await sendDeletionCodeEmail(user.email, code);
    } catch (err) {
      console.error("[delete-account] code email error:", err.message);
    }
  }

  if (user) {
    res.redirect(`/delete-account/confirm?email=${encodeURIComponent(user.email)}`);
  } else {
    res.send(
      layout(
        "Code sent",
        `<h1>Check your inbox</h1>
         <p>If an account exists for that email, a 6-digit confirmation code has been sent to it. The code expires in 10 minutes.</p>
         <p class="link"><a href="/delete-account">Back</a></p>`
      )
    );
  }
});

// GET /delete-account/confirm?email= — code entry page.
router.get("/confirm", (req, res) => {
  const email = (req.query?.email || "").trim().toLowerCase();
  if (!email) return res.redirect("/delete-account");
  res.send(confirmPage(email));
});

// POST /delete-account/confirm — verify the code and delete.
router.post("/confirm", codeConfirmLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const code = (req.body?.code || "").trim();

  const entry = deletionCodes.get(email);
  if (!entry || entry.code !== code || entry.expiresAt < Date.now()) {
    deletionCodes.delete(email);
    return res.status(200).send(confirmPage(email, "Invalid or expired code. Please request a new code."));
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    deletionCodes.delete(email);
    return res.status(200).send(confirmPage(email, "No account found for this email."));
  }

  deletionCodes.delete(email);
  try {
    await deleteUserData(prisma, user.id);
    res.send(
      resultPage(
        true,
        "Your account and all associated data have been permanently deleted."
      )
    );
  } catch (err) {
    console.error("[delete-account] deletion error:", err.message);
    res.status(200).send(confirmPage(email, "Deletion failed. Please try again later."));
  }
});

module.exports = router;
