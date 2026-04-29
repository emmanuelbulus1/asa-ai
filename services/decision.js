import { readFileSync } from "fs";
import path from "path";

// Load vendors with proper path handling
let vendors = [];

try {
  const vendorsPath = path.join(process.cwd(), "data", "mockVendors.json");
  console.log(`[Decision] Loading vendors from: ${vendorsPath}`);
  
  vendors = JSON.parse(readFileSync(vendorsPath, "utf-8"));
  console.log(`[Decision] Successfully loaded ${vendors.length} vendors`);
} catch (err) {
  console.error(`[Decision] ⚠️ Failed to load vendors:`, err.message);
  console.error(`[Decision] Using empty vendor list. App will still run but orders will fail.`);
  vendors = [];
}

export function chooseFood(requestedItems, budget) {
  if (!requestedItems || requestedItems.length === 0) {
    return { error: "no_items" };
  }

  // Find vendors that carry at least one requested item and fit the budget
  const matching = vendors.filter((v) => {
    const hasItem = requestedItems.some((item) =>
      v.items.some((vi) => vi.toLowerCase().includes(item.toLowerCase()))
    );
    const withinBudget = budget ? v.price <= budget : true;
    return hasItem && withinBudget;
  });

  if (matching.length === 0) {
    // Check if items exist but over budget
    const existsOverBudget = vendors.filter((v) =>
      requestedItems.some((item) =>
        v.items.some((vi) => vi.toLowerCase().includes(item.toLowerCase()))
      )
    );

    if (existsOverBudget.length > 0) {
      const cheapest = existsOverBudget.sort((a, b) => a.price - b.price)[0];
      return {
        error: "over_budget",
        cheapestAvailable: cheapest.price,
        cheapestVendor: cheapest.vendor
      };
    }

    return { error: "not_found" };
  }

  // Sort: prioritize rating, then price
  const sorted = matching.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    return a.price - b.price;
  });

  // Return top 3 options + best pick
  return {
    best: sorted[0],
    options: sorted.slice(0, 3),
    error: null
  };
}

export function formatPrice(amount) {
  return `₦${amount.toLocaleString("en-NG")}`;
}
