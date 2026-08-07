// Location privacy helpers.
//
// A dating app must never expose a user's precise coordinates to other
// members. Every coordinate that leaves the server is fuzzed to ~2 decimal
// places (about 1.1 km), only the latest position is kept (no movement
// history), and precise coordinates are only ever returned to the account
// owner. Location is only revealed to other users for accounts that are
// verified, not banned, not hidden, and still visible on the map.

// Number of decimals used for storage. 2 decimals ≈ 1.1 km cell.
const FUZZ_DECIMALS = 2;

function roundCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** FUZZ_DECIMALS;
  return Math.round(n * factor) / factor;
}

// Returns a coordinate object rounded to FUZZ_DECIMALS, clamped to valid
// geographic bounds. Invalid input becomes 0 (never trust a client blindly).
function fuzzLocation(latitude, longitude) {
  const lat = roundCoordinate(latitude);
  const lng = roundCoordinate(longitude);
  return {
    latitude: Math.min(90, Math.max(-90, lat)),
    longitude: Math.min(180, Math.max(-180, lng)),
  };
}

// Is the ban active right now (is_banned true and no expired ban)?
function isActivelyBanned(user) {
  if (!user) return false;
  return user.is_banned === true &&
    (!user.ban_expires_at || new Date(user.ban_expires_at).getTime() > Date.now());
}

// May this account's location be shown to OTHER users?
// Requirements: verified (email and/or photo), not banned, not hidden,
// and still visible on the map.
function canRevealLocation(user) {
  if (!user) return false;
  if (isActivelyBanned(user)) return false;
  if (user.is_location_hidden === true) return false;
  if (user.is_visible_on_map === false) return false;
  if (user.is_email_verified !== true && user.is_verified !== true) return false;
  return user.latitude != null && user.longitude != null;
}

// Returns { latitude, longitude } ready to expose to other users, or
// { latitude: null, longitude: null } when the location must stay hidden.
function locationForViewer(user) {
  if (!canRevealLocation(user)) {
    return { latitude: null, longitude: null };
  }
  return { latitude: user.latitude, longitude: user.longitude };
}

module.exports = {
  FUZZ_DECIMALS,
  roundCoordinate,
  fuzzLocation,
  isActivelyBanned,
  canRevealLocation,
  locationForViewer,
};
