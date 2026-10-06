import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, computeShares, computeBalances, simplifyDebts, validateSplit } from "./split.ts";

test("equal split distributes leftover cents", () => {
  assert.deepEqual(allocate(1000, [["a", 1], ["b", 1], ["c", 1]]), { a: 334, b: 333, c: 333 });
});

test("percent and shares", () => {
  assert.deepEqual(computeShares({ amount: 1000, splitType: "percent", splits: { a: 50, b: 25, c: 25 } }), { a: 500, b: 250, c: 250 });
  assert.deepEqual(computeShares({ amount: 900, splitType: "shares", splits: { a: 2, b: 1, c: 0 } }), { a: 600, b: 300 });
});

test("validation", () => {
  assert.equal(validateSplit(1000, "exact", { a: 600, b: 300 }), "Exact amounts must add up to the total.");
  assert.equal(validateSplit(1000, "percent", { a: 60, b: 40 }), null);
  assert.ok(validateSplit(1000, "equal", { a: 0 }));
});

test("balances and simplification", () => {
  const g = {
    id: "g", name: "", currency: "USD", createdAt: 0,
    members: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    expenses: [
      { id: "1", description: "", amount: 3000, paidBy: "a", splitType: "equal" as const, splits: { a: 1, b: 1, c: 1 }, date: "", createdAt: 0 },
      { id: "2", description: "", amount: 600, paidBy: "b", splitType: "equal" as const, splits: { b: 1, c: 1 }, date: "", createdAt: 0 },
    ],
    settlements: [{ id: "s", from: "c", to: "a", amount: 500, date: "", createdAt: 0 }],
  };
  const bal = computeBalances(g);
  assert.deepEqual(bal, { a: 1500, b: -700, c: -800 });
  assert.deepEqual(simplifyDebts(bal), [{ from: "c", to: "a", amount: 800 }, { from: "b", to: "a", amount: 700 }]);
});
