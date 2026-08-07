const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const presenceSettings = require("../services/presence_settings");
const { broadcastOnlineUsers } = require("../services/socket");

// GET /presence/visibility - current user's stealth setting
router.get("/visibility", authenticateToken, (req, res) => {
  res.json({ hidden: presenceSettings.isHidden(req.user.id) });
});

// PUT /presence/visibility - update stealth setting
router.put("/visibility", authenticateToken, (req, res) => {
  const hidden = req.body?.hidden === true;
  presenceSettings.setHidden(req.user.id, hidden);
  // Reflect the change for every connected client in real time.
  broadcastOnlineUsers();
  res.json({ hidden });
});

module.exports = router;
