"use strict";

/**
 * Strict link filter for chat messages.
 *
 * Strategy:
 *  1. Normalize obfuscation — strip all whitespace and convert common tricks
 *     used to evade filters (e.g. "google dot com", "google[dot]com",
 *     "google (dot) com", "google . com").
 *  2. Detect any "name.tld" structure (with or without an explicit scheme),
 *     plus explicit URLs (http://localhost, ftp, ...) and raw IP addresses.
 *
 * Anything that looks like a link → the message is NOT safe.
 */

const TLD_LIST = [
  "com", "net", "org", "edu", "gov", "io", "co", "me", "biz", "info",
  "ly", "xyz", "club", "site", "online", "app", "dev", "ai", "tv", "cc",
  "us", "eu", "in", "tech", "link", "gg", "pro", "name", "top", "shop",
  "store", "live", "cloud", "wiki", "email", "download", "games", "asia",
  "cat", "cool", "date", "digital", "fun", "icu", "monster", "page",
  "press", "pub", "red", "run", "space", "studio", "today", "video",
  "vip", "kim", "science", "bid", "party", "work", "mom", "lol",
  "gdn", "sale", "win", "review", "stream",
  // Common country-code TLDs (frequent spam targets: mega.nz, co.uk, etc.).
  "uk", "nz", "au", "de", "fr", "jp", "cn", "ru", "br", "mx", "it",
  "es", "nl", "se", "pl", "ca", "ch", "at", "be", "dk", "fi", "no",
  "pt", "gr", "ie", "il", "hk", "sg", "kr", "za", "tr", "th", "id",
  "my", "ph", "tw", "vn", "ar", "cl", "hu", "ro", "cz", "sk", "ua",
  "ae", "sa", "eg", "ma", "ng", "ke", "pk", "bd", "lk", "uz", "kz",
].filter((value, index, array) => array.indexOf(value) === index);

const TLD_ALTERNATIVE = TLD_LIST.join("|");

// "name.tld" where name may be composed of letters/digits/hyphens, and
// there can be several sub-label groups (www.example.co.uk → .uk).
// NOTE: whitespace is stripped before testing, so word boundaries (\b) would
// break and are intentionally not used here.
const STRICT_LINK_REGEX = new RegExp(
  `(?:[a-z0-9][a-z0-9-]{0,62}\\.)+(?:${TLD_ALTERNATIVE})`
);

// Explicit URL schemes, even without a dotted TLD (http://localhost, ftp://ip).
const URL_SCHEME_REGEX = /(?:https?|ftp|file):\/\/[^\s/][^\s]*/i;

// Raw IPv4 addresses, which never contain a domain TLD.
const IP_REGEX = /(?:\d{1,3}\.){3}\d{1,3}\b/;

function isSafeMessage(text) {
  if (!text) return true;

  // 1. Strip whitespace and neutralize obfuscation tricks.
  const cleanText = text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\[dot\]/g, ".")
    .replace(/\(dot\)/g, ".")
    .replace(/\[\.\]/g, ".")
    .replace(/\(\.\)/g, ".")
    .replace(/dot/g, ".");

  // 2. A message is safe only if it contains no link-like structure at all.
  return !(
    STRICT_LINK_REGEX.test(cleanText) ||
    URL_SCHEME_REGEX.test(text) ||
    IP_REGEX.test(cleanText)
  );
}

// Strict check for profile fields (bio, name, ...). In addition to every
// structure caught by isSafeMessage, it also rejects bare link markers such as
// "http", "https", "ftp" or "www" even when no full URL is present.
function isSafeBio(text) {
  if (!text) return true;

  const lower = text.toLowerCase();

  // Bare protocol markers: http://, https://, ftp://, file:// or the words
  // "http", "https", "ftp", "file" when followed by ":". 
  if (/(https?|ftp|file):/i.test(lower)) return false;

  // The word "www" as a link marker (bare or followed by a dot).
  if (/\bwww\b/i.test(lower)) return false;

  return isSafeMessage(text);
}

module.exports = { isSafeMessage, isSafeBio };
