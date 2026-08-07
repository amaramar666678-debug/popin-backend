const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");

const uploadDir = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

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
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error("Only image files are allowed"));
  },
});

// POST /upload/profile-picture
router.post("/profile-picture", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const base = `${req.protocol}://${req.get("host")}`;
    const imageUrl = `${base}/uploads/${req.file.filename}`;

    // Save as a profile image record
    const image = await prisma.image.create({
      data: {
        userId: req.user.id,
        imageUrl,
        isPrimary: true,
        sortOrder: 0,
      },
    });

    // Update user profile_picture_url
    await prisma.user.update({
      where: { id: req.user.id },
      data: { is_profile_complete: true },
    });

    res.json({ url: imageUrl, image: { id: image.id, image_url: imageUrl, is_primary: true } });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /upload/chat-voice - upload a voice message audio clip
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".m4a";
    cb(null, `voice_${req.user.id}_${Date.now()}${ext}`);
  },
});

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".m4a", ".aac", ".mp3", ".ogg", ".opus", ".wav", ".webm", ".amr"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || (file.mimetype && file.mimetype.startsWith("audio/"))) {
      return cb(null, true);
    }
    cb(new Error("Only audio files are allowed"));
  },
});

router.post("/chat-voice", authenticateToken, uploadAudio.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const base = `${req.protocol}://${req.get("host")}`;
    const url = `${base}/uploads/${req.file.filename}`;
    res.json({ url, size: req.file.size });
  } catch (error) {
    console.error("Voice upload error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /upload/chat-image - upload a chat image before sending it as a message
router.post("/chat-image", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const base = `${req.protocol}://${req.get("host")}`;
    const url = `${base}/uploads/${req.file.filename}`;
    res.json({ url, size: req.file.size });
  } catch (error) {
    console.error("Chat image upload error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
