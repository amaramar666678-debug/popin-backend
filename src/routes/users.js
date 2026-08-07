const express = require("express");
const router = express.Router();

const bcrypt = require("bcrypt");
const { prisma } = require("../middleware/prisma");
const { authenticateToken } = require("../middleware/auth");
const { formatUserResponse } = require("../helpers/user_response");

// POST /users (create user)
router.post("/", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name },
    });
    res.json({
      message: "User created successfully",
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users (list all)
router.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

// GET /users/lookup
router.get("/lookup", authenticateToken, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id query parameter is required" });
    const userId = isNaN(Number(id)) ? id : Number(id);
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

// POST /users/push-token - save or update FCM device token
router.post("/push-token", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, platform } = req.body;
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    await prisma.device.upsert({
      where: { userId_fcmToken: { userId, fcmToken: token } },
      update: { platform: platform || "android" },
      create: { userId, fcmToken: token, platform: platform || "android" },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /users/push-token - remove a device token
router.delete("/push-token", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    await prisma.device.deleteMany({
      where: { userId, fcmToken: token },
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
