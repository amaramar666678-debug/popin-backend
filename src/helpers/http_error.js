// Centralized, safe error handling: never leak internal error details or stack
// traces to clients. Log the real error server-side, return a generic message.
function safeHttpError(res, error, context = "") {
  const prefix = context ? `[${context}]` : "[error]";
  console.error(`${prefix}`, error?.message || error);
  if (process.env.NODE_ENV === "development" && error?.message) {
    // In development we still return a generic body; full detail goes to logs.
    return res.status(500).json({ error: "Internal server error" });
  }
  return res.status(500).json({ error: "Internal server error" });
}

module.exports = { safeHttpError };
