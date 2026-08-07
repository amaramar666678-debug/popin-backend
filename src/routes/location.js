const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { prisma } = require("../middleware/prisma");
const { fuzzLocation } = require("../helpers/location_privacy");

// Minimum interval between accepted location updates per user. Prevents
// battery-draining continuous polling and abuse of the endpoint. The app only
// needs a rough "city/area" position, so a 10-minute cooldown is plenty.
const LOCATION_UPDATE_INTERVAL_MS = 10 * 60 * 1000;

// In-memory map of userId -> last accepted update timestamp.
const lastUpdateAt = new Map();

// POST /location — save the user's (fuzzed) current location.
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const now = Date.now();
    const last = lastUpdateAt.get(userId) || 0;
    if (now - last < LOCATION_UPDATE_INTERVAL_MS) {
      const retryInSeconds = Math.ceil((LOCATION_UPDATE_INTERVAL_MS - (now - last)) / 1000);
      return res.status(429).json({
        error: `Location update limit reached. Try again in ${retryInSeconds} seconds.`,
        retry_in_seconds: retryInSeconds,
      });
    }

    const { latitude, longitude, country_code } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude and longitude are required" });
    }

    // Never store precise coordinates — round to ~2 decimals (~1.1 km).
    const { latitude: fLat, longitude: fLng } = fuzzLocation(latitude, longitude);

    const data = {
      latitude: fLat,
      longitude: fLng,
    };
    if (country_code && typeof country_code === "string") {
      data.country_code = country_code.slice(0, 2).toUpperCase();
    }

    await prisma.user.update({
      where: { id: userId },
      data,
    });

    lastUpdateAt.set(userId, now);

    // Keep the map from growing unboundedly with stale entries.
    if (lastUpdateAt.size > 10000) {
      for (const [id, ts] of lastUpdateAt) {
        if (now - ts > LOCATION_UPDATE_INTERVAL_MS) lastUpdateAt.delete(id);
      }
    }

    res.json({
      message: "Location updated",
      latitude: fLat,
      longitude: fLng,
      fuzzed: true,
      next_update_in_seconds: Math.floor(LOCATION_UPDATE_INTERVAL_MS / 1000),
    });
  } catch (error) {
    console.error("Location update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
