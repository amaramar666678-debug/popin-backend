const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");

// POST /ws/ticket
router.post("/ticket", authenticateToken, (req, res) => {
  const ticket = "ticket_" + req.user.id + "_" + Date.now();
  res.json({ ticket });
});

module.exports = router;
