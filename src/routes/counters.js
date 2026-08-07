const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { getCounters } = require("../services/counters");

// GET /counters â€” unread likes + unread messages for the current user
router.get("/", authenticateToken, async (req, res) => {
  try {
    res.json(await getCounters(req.user.id));
  } catch (error) {
    console.error("Counters error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
