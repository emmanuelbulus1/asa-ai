export function validateIntent(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, reason: "parse_error" };
  }

  const validIntents = [
    "order_food", "cancel", "check_status",
    "greeting", "price_check", "food_advice", "unknown"
  ];

  if (!data.intent || !validIntents.includes(data.intent)) {
    return { valid: false, reason: "bad_intent" };
  }

  // order_food and price_check both carry items + budget
  if (data.intent === "order_food" || data.intent === "price_check") {
    return {
      valid: true,
      intent: data.intent,
      items: Array.isArray(data.items) ? data.items.filter(Boolean) : [],
      budget: typeof data.budget === "number" && data.budget > 0 ? data.budget : null,
      confirm: data.confirm === true,
      cancel: data.cancel === true
    };
  }

  // All other intents pass through clean
  return {
    valid: true,
    intent: data.intent,
    items: Array.isArray(data.items) ? data.items.filter(Boolean) : [],
    budget: typeof data.budget === "number" && data.budget > 0 ? data.budget : null,
    confirm: data.confirm === true,
    cancel: data.cancel === true
  };
}
