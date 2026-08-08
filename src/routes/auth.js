const express = require("express");
const router = express.Router();
 
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
 
const { prisma } = require("../middleware/prisma");
const { formatUserResponse } = require("../helpers/user_response");
const { countryCentroid } = require("../helpers/country_centroids");
const { authenticateToken } = require("../middleware/auth");
const {
  issueTokens,
  rotateRefreshToken,
  revokeRefreshToken,
} = require("../helpers/tokens");
const { safeHttpError } = require("../helpers/http_error");
const { sendVerificationEmailGmail } = require("../services/gmailService");
 
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
 
// ─────────────────────────────────────────────────────────────
// Verification code
// ─────────────────────────────────────────────────────────────
 
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
 
// ─────────────────────────────────────────────────────────────
// Firebase Admin
//
// Render Secret File:
// /etc/secrets/service-account.json
//
// Local development fallback:
// ../../service-account.json
//
// Optional environment variable:
// SERVICE_ACCOUNT_PATH
// ─────────────────────────────────────────────────────────────
 
let firebaseAdmin = null;
 
try {
  const admin = require("firebase-admin");
 
  const possiblePaths = [
    process.env.SERVICE_ACCOUNT_PATH,
    "/etc/secrets/service-account.json",
    path.join(__dirname, "../../service-account.json"),
  ].filter(Boolean);
 
  let saPath = null;
 
  for (const candidate of possiblePaths) {
    if (fs.existsSync(candidate)) {
      saPath = candidate;
      break;
    }
  }
 
  if (saPath) {
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(fs.readFileSync(saPath, "utf8"));
 
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
 
    firebaseAdmin = admin;
 
    console.log("[auth] Firebase Admin initialized using " + saPath);
  } else {
    console.warn("[auth] Firebase service account not found.");
 
    // Do not use fake Google authentication in production.
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[auth] Google authentication will be unavailable until the Firebase service account is configured."
      );
    }
  }
} catch (err) {
  console.error("[auth] Firebase Admin initialization failed:", err.message);
}
 
