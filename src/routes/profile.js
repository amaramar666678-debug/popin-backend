const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { formatUserResponse, normalizeImageUrl } = require("../helpers/user_response");

const uploadDir = path.join(__dirname, "..", "..", "uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// GET /profile â€” get own full profile
router.get("/", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(formatUserResponse(user, req, { includePrivateLocation: true }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /profile â€” update profile fields
router.put("/", authenticateToken, async (req, res) => {
  try {
    const allowed = [
      "name", "username", "bio", "gender", "date_of_birth", "country_code",
      "language", "looking_for", "children_count",
      "is_smoker", "drinks_alcohol",       "education_level", "work_status", "relationship_status",
      "latitude", "longitude",
      "is_location_hidden", "is_visible_on_map",
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    // Never store precise coordinates — fuzz on write.
    if (data.latitude !== undefined || data.longitude !== undefined) {
      const { fuzzLocation } = require("../helpers/location_privacy");
      const fuzzed = fuzzLocation(
        data.latitude ?? 0,
        data.longitude ?? 0
      );
      data.latitude = fuzzed.latitude;
      data.longitude = fuzzed.longitude;
    }
    // Skip empty date_of_birth
    if (data.date_of_birth === "" || data.date_of_birth === null) {
      delete data.date_of_birth;
    } else if (typeof data.date_of_birth === "string") {
      data.date_of_birth = new Date(data.date_of_birth);
    }

    // Links are never allowed in the bio.
    if (data.bio !== undefined) {
      const { isSafeBio } = require("../helpers/link_filter");
      if (typeof data.bio !== "string" || !isSafeBio(data.bio)) {
        return res.status(422).json({
          error: "Links are not allowed in your bio.",
        });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { ...data, is_profile_complete: true },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });
    res.json(formatUserResponse(user, req, { includePrivateLocation: true }));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /profile/images
router.get("/images", authenticateToken, async (req, res) => {
  try {
    const images = await prisma.image.findMany({
      where: { userId: req.user.id },
      orderBy: { sortOrder: "asc" },
    });
    res.json({
      images: images.map((img) => ({
        id: img.id,
        image_url: normalizeImageUrl(img.imageUrl, req),
        is_primary: img.isPrimary,
        sort_order: img.sortOrder,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /profile/images â€” upload a new image
router.post("/images", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    const count = await prisma.image.count({ where: { userId: req.user.id } });
    if (count >= 6) return res.status(400).json({ error: "Maximum 6 images" });

    let imageUrl = req.body?.url;
    if (!imageUrl && req.file) {
      const base = `${req.protocol}://${req.get("host")}`;
      imageUrl = `${base}/uploads/${req.file.filename}`;
    }
    if (!imageUrl) return res.status(400).json({ error: "No file or url provided" });

    const image = await prisma.image.create({
      data: {
        userId: req.user.id,
        imageUrl,
        isPrimary: count === 0,
        sortOrder: count,
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { is_profile_complete: true },
    });

    res.json({
      image: { id: image.id, image_url: image.imageUrl, is_primary: image.isPrimary, sort_order: image.sortOrder },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /profile/images/:id/primary
router.put("/images/:id/primary", authenticateToken, async (req, res) => {
  try {
    await prisma.image.updateMany({
      where: { userId: req.user.id },
      data: { isPrimary: false },
    });
    await prisma.image.update({
      where: { id: parseInt(req.params.id) },
      data: { isPrimary: true },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /profile/images/reorder
router.put("/images/reorder", authenticateToken, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
    for (let i = 0; i < order.length; i++) {
      await prisma.image.update({
        where: { id: parseInt(order[i]) },
        data: { sortOrder: i },
      });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /profile/images/:id
router.delete("/images/:id", authenticateToken, async (req, res) => {
  try {
    const img = await prisma.image.findFirst({
      where: { id: parseInt(req.params.id), userId: req.user.id },
    });
    if (!img) return res.status(404).json({ error: "Image not found" });

    const filePath = path.join(uploadDir, path.basename(img.imageUrl));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await prisma.image.delete({ where: { id: img.id } });

    // If deleted image was primary, assign next as primary
    if (img.isPrimary) {
      const next = await prisma.image.findFirst({
        where: { userId: req.user.id },
        orderBy: { sortOrder: "asc" },
      });
      if (next) {
        await prisma.image.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /profile/delete — permanently delete the account and all related data.
// Security step: password accounts must supply the correct password; Google
// (passwordless) accounts must type their email address as confirmation.
router.post("/delete", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password, confirm_email } = req.body || {};

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.password) {
      const valid = await bcrypt.compare(password || "", user.password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid password" });
      }
    } else if (
      (confirm_email || "").trim().toLowerCase() !== user.email.trim().toLowerCase()
    ) {
      return res
        .status(401)
        .json({ error: "Email confirmation does not match the account email" });
    }

    const { deleteUserData } = require("../services/accountDeletion");
    await deleteUserData(prisma, userId);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /profile/:id â€” get another user's full profile
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.status(400).json({ error: "Invalid user ID" });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { images: { orderBy: { sortOrder: "asc" } } },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(formatUserResponse(user, req));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /profile/chat-color â€” update chat bubble color
router.put("/chat-color", authenticateToken, async (req, res) => {
  try {
    const { color } = req.body;
    if (!color || typeof color !== "string") {
      return res.status(400).json({ error: "color is required" });
    }
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { chat_color: color, chat_color_changed_at: new Date() },
    });

    const io = require("../services/socket").getIO();
    if (io) {
      io.emit("chat:color_changed", {
        user_id: user.id,
        color: color,
        timestamp: new Date().toISOString(),
        username: user.name || user.username || "Someone",
      });
    }

    res.json({ chat_color: color, chat_color_changed_at: user.chat_color_changed_at?.toISOString() ?? null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
