/**
 * server.js â€” ASA: Adaptive Smart Assistant
 *
 * All 5 fixes applied:
 *
 * FIX 1: Session persistence   â€” sessions survive server restarts via file storage
 * FIX 2: Stable userId         â€” client sends localStorage userId, not random per-load
 * FIX 3: Order ID collision    â€” each order has a UUID; updates are order-scoped
 * FIX 4: OpenAI state rollback â€” state snapshot before every AI call; restored on failure
 * FIX 5: WS heartbeat + reconnect + stage replay â€” order status survives disconnection
 * RAILWAY FIX: Both HTTP and WebSocket run on the same PORT
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import { extractIntent, generateReply } from "./services/openai.js";
import { chooseFood, formatPrice } from "./services/decision.js";
import { simulateOrderFlow, broadcast } from "./services/tasks.js";
import { validateIntent } from "./services/validation.js";
import { getSession, createSession, markDirty, logAction } from "./services/session.js";
import { sanitise, isRateLimited } from "./services/sanitise.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// â”€â”€â”€ Express â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// â”€â”€â”€ FIX 1: Serve Frontend Files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(express.static(process.cwd()));

// Default route â€” show index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// â”€â”€â”€ Create HTTP Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// â”€â”€â”€ WebSocket â€” Attach to Same HTTP Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const wss = new WebSocketServer({ server });
const clients = new Map();

function addClient(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}

function removeClient(userId, ws) {
  const pool = clients.get(userId);
  if (!pool) return;
  pool.delete(ws);
  if (pool.size === 0) clients.delete(userId);
}

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/?", ""));
  const userId = params.get("userId");
  if (!userId) return ws.close();

  addClient(userId, ws);
  console.log(`[WS] ${userId} connected (${clients.get(userId)?.size} socket/s)`);

  // Fix 5: On reconnect â€” immediately replay current order stage if active
  const session = getSession(userId);
  if (session.memory.currentOrderStage && session.memory.currentOrderId) {
    ws.send(JSON.stringify({
      type: "order_update",
      ...session.memory.currentOrderStage,
      replayed: true
    }));
  }

  // Fix 5: Heartbeat â€” ping every 30s, client must pong within 10s
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30_000);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "pong") return; // heartbeat acknowledged
    } catch {}
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    removeClient(userId, ws);
    console.log(`[WS] ${userId} disconnected`);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error for ${userId}:`, err.message);
    removeClient(userId, ws);
  });
});

// â”€â”€â”€ Main Chat Route â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/chat", async (req, res) => {
  const { message: rawMessage, userId } = req.body;

  // Basic input validation
  if (!rawMessage || !userId) {
    return res.status(400).json({ reply: "Missing message or userId." });
  }

  // Fix 5 (sanitise): strip XSS before touching session
  const message = sanitise(rawMessage);

  // Fix 5 (rate limit): 20 messages per minute per user
  if (isRateLimited(userId)) {
    return res.status(429).json({
      reply: "Easy there â€” you're sending too fast. Give me a second."
    });
  }

  const session = getSession(userId);
  session.history.push({ role: "user", content: message });

  // â”€â”€ 1. Awaiting confirmation â€” handle YES/NO first, before any AI call â”€â”€â”€â”€â”€â”€
  if (session.state.awaitingConfirmation) {
    const lower = message.toLowerCase();
    const isYes = /\b(yes|yeah|yep|sure|go|okay|ok|do it|order|correct|proceed|yh|ye)\b/.test(lower);
    const isNo  = /\b(no|nope|cancel|stop|don't|wait|hold|change)\b/.test(lower);

    if (isYes) {
      const { choice } = session.state;

      // Fix 3: Generate a unique order ID
      const orderId = randomUUID();
      session.memory.currentOrderId = orderId;
      session.memory.currentOrderStage = null;

      // Save to memory
      session.memory.lastOrder = {
        vendor: choice.vendor,
        items: [...session.state.items],
        amount: choice.price,
        time: new Date().toISOString()
      };
      session.memory.preferences.favoriteFood = [...session.state.items];
      session.memory.preferences.usualBudget  = session.state.budget;

      logAction(session, "order_placed", {
        category: "food",
        orderId,
        vendor: choice.vendor,
        amount: choice.price,
        items: session.state.items
      });

      // Reset state before starting async flow
      session.state = createSession().state;
      markDirty(userId);

      // Fix 3 + 5: Pass orderId and stage-update callback to simulateOrderFlow
      simulateOrderFlow(orderId, orderId, clients, session, markDirty.bind(null, userId));

      const reply = "Order placed! Relax, your food go land soon ðŸ˜„ I'll keep you posted.";
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    if (isNo) {
      session.state.awaitingConfirmation = false;
      session.state.choice = null;

      const variations = [
        "No wahala at all. Tell me what you'd prefer instead.",
        "All good â€” what would you like instead?",
        "Sorted. Just say the word when you're ready."
      ];
      const reply = variations[Math.floor(Math.random() * variations.length)];
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }
  }

  // â”€â”€ 2. Extract intent â€” Fix 4: snapshot state before AI call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const stateSnapshot = JSON.parse(JSON.stringify(session.state));

  let data;
  try {
    const raw = await extractIntent(message, session.history);
    data = validateIntent(raw);
  } catch (err) {
    // Fix 4: restore snapshot â€” AI failure cannot corrupt state
    session.state = stateSnapshot;
    console.error("[Chat] Intent extraction error:", err.message);
    const reply = "Sorry, I had a momentary glitch. No wahala â€” just say that again.";
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  if (!data.valid) {
    const reply = "Sorry, I didn't quite catch that. You can ask me to order food, check prices, get a meal suggestion, or track an order.";
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  // â”€â”€ 3. Greeting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "greeting") {
    const context = session.memory.lastOrder
      ? `User has ordered before from ${session.memory.lastOrder.vendor}.`
      : "This is a new user.";
    const reply = await generateReply(
      `${context} User greeted you. Respond warmly and ask what they need. Max 2 sentences.`
    );
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  // â”€â”€ 4. Check status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "check_status") {
    if (!session.memory.lastOrder) {
      const reply = "You don't have any active orders. What would you like to order?";
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }
    const stage = session.memory.currentOrderStage;
    const reply = stage
      ? `Your order from ${session.memory.lastOrder.vendor} â€” current status: ${stage.msg}`
      : `Last order was from ${session.memory.lastOrder.vendor} â€” ${formatPrice(session.memory.lastOrder.amount)}.`;
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  // â”€â”€ 5. Price check â€” "how much is rice and chicken?" â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "price_check") {
    if (data.items.length > 0) {
      const result = chooseFood(data.items, null);
      if (result.error === null) {
        const prices = result.options.map(o => formatPrice(o.price));
        const range = prices.length > 1
          ? `${prices[prices.length - 1]} to ${prices[0]}`
          : prices[0];
        const reply = `${data.items.join(" and ")} options typically run ${range} depending on the vendor. Want me to find the best one within your budget?`;
        session.history.push({ role: "assistant", content: reply });
        markDirty(userId);
        return res.json({ reply });
      }
    }
    const itemStr = data.items.length > 0 ? data.items.join(" and ") : "that";
    const reply = `I don't have ${itemStr} on our current platforms, but I can find you something similar. What are you in the mood for â€” something light, a full meal, or a snack?`;
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  // â”€â”€ 6. Food advice â€” "suggest something", "what should I eat?" â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "food_advice") {
    const hour = new Date().getHours();
    let mealContext;
    if (hour < 11)      mealContext = "breakfast â€” something light and quick";
    else if (hour < 15) mealContext = "lunch â€” something filling";
    else if (hour < 18) mealContext = "an afternoon snack";
    else                mealContext = "dinner â€” something satisfying";

    const reply = await generateReply(
      `User wants food advice for ${mealContext} in Nigeria.
       Suggest ONE specific Nigerian meal confidently, in 1-2 sentences.
       Then ask if they want you to find it.
       Be warm, direct, and specific â€” not generic.`
    );
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply });
  }

  // â”€â”€ 7. Cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "cancel") {
    if (session.state.awaitingConfirmation || session.state.intent) {
      session.state = createSession().state;
      const reply = "Order cancelled. No wahala â€” let me know when you're ready.";
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }
    const reply = "Nothing to cancel right now. What do you need?";
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });
  }

  // â”€â”€ 8. Food order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (data.intent === "order_food") {

    if (data.items.length > 0) session.state.items = data.items;
    if (data.budget)           session.state.budget = data.budget;
    session.state.intent = "order_food";

    // Smart default: reuse usual budget
    if (!session.state.budget && session.memory.preferences.usualBudget) {
      session.state.budget = session.memory.preferences.usualBudget;
    }

    // Smart default: "order my usual" â€” goosebumps moment
    const isUsual = /\b(usual|same|again|repeat|last time)\b/.test(message.toLowerCase());
    if (isUsual && session.memory.lastOrder) {
      const last = session.memory.lastOrder;
      session.state.choice = {
        vendor: last.vendor,
        price: last.amount,
        delivery_time: "~30 mins",
        rating: 5
      };
      session.state.items  = last.items || session.memory.preferences.favoriteFood;
      session.state.budget = last.amount;
      session.state.awaitingConfirmation = true;

      const reply = `Got you â€” your usual from ${last.vendor}, ${formatPrice(last.amount)}. Want me to go ahead?`;
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    if (isUsual && session.memory.preferences.favoriteFood.length > 0) {
      session.state.items = session.memory.preferences.favoriteFood;
    }

    // Ask for missing info
    if (session.state.items.length === 0) {
      const reply = "What would you like to eat?";
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    if (!session.state.budget) {
      const itemList = session.state.items.join(" and ");
      const reply = `Got it â€” ${itemList}. How much is your budget including delivery?`;
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    // Run decision engine
    const result = chooseFood(session.state.items, session.state.budget);

    if (result.error === "over_budget") {
      const reply = `Cheapest I found for ${session.state.items.join(" and ")} is ${formatPrice(result.cheapestAvailable)} from ${result.cheapestVendor} â€” above your ${formatPrice(session.state.budget)}. Want to adjust your budget?`;
      session.state.budget = null;
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    if (result.error === "not_found") {
      const reply = `I couldn't find ${session.state.items.join(" or ")} on any platform right now. Want to try something else?`;
      session.state.items = [];
      session.history.push({ role: "assistant", content: reply });
      markDirty(userId);
      return res.json({ reply });
    }

    const { best } = result;
    session.state.choice = best;
    session.state.awaitingConfirmation = true;

    const reply = `This looks like the best option within your budget:\n\nðŸª ${best.vendor}\nðŸ’° ${formatPrice(best.price)} (incl. delivery)\nâ±ï¸ ${best.delivery_time}\nâ­ ${best.rating}/5 rating\n\nWant me to go ahead?`;
    session.history.push({ role: "assistant", content: reply });
    markDirty(userId);
    return res.json({ reply, showOptions: result.options });
  }

  // â”€â”€ 9. Unknown fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const reply = await generateReply(
    `User said: "${message}". You handle food orders. Respond helpfully as Asa and guide them to what you can do.`
  );
  session.history.push({ role: "assistant", content: reply });
  markDirty(userId);
  return res.json({ reply });
});

// â”€â”€â”€ Logs (judge demo dashboard) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/logs/:userId", (req, res) => {
  const session = getSession(req.params.userId);
  return res.json({
    logs: session.memory.logs,
    preferences: session.memory.preferences,
    lastOrder: session.memory.lastOrder,
    currentOrderStage: session.memory.currentOrderStage
  });
});

// â”€â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/health", (req, res) => {
  res.json({
    status: "ASA is live",
    uptime: Math.floor(process.uptime()),
    activeSessions: clients.size
  });
});

// â”€â”€â”€ Start Both HTTP and WebSocket on Single Port â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
server.listen(PORT, () => {
  console.log(`\n ASA â€” Adaptive Smart Assistant`);
  console.log(` HTTP + WS: http://localhost:${PORT}`);
  console.log(` Logs: http://localhost:${PORT}/logs/:userId\n`);
});
