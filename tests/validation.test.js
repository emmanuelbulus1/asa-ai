/**
 * tests/validation.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateIntent } from "../services/validation.js";

describe("validateIntent()", () => {
  test("accepts valid order_food intent", () => {
    const result = validateIntent({
      intent: "order_food",
      items: ["shawarma", "pizza"],
      budget: 20000,
      confirm: false,
      cancel: false
    });
    assert.equal(result.valid, true);
    assert.equal(result.intent, "order_food");
    assert.deepEqual(result.items, ["shawarma", "pizza"]);
    assert.equal(result.budget, 20000);
  });

  test("rejects null input", () => {
    const result = validateIntent(null);
    assert.equal(result.valid, false);
  });

  test("rejects missing intent", () => {
    const result = validateIntent({ items: ["shawarma"] });
    assert.equal(result.valid, false);
  });

  test("rejects unknown intent string", () => {
    const result = validateIntent({ intent: "buy_car", items: [], budget: null });
    assert.equal(result.valid, false);
  });

  test("coerces non-array items to empty array", () => {
    const result = validateIntent({
      intent: "order_food",
      items: "shawarma",  // wrong type
      budget: 20000,
      confirm: false,
      cancel: false
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.items, []);
  });

  test("coerces string budget to null", () => {
    const result = validateIntent({
      intent: "order_food",
      items: ["shawarma"],
      budget: "twenty thousand",  // wrong type
      confirm: false,
      cancel: false
    });
    assert.equal(result.valid, true);
    assert.equal(result.budget, null);
  });

  test("accepts greeting intent", () => {
    const result = validateIntent({ intent: "greeting", items: [], budget: null, confirm: false, cancel: false });
    assert.equal(result.valid, true);
    assert.equal(result.intent, "greeting");
  });

  test("detects confirm flag", () => {
    const result = validateIntent({
      intent: "order_food",
      items: [],
      budget: null,
      confirm: true,
      cancel: false
    });
    assert.equal(result.confirm, true);
  });
});

// ── New intent tests ──────────────────────────────────────────────────────────

test("accepts price_check intent with items", () => {
  const result = validateIntent({
    intent: "price_check",
    items: ["rice", "chicken"],
    budget: null,
    confirm: false,
    cancel: false
  });
  assert.equal(result.valid, true);
  assert.equal(result.intent, "price_check");
  assert.deepEqual(result.items, ["rice", "chicken"]);
});

test("accepts food_advice intent", () => {
  const result = validateIntent({
    intent: "food_advice",
    items: [],
    budget: null,
    confirm: false,
    cancel: false
  });
  assert.equal(result.valid, true);
  assert.equal(result.intent, "food_advice");
});
      
