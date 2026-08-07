// Rebuild server-hosted image URLs using the current request's host, so photos
// uploaded from one device (e.g. an Android emulator storing 10.0.2.2) remain
// reachable from any other device that reaches this server.
const presenceSettings = require("../services/presence_settings");
const { locationForViewer } = require("./location_privacy");

function normalizeImageUrl(imageUrl, req) {
  if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
  try {
    const url = new URL(imageUrl);
    if (!url.pathname.startsWith("/uploads/")) return imageUrl;
    const base = `${req.protocol}://${req.get("host")}`;
    return `${base}${url.pathname}`;
  } catch (e) {
    return imageUrl;
  }
}

// options.includePrivateLocation: only the account owner should receive their
// own coordinates. Every other viewer gets null unless the account is
// verified, not banned, not hidden and visible on the map.
function formatUserResponse(user, req, options = {}) {
  const includePrivateLocation = options.includePrivateLocation === true;
  const images = (user.images || []).sort((a, b) => a.sortOrder - b.sortOrder);
  const primaryImage = images.find((img) => img.isPrimary);

  const toUrl = req ? (u) => normalizeImageUrl(u, req) : (u) => u;

  const ownLocation = {
    latitude: user.latitude ?? null,
    longitude: user.longitude ?? null,
  };
  const viewerLocation = includePrivateLocation
    ? ownLocation
    : locationForViewer(user);

  return {
    id: String(user.id),
    email: user.email,
    name: user.name || "",
    username: user.username || "",
    full_name: user.name || "",
    gender: user.gender || "other",
    date_of_birth: user.date_of_birth ? user.date_of_birth.toISOString() : null,
    bio: user.bio || "",
    country_code: user.country_code || "US",
    language: user.language || "en",
    latitude: viewerLocation.latitude,
    longitude: viewerLocation.longitude,
    profile_picture_url: primaryImage ? toUrl(primaryImage.imageUrl) : (images.length > 0 ? toUrl(images[0].imageUrl) : ""),
    images: images.map((img) => toUrl(img.imageUrl)),
    is_location_hidden: user.is_location_hidden || false,
    is_profile_complete: user.is_profile_complete || false,
    is_verified: user.is_verified || false,
    is_email_verified: user.is_email_verified || false,
    last_active_at: presenceSettings.isHidden(parseInt(user.id))
      ? null
      : (user.last_seen_at || user.updatedAt) ? (user.last_seen_at || user.updatedAt).toISOString() : null,
    looking_for: user.looking_for || "",
    children_count: user.children_count || 0,
    is_smoker: user.is_smoker ?? null,
    drinks_alcohol: user.drinks_alcohol ?? null,
    education_level: user.education_level ?? null,
    work_status: user.work_status ?? null,
    relationship_status: user.relationship_status ?? null,
    is_visible_on_map: user.is_visible_on_map !== false,
    boost_expires_at: user.boost_expires_at?.toISOString() ?? null,
    created_at: user.createdAt ? user.createdAt.toISOString() : null,
    hearts: user.hearts,
    message_credits: user.message_credits,
    eye_credits: user.eye_credits ?? 2,
    rewind_credits: user.rewind_credits ?? 0,
    heart_refill_at: user.heart_refill_at?.toISOString() ?? null,
    message_refill_at: user.message_refill_at?.toISOString() ?? null,
    eye_refill_at: user.eye_refill_at?.toISOString() ?? null,
    rewind_refill_at: user.rewind_refill_at?.toISOString() ?? null,
    chat_color: user.chat_color || null,
    chat_color_changed_at: user.chat_color_changed_at?.toISOString() ?? null,
    is_banned: user.is_banned === true && (!user.ban_expires_at || new Date(user.ban_expires_at).getTime() > Date.now()),
    ban_reason: user.is_banned === true && (!user.ban_expires_at || new Date(user.ban_expires_at).getTime() > Date.now())
      ? user.ban_reason || null
      : null,
    ban_expires_at: user.ban_expires_at && new Date(user.ban_expires_at).getTime() > Date.now()
      ? user.ban_expires_at.toISOString()
      : null,
    is_premium: user.is_premium || false,
    subscription_tier: user.subscription_tier ?? null,
    subscription_expires_at: user.subscription_expires_at?.toISOString() ?? null,
  };
}

module.exports = { formatUserResponse, normalizeImageUrl };