// ─────────────────────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────────────────────
 
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
 
    if (!email || !password) {
      return res.status(400).json({
        error: "email and password are required",
      });
    }
 
    const user = await prisma.user.findUnique({
      where: { email },
    });
 
    if (!user) {
      return res.status(401).json({
        error: "invalid email or password",
      });
    }
 
    const validPassword = await bcrypt.compare(password, user.password);
 
    if (!validPassword) {
      return res.status(401).json({
        error: "invalid email or password",
      });
    }
 
    const tokens = await issueTokens(user, {
      userAgent: req.headers["user-agent"],
    });
 
    res.json({
      message: "Login success",
      ...tokens,
      user: formatUserResponse(user, req, {
        includePrivateLocation: true,
      }),
    });
  } catch (error) {
    console.error("[auth/login]", error);
 
    res.status(500).json({
      error: "An unexpected error occurred. Please try again.",
    });
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────────────────────
 
router.post("/register", async (req, res) => {
  try {
    const {
      email,
      password,
      username,
      full_name,
      gender,
      country_code,
      date_of_birth,
    } = req.body;
 
    if (!email || !password) {
      return res.status(400).json({
        error: "email and password are required",
      });
    }
 
    const existing = await prisma.user.findUnique({
      where: { email },
    });
 
    if (existing) {
      return res.status(409).json({
        error: "email already registered",
      });
    }
 
    // Check username uniqueness
    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });
 
      if (existingUsername) {
        const clean = username
          .replace(/[^a-zA-Z0-9_]/g, "")
          .toLowerCase();
 
        const suggestions = [
          clean + Math.floor(100 + Math.random() * 900),
          clean + "_" + Math.floor(1 + Math.random() * 99),
          "the_" + clean,
        ];
 
        return res.status(409).json({
          error: "username already taken",
          suggestions,
        });
      }
    }
 
    const hashedPassword = await bcrypt.hash(password, 10);
 
    const centroid = countryCentroid(country_code);
 
    const { fuzzLocation } = require("../helpers/location_privacy");
 
    const seedLocation = centroid
      ? fuzzLocation(centroid.latitude, centroid.longitude)
      : null;
 
    const createData = {
      email,
      password: hashedPassword,
      name: full_name || username || "",
      username: username || null,
      country_code: country_code || "US",
      ...(seedLocation
        ? {
            latitude: seedLocation.latitude,
            longitude: seedLocation.longitude,
          }
        : {}),
    };
 
    if (gender) {
      createData.gender = gender;
    }
 
    if (date_of_birth) {
      const dobDate = new Date(date_of_birth);
 
      if (!isNaN(dobDate.getTime())) {
        createData.date_of_birth = dobDate;
      }
    }
 
    const user = await prisma.user.create({
      data: createData,
    });
 
    const tokens = await issueTokens(user, {
      userAgent: req.headers["user-agent"],
    });
 
    res.status(201).json({
      message: "Registration success",
      ...tokens,
      user: formatUserResponse(user, req, {
        includePrivateLocation: true,
      }),
    });
  } catch (error) {
    console.error("[auth/register]", error);
 
    res.status(500).json({
      error: "An unexpected error occurred. Please try again.",
    });
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/google
// ─────────────────────────────────────────────────────────────
 
router.post("/google", async (req, res) => {
  try {
    const { id_token } = req.body;
 
    if (!id_token) {
      return res.status(400).json({
        error: "id_token is required",
      });
    }
 
    // Firebase Admin is required in production.
    if (!firebaseAdmin) {
      console.error("[auth/google] Firebase Admin is not initialized");
 
      return res.status(503).json({
        error: "Google authentication is temporarily unavailable",
      });
    }
 
    let googleEmail = null;
    let googleName = null;
    let googlePicture = null;
 
    try {
      const decoded = await firebaseAdmin.auth().verifyIdToken(id_token);
 
      googleEmail = decoded.email || null;
      googleName = decoded.name || null;
      googlePicture = decoded.picture || null;
    } catch (verifyErr) {
      console.error(
        "[auth/google] Token verification failed:",
        verifyErr.message
      );
 
      return res.status(401).json({
        error: "Invalid Google token",
      });
    }
 
    if (!googleEmail) {
      return res.status(401).json({
        error: "Could not extract email from Google token",
      });
    }
 
    // Find existing user or create a new user
    let user = await prisma.user.findUnique({
      where: { email: googleEmail },
    });
 
    if (!user) {
      const createData = {
        email: googleEmail,
        password: "",
        name: googleName || googleEmail.split("@")[0],
        is_email_verified: true,
      };
 
      user = await prisma.user.create({
        data: createData,
      });
    }
 
    // Update profile picture from Google
    if (user && googlePicture && !user.profile_picture_url) {
      try {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            profile_picture_url: googlePicture,
          },
        });
      } catch (_) {}
    }
 
    const tokens = await issueTokens(user, {
      userAgent: req.headers["user-agent"],
    });
 
    res.json({
      message: "Google sign-in success",
      ...tokens,
      user: formatUserResponse(user, req, {
        includePrivateLocation: true,
      }),
    });
  } catch (error) {
    console.error("[auth/google]", error);
 
    safeHttpError(res, error, "auth/google");
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────────────────────
 
router.post("/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
 
    if (!refresh_token) {
      return res.status(400).json({
        error: "refresh_token is required",
      });
    }
 
    const {
      access_token,
      refresh_token: newRefresh,
      refresh_expires_at,
    } = await rotateRefreshToken(refresh_token, {
      userAgent: req.headers["user-agent"],
    });
 
    res.json({
      access_token,
      refresh_token: newRefresh,
      refresh_expires_at,
    });
  } catch (error) {
    console.error("[auth/refresh]", error);
 
    const status = error.status || 500;
 
    return res.status(status).json({
      error: status === 500 ? "Internal server error" : error.message,
    });
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────────────────────
 
router.post("/logout", async (req, res) => {
  try {
    const { refresh_token } = req.body;
 
    if (refresh_token) {
      await revokeRefreshToken(refresh_token);
    }
 
    res.json({
      message: "Logged out",
      ok: true,
    });
  } catch (error) {
    console.error("[auth/logout]", error);
 
    safeHttpError(res, error, "auth/logout");
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/logout-all
// ─────────────────────────────────────────────────────────────
 
router.post("/logout-all", authenticateToken, async (req, res) => {
  try {
    await revokeRefreshToken(null, {
      all: true,
      userId: req.user.id,
    });
 
    res.json({
      message: "All sessions revoked",
      ok: true,
    });
  } catch (error) {
    console.error("[auth/logout-all]", error);
 
    safeHttpError(res, error, "auth/logout-all");
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/send-verification
// ─────────────────────────────────────────────────────────────
 
router.post("/send-verification", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
 
    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }
 
    if (user.is_email_verified) {
      return res.status(400).json({
        error: "Email is already verified",
      });
    }
 
    const code = generateVerificationCode();
 
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email_verification_code: code,
        email_verification_code_expires_at: new Date(
          Date.now() + VERIFICATION_CODE_TTL_MS
        ),
      },
    });
 
    await sendVerificationEmailGmail(user.email, code);
 
    res.json({
      message: "Verification email sent",
      ok: true,
    });
  } catch (error) {
    console.error("[auth/send-verification]", error);
 
    safeHttpError(res, error, "auth/send-verification");
  }
});
 
// ─────────────────────────────────────────────────────────────
// POST /auth/verify-email
// ─────────────────────────────────────────────────────────────
 
router.post("/verify-email", authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
 
    if (!code) {
      return res.status(400).json({
        error: "Verification code is required",
      });
    }
 
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
 
    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }
 
    if (user.is_email_verified) {
      return res.json({
        message: "Email already verified",
        ok: true,
      });
    }
 
    if (
      !user.email_verification_code ||
      !user.email_verification_code_expires_at ||
      user.email_verification_code_expires_at.getTime() < Date.now()
    ) {
      return res.status(400).json({
        error: "Verification code expired. Request a new one.",
      });
    }
 
    if (user.email_verification_code !== code) {
      return res.status(400).json({
        error: "Invalid verification code",
      });
    }
 
    await prisma.user.update({
      where: { id: user.id },
      data: {
        is_email_verified: true,
        email_verification_code: null,
        email_verification_code_expires_at: null,
      },
    });
 
    res.json({
      message: "Email verified successfully",
      ok: true,
    });
  } catch (error) {
    console.error("[auth/verify-email]", error);
 
    safeHttpError(res, error, "auth/verify-email");
  }
});
 
module.exports = router;
 