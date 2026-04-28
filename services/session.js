/**
 * services/session.js
 *
 * FIX 1: Sessions persist to disk — survive server restarts and Railway redeploys.
 *         Uses a two-layer approach: fast in-memory cache + JSON file fallback.
 *
 * FIX 5 (partial): Stores currentOrderStage so reconnecting WebSocket clients
 *         can immediately receive the latest order status without missing updates.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, "../data/sessions");

// Ensure directory exists at startup
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── Session Shape ────────────────────────────────────────────────────────────

export function createSession() {
  return {
    history: [],
    state: {
      intent: null,
      items: [],
      budget: null,
      choice: null,
      currentOrderId: null,        // Fix 3: unique ID per order
      awaitingConfirmation: false
    },
    memory: {
      lastOrder: null,
      currentOrderStage: null,     // Fix 5: replayed on WS reconnect
      preferences: {
        favoriteFood: [],
        usualBudget: null,
        savedLocations: { home: null, office: null }
      },
      logs: []
    }
  };
}

// ─── Persistence Layer ────────────────────────────────────────────────────────

function sessionPath(userId) {
  // Sanitise userId before using as filename
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return join(SESSIONS_DIR, `${safe}.json`);
}

function loadFromDisk(userId) {
  try {
    const path = sessionPath(userId);
    if (!existsSync(path)) return createSession();
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    // Merge with createSession() to handle schema changes gracefully
    return deepMerge(createSession(), parsed);
  } catch {
    return createSession();
  }
}

function saveToDisk(userId, session) {
  try {
    // Never persist full OpenAI history to disk — too large, not needed
    const toPersist = {
      ...session,
      history: session.history.slice(-10) // keep last 10 only
    };
    writeFileSync(sessionPath(userId), JSON.stringify(toPersist, null, 2));
  } catch (err) {
    console.error(`[Session] Disk write failed for ${userId}:`, err.message);
  }
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

const cache = new Map();
const DIRTY = new Set(); // tracks sessions that need saving

// Debounced disk write — saves at most every 2s per session
const saveTimers = new Map();
function scheduleSave(userId) {
  if (saveTimers.has(userId)) clearTimeout(saveTimers.get(userId));
  saveTimers.set(userId, setTimeout(() => {
    if (DIRTY.has(userId)) {
      saveToDisk(userId, cache.get(userId));
      DIRTY.delete(userId);
    }
  }, 2000));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getSession(userId) {
  if (!cache.has(userId)) {
    cache.set(userId, loadFromDisk(userId));
  }
  return cache.get(userId);
}

export function markDirty(userId) {
  DIRTY.add(userId);
  scheduleSave(userId);
}

export function flushAll() {
  for (const [userId, session] of cache.entries()) {
    saveToDisk(userId, session);
  }
}

export function logAction(session, action, details = {}) {
  session.memory.logs.push({
    action,
    category: details.category || "general",
    ...details,
    time: new Date().toISOString()
  });
}

// ─── Graceful shutdown flush ──────────────────────────────────────────────────
process.on("SIGTERM", () => { flushAll(); process.exit(0); });
process.on("SIGINT",  () => { flushAll(); process.exit(0); });

// ─── Utility ──────────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      key in target &&
      typeof target[key] === "object"
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
  }
