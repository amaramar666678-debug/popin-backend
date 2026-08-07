// Stealth/incognito presence settings, persisted to a small JSON file so no
// database schema change is required. When a user hides their online status:
//  - they are excluded from every `users:online` list pushed to other clients,
//  - their connection is not announced via `user:connected`,
//  - their `last_seen_at` is no longer touched, and their `last_active_at` is
//    masked in every API response built by formatUserResponse().
const fs = require("fs");
const path = require("path");

const statusFilePath = path.join(__dirname, "..", "..", "user_status.json");

// userId (int) -> { isVisible: bool, lastUpdated: ISO string }
const statuses = new Map();

function load() {
  try {
    if (!fs.existsSync(statusFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(statusFilePath, "utf8"));
    const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const entries =
      root.statuses && typeof root.statuses === "object" ? root.statuses : root;
    statuses.clear();
    for (const [key, val] of Object.entries(entries)) {
      const id = parseInt(key, 10);
      if (Number.isNaN(id) || !val || typeof val !== "object") continue;
      statuses.set(id, {
        isVisible: val.isVisible !== false,
        lastUpdated: val.lastUpdated || null,
      });
    }
  } catch (_) {
    // Ignore corrupt/missing files.
  }
}

function save() {
  try {
    const obj = {};
    for (const [id, s] of statuses.entries()) obj[String(id)] = s;
    fs.writeFileSync(statusFilePath, JSON.stringify({ statuses: obj }, null, 2), "utf8");
  } catch (_) {
    // Ignore write errors.
  }
}

function isVisible(userId) {
  const s = statuses.get(Number(userId));
  if (!s) return true; // Default: everyone is visible.
  return s.isVisible !== false;
}

function isHidden(userId) {
  return !isVisible(userId);
}

function setHidden(userId, hidden) {
  statuses.set(Number(userId), {
    isVisible: !hidden,
    lastUpdated: new Date().toISOString(),
  });
  save();
}

function getAll() {
  const obj = {};
  for (const [id, s] of statuses.entries()) obj[String(id)] = { ...s };
  return obj;
}

load();

module.exports = { isVisible, isHidden, setHidden, getAll };
