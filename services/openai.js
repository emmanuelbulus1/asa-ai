/**
 * services/openai.js
 *
 * FIX 4: Every OpenAI call is wrapped with:
 *   - 10-second timeout (AbortController)
 *   - 1 automatic retry on network failure
 *   - Safe JSON parse with fallback — never throws into server.js
 *
 * The caller (server.js) snapshots state BEFORE calling extractIntent.
 * If this throws, server.js restores the snapshot. That two-layer approach
 * means a flaky OpenAI connection can never corrupt conversation state.
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Startup validation
if (!process.env.OPENAI_API_KEY) {
  console.error("\n❌ OPENAI_API_KEY is missing from your .env file.");
  console.error("   Copy .env.example to .env and add your key.\n");
  process.exit(1);
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json"
};

const INTENT_PROMPT = `
You are ASA (Adaptive Smart Assistant), a highly capable AI assistant built for Nigerian users and businesses.

YOUR PERSONALITY:
- Clear, confident, efficient — like a sharp human assistant
- Friendly but never chatty or wasteful
- Uses light Nigerian expressions naturally when they fit ("no wahala", "your food go land soon")
- Never overuses slang — only when natural
- Sounds like a trusted, experienced human assistant

EXTRACTION RULES:
Extract structured data from the user message. Return ONLY valid JSON — no explanation, no markdown:

{
  "intent": "order_food" | "price_check" | "food_advice" | "cancel" | "check_status" | "greeting" | "unknown",
  "items": ["item1", "item2"],
  "budget": number or null,
  "confirm": true | false,
  "cancel": true | false
}

INTENT RULES:
- order_food: user wants to ORDER / place an order for food
- price_check: user asks HOW MUCH something costs, or wants a price without ordering. e.g. "how much is rice and chicken?", "what will bread and Fanta cost me?"
- food_advice: user wants a SUGGESTION or RECOMMENDATION on what to eat. e.g. "advise me on what to eat", "what should I have?", "suggest something for lunch"
- cancel: user wants to cancel
- check_status: asking about order status / where's my food
- greeting: hello / hi / hey / good morning
- unknown: anything else

CRITICAL DISTINCTION:
- "I want to order rice" = order_food
- "How much is rice?" = price_check
- "What should I eat?" = food_advice

CONFIRMATION:
- confirm = true: yes, yeah, yep, sure, go ahead, do it, order it, correct, okay, proceed
- cancel = true: no, nope, cancel, stop, do not, wait, hold on, change

BUDGET: "20k" = 20000, "N20,000" = 20000, null if not mentioned
ITEMS: extract food names as clean array e.g. ["shawarma", "pizza"]

Return ONLY the JSON object. Nothing else.
`;

const REPLY_PROMPT = `
You are Asa, a sharp and trusted AI assistant for Nigerian users.
Keep replies SHORT — 1 to 2 sentences maximum.
Use light Nigerian expressions naturally when appropriate.
Sound like a real human assistant, never a robot.
`;

async function callOpenAI(messages, options = {}) {
  const {
    model = "gpt-4o-mini",
    temperature = 0.1,
    max_tokens = 200,
    retries = 1,
    timeoutMs = 10000
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await axios.post(
        OPENAI_URL,
        { model, messages, temperature, max_tokens },
        { headers: HEADERS, signal: controller.signal }
      );
      clearTimeout(timeout);
      return res.data.choices[0].message.content.trim();
    } catch (err) {
      clearTimeout(timeout);
      const isLast = attempt === retries;
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      console.warn(`[OpenAI] Retrying (attempt ${attempt + 1})...`);
    }
  }
}

export async function extractIntent(message, history = []) {
  try {
    const messages = [
      { role: "system", content: INTENT_PROMPT },
      ...history.slice(-6),
      { role: "user", content: message }
    ];
    const raw = await callOpenAI(messages, { temperature: 0.1, max_tokens: 200 });
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("[OpenAI] extractIntent failed:", err.message);
    return { intent: "unknown", items: [], budget: null, confirm: false, cancel: false };
  }
}

export async function generateReply(prompt) {
  try {
    const messages = [
      { role: "system", content: REPLY_PROMPT },
      { role: "user", content: prompt }
    ];
    return await callOpenAI(messages, { temperature: 0.7, max_tokens: 100 });
  } catch (err) {
    console.error("[OpenAI] generateReply failed:", err.message);
    return "No wahala, give me a moment and try again.";
  }
        }
