const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");

// POST /reels
router.post("/", authenticateToken, (req, res) => {
  res.json({
    id: "reel_" + Date.now(),
    url: "https://example.com/reel.mp4",
    message: "Reel uploaded",
  });
});

module.exports = router;
