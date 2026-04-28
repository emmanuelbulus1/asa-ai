/**
 * tests/decision.test.js
 * Run: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseFood, formatPrice } from "../services/decision.js";

describe("chooseFood()", () => {
  test("returns best vendor for shawarma within budget", () => {
    const result = chooseFood(["shawarma"], 20000);
    assert.equal(result.error, null, "Should find a result");
    assert.ok(result.best.price <= 20000, "Best vendor should be within budget");
    assert.ok(result.best.vendor, "Should return a vendor name");
  });

  test("returns over_budget when nothing fits", () => {
    const result = chooseFood(["pizza"], 500);
    assert.equal(result.error, "over_budget");
    assert.ok(result.cheapestAvailable > 500, "Cheapest should be above the budget");
  });

  test("returns not_found for unknown food items", () => {
    const result = chooseFood(["sushi", "takoyaki"], 100000);
    assert.equal(result.error, "not_found");
  });

  test("returns highest rated vendor when multiple match", () => {
    const result = chooseFood(["chicken"], 20000);
    assert.equal(result.error, null);
    // Best should have highest rating among matches
    const best = result.best;
    for (const option of result.options) {
      assert.ok(best.rating >= option.rating, "Best pick should have highest rating");
    }
  });

  test("handles empty items array gracefully", () => {
    const result = chooseFood([], 20000);
    assert.equal(result.error, "no_items");
  });

  test("handles null budget — returns matches without budget filter", () => {
    const result = chooseFood(["pizza"], null);
    assert.equal(result.error, null);
  });
});

describe("formatPrice()", () => {
  test("formats 18500 correctly", () => {
    assert.equal(formatPrice(18500), "₦18,500");
  });

  test("formats 1000000 correctly", () => {
    assert.equal(formatPrice(1000000), "₦1,000,000");
  });

  test("formats 0 correctly", () => {
    assert.equal(formatPrice(0), "₦0");
  });
});
         
