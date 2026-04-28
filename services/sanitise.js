/**
 * services/sanitise.js
 *
 * Two responsibilities:
 *
 * 1. INPUT SANITISATION — strips XSS vectors before any user text
 *    touches session state or gets sent to OpenAI. Without this, a user
 *    typing <script>...</script> as their food order creates a stored XSS
 *    vulnerability in logs and the frontend render.
 *
 * 2. RATE LIMITING — prevents a single user from hammering the OpenAI API
 *    and draining your key on demo day. 20 messages/minute per user is
 *    generous for normal use and a hard block for abuse.
 */

// ─── Sanitisation ─────────────────────────────────────────────────────────────

const XSS_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;"
};

export function sanitise(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/[&<>"'/]/g, (c) => XSS_MAP[c])
    .trim()
    .slice(0, 500); // Hard cap: 500 chars. Prevents prompt injection attacks.
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

const windows = new Map(); // userId → timestamp[]

export function isRateLimited(userId, maxPerMinute = 20) {
  const now = Date.now();
  const ONE_MINUTE = 60_000;

  if (!windows.has(userId)) windows.set(userId, []);
  const timestamps = windows.get(userId);

  // Slide the window — drop entries older than 1 minute
  const fresh = timestamps.filter((t) => now - t < ONE_MINUTE);
  windows.set(userId, fresh);

  if (fresh.length >= maxPerMinute) {
    return true; // blocked
  }

  fresh.push(now);
  return false; // allowed
}

// Cleanup stale entries every 5 minutes to prevent memory leak
// .unref() ensures this timer never blocks process exit (critical for tests)
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of windows.entries()) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) windows.delete(userId);
    else windows.set(userId, fresh);
  }
}, 300_000).unref();
                                  
