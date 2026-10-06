import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocate, computeShares, computeBalances, simplifyDebts, validateSplit, notifyRecipients, type Transfer } from "./split.ts";
import type { Expense, Group, Settlement, SplitType } from "./types.ts";

// ---------- helpers ----------

let seq = 0;
function exp(paidBy: string, amount: number, splitType: SplitType, splits: Record<string, number>): Expense {
  return { id: `e${++seq}`, description: "x", amount, paidBy, splitType, splits, date: "2026-01-01", createdAt: seq };
}
function pay(from: string, to: string, amount: number): Settlement {
  return { id: `s${++seq}`, from, to, amount, date: "2026-01-01", createdAt: seq };
}
function group(ids: string[], expenses: Expense[] = [], settlements: Settlement[] = []): Group {
  return { id: "g", name: "G", currency: "USD", createdAt: 0, members: ids.map((id) => ({ id, name: id.toUpperCase(), email: `${id}@x.com` })), expenses, settlements };
}
const sum = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);

/** Apply transfers to balances; everyone should end at exactly 0. */
function settle(balances: Record<string, number>, transfers: Transfer[]) {
  const b = { ...balances };
  for (const t of transfers) {
    b[t.from] += t.amount;
    b[t.to] -= t.amount;
  }
  return b;
}

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// ---------- allocate ----------

describe("allocate (largest remainder rounding)", () => {
  test("$10 split 3 ways: one person absorbs the extra cent", () => {
    assert.deepEqual(allocate(1000, [["a", 1], ["b", 1], ["c", 1]]), { a: 334, b: 333, c: 333 });
  });
  test("1 cent split 3 ways", () => {
    assert.deepEqual(allocate(1, [["a", 1], ["b", 1], ["c", 1]]), { a: 1, b: 0, c: 0 });
  });
  test("2 cents split 3 ways", () => {
    assert.deepEqual(allocate(2, [["a", 1], ["b", 1], ["c", 1]]), { a: 1, b: 1, c: 0 });
  });
  test("extra cents go to the largest fractional parts, not just the first person", () => {
    // 100 cents by 1:2 → 33.33 / 66.67 → b has the bigger fraction and gets the extra cent
    assert.deepEqual(allocate(100, [["a", 1], ["b", 2]]), { a: 33, b: 67 });
  });
  test("single participant takes everything", () => {
    assert.deepEqual(allocate(12345, [["a", 7]]), { a: 12345 });
  });
  test("zero total weight returns nothing", () => {
    assert.deepEqual(allocate(100, []), {});
  });
  test("random totals and weights always sum exactly and are within 1 cent of the ideal", () => {
    const r = rng(42);
    for (let iter = 0; iter < 20000; iter++) {
      const n = 1 + Math.floor(r() * 12);
      const total = Math.floor(r() * 10_000_000) + 1;
      const weights: [string, number][] = Array.from({ length: n }, (_, i) => [`m${i}`, r() < 0.5 ? Math.floor(r() * 10) + 1 : Math.round(r() * 10000) / 100 + 0.01]);
      const out = allocate(total, weights);
      assert.equal(sum(out), total, `sum mismatch total=${total} weights=${JSON.stringify(weights)}`);
      const wsum = weights.reduce((s, [, w]) => s + w, 0);
      for (const [id, w] of weights) {
        assert.ok(out[id] >= 0, "negative share");
        assert.ok(Math.abs(out[id] - (total * w) / wsum) < 1 + 1e-9, `share too far from ideal for ${id}`);
      }
    }
  });
});

// ---------- computeShares per split type ----------

describe("computeShares", () => {
  test("equal: $90 between 3", () => {
    assert.deepEqual(computeShares(exp("a", 9000, "equal", { a: 1, b: 1, c: 1 })), { a: 3000, b: 3000, c: 3000 });
  });
  test("equal: payer not included (paid on behalf of others)", () => {
    assert.deepEqual(computeShares(exp("a", 5000, "equal", { b: 1, c: 1 })), { b: 2500, c: 2500 });
  });
  test("exact amounts are used as-is", () => {
    assert.deepEqual(computeShares(exp("a", 1000, "exact", { a: 100, b: 250, c: 650 })), { a: 100, b: 250, c: 650 });
  });
  test("percent: 50/30/20 of $123.45", () => {
    const s = computeShares(exp("a", 12345, "percent", { a: 50, b: 30, c: 20 }));
    assert.deepEqual(s, { a: 6173, b: 3703, c: 2469 }); // 6172.5 / 3703.5 / 2469 → +1 cent to a (tie → first)
    assert.equal(sum(s), 12345);
  });
  test("percent with decimals: 33.33/33.33/33.34", () => {
    const s = computeShares(exp("a", 10000, "percent", { a: 33.33, b: 33.33, c: 33.34 }));
    assert.deepEqual(s, { a: 3333, b: 3333, c: 3334 });
  });
  test("shares: 2:1:0 of $9 (zero-share person excluded)", () => {
    assert.deepEqual(computeShares(exp("a", 900, "shares", { a: 2, b: 1, c: 0 })), { a: 600, b: 300 });
  });
  test("shares with fractions: 1.5 : 1", () => {
    assert.deepEqual(computeShares(exp("a", 1000, "shares", { a: 1.5, b: 1 })), { a: 600, b: 400 });
  });
});

// ---------- validateSplit ----------

describe("validateSplit", () => {
  test("exact must match total to the cent", () => {
    assert.equal(validateSplit(1000, "exact", { a: 600, b: 400 }), null);
    assert.ok(validateSplit(1000, "exact", { a: 600, b: 399 }));
    assert.ok(validateSplit(1000, "exact", { a: 600, b: 401 }));
  });
  test("percent must total 100", () => {
    assert.equal(validateSplit(1000, "percent", { a: 33.33, b: 33.33, c: 33.34 }), null);
    assert.ok(validateSplit(1000, "percent", { a: 33.33, b: 33.33, c: 33.33 })); // 99.99
    assert.ok(validateSplit(1000, "percent", { a: 60, b: 50 })); // 110
  });
  test("needs at least one participant", () => {
    assert.ok(validateSplit(1000, "equal", { a: 0, b: 0 }));
    assert.ok(validateSplit(1000, "shares", {}));
  });
  test("rejects negative and non-finite values", () => {
    assert.ok(validateSplit(1000, "shares", { a: -1, b: 2 }));
    assert.ok(validateSplit(1000, "shares", { a: NaN }));
    assert.ok(validateSplit(1000, "shares", { a: Infinity }));
  });
});

// ---------- balances: classic Splitwise scenarios ----------

describe("computeBalances", () => {
  test("A pays $30 dinner for 3 → A +20, B −10, C −10", () => {
    const g = group(["a", "b", "c"], [exp("a", 3000, "equal", { a: 1, b: 1, c: 1 })]);
    assert.deepEqual(computeBalances(g), { a: 2000, b: -1000, c: -1000 });
  });
  test("two expenses by different payers net out", () => {
    // A pays 30 for all 3; B pays 30 for all 3 → A +10, B +10, C −20
    const g = group(["a", "b", "c"], [exp("a", 3000, "equal", { a: 1, b: 1, c: 1 }), exp("b", 3000, "equal", { a: 1, b: 1, c: 1 })]);
    assert.deepEqual(computeBalances(g), { a: 1000, b: 1000, c: -2000 });
  });
  test("settlement reduces the debt", () => {
    const g = group(["a", "b"], [exp("a", 1000, "equal", { a: 1, b: 1 })], [pay("b", "a", 300)]);
    assert.deepEqual(computeBalances(g), { a: 200, b: -200 });
  });
  test("full settlement zeroes everyone", () => {
    const g = group(["a", "b"], [exp("a", 1000, "equal", { a: 1, b: 1 })], [pay("b", "a", 500)]);
    assert.deepEqual(computeBalances(g), { a: 0, b: 0 });
  });
  test("overpayment flips who owes whom", () => {
    const g = group(["a", "b"], [exp("a", 1000, "equal", { a: 1, b: 1 })], [pay("b", "a", 800)]);
    assert.deepEqual(computeBalances(g), { a: -300, b: 300 });
  });
  test("member with no activity stays at 0", () => {
    const g = group(["a", "b", "z"], [exp("a", 1000, "equal", { a: 1, b: 1 })]);
    assert.equal(computeBalances(g).z, 0);
  });
  test("payer who isn't part of the split gets the whole amount back", () => {
    const g = group(["a", "b", "c"], [exp("a", 6000, "equal", { b: 1, c: 1 })]);
    assert.deepEqual(computeBalances(g), { a: 6000, b: -3000, c: -3000 });
  });
});

// ---------- simplifyDebts ----------

describe("simplifyDebts", () => {
  test("nothing to do when everyone is settled", () => {
    assert.deepEqual(simplifyDebts({ a: 0, b: 0 }), []);
  });
  test("chain A→B→C collapses into a single payment A→C", () => {
    // A owes B $10, B owes C $10 → balances A −10, B 0, C +10
    const g = group(["a", "b", "c"], [exp("b", 1000, "exact", { a: 1000 }), exp("c", 1000, "exact", { b: 1000 })]);
    assert.deepEqual(simplifyDebts(computeBalances(g)), [{ from: "a", to: "c", amount: 1000 }]);
  });
  test("circular debts cancel out entirely", () => {
    const g = group(["a", "b", "c"], [exp("a", 500, "exact", { b: 500 }), exp("b", 500, "exact", { c: 500 }), exp("c", 500, "exact", { a: 500 })]);
    assert.deepEqual(simplifyDebts(computeBalances(g)), []);
  });
  test("random groups: transfers settle everyone exactly, with at most n−1 payments", () => {
    const r = rng(7);
    const types: SplitType[] = ["equal", "exact", "percent", "shares"];
    for (let iter = 0; iter < 3000; iter++) {
      const n = 2 + Math.floor(r() * 9);
      const ids = Array.from({ length: n }, (_, i) => `m${i}`);
      const expenses: Expense[] = [];
      const settlements: Settlement[] = [];
      const count = Math.floor(r() * 25);
      for (let k = 0; k < count; k++) {
        const amount = 1 + Math.floor(r() * 500_000);
        const payer = ids[Math.floor(r() * n)];
        const type = types[Math.floor(r() * types.length)];
        const people = ids.filter(() => r() < 0.7);
        if (people.length === 0) people.push(ids[0]);
        const splits: Record<string, number> = {};
        if (type === "equal") people.forEach((p) => (splits[p] = 1));
        else if (type === "shares") people.forEach((p) => (splits[p] = 1 + Math.floor(r() * 5)));
        else if (type === "exact") {
          // random exact amounts that add up to the total
          let left = amount;
          people.forEach((p, i) => {
            const v = i === people.length - 1 ? left : Math.floor(r() * left);
            splits[p] = v;
            left -= v;
          });
        } else {
          // percentages with 2 decimals adding to exactly 100
          let left = 10000;
          people.forEach((p, i) => {
            const v = i === people.length - 1 ? left : Math.floor(r() * left);
            splits[p] = v / 100;
            left -= v;
          });
        }
        if (validateSplit(amount, type, splits)) continue;
        expenses.push(exp(payer, amount, type, splits));
        if (r() < 0.2) {
          const [f, t] = [ids[Math.floor(r() * n)], ids[Math.floor(r() * n)]];
          if (f !== t) settlements.push(pay(f, t, 1 + Math.floor(r() * 10000)));
        }
      }
      const g = group(ids, expenses, settlements);

      // Every expense's shares add up to its amount.
      for (const e of expenses) assert.equal(sum(computeShares(e)), e.amount, `shares ≠ amount for ${JSON.stringify(e)}`);

      // Money is conserved: balances always sum to zero.
      const bal = computeBalances(g);
      assert.equal(sum(bal), 0, "balances don't sum to zero");

      // Suggested payments settle everyone to exactly zero.
      const transfers = simplifyDebts(bal);
      const after = settle(bal, transfers);
      for (const id of ids) assert.equal(after[id], 0, `${id} not settled`);

      // Sane payments: positive, between different people, debtors pay creditors, at most n−1 of them.
      assert.ok(transfers.length <= Math.max(0, n - 1), `too many transfers: ${transfers.length} for ${n} people`);
      for (const t of transfers) {
        assert.ok(t.amount > 0 && Number.isInteger(t.amount));
        assert.notEqual(t.from, t.to);
        assert.ok(bal[t.from] < 0 && bal[t.to] > 0, "payment direction wrong");
      }
    }
  });
});

// ---------- notifyRecipients ----------

describe("notifyRecipients", () => {
  const g = group(["a", "b", "c", "d"]);
  delete g.members[3].email; // d has no email
  test("payer and participants with emails, minus whoever made the change", () => {
    const e = exp("a", 900, "equal", { a: 1, b: 1, d: 1 });
    assert.deepEqual(notifyRecipients(g, e, "b@x.com").map((m) => m.id), ["a"]);
    assert.deepEqual(notifyRecipients(g, e, "c@x.com").map((m) => m.id), ["a", "b"]);
  });
  test("payer not in split still notified", () => {
    const e = exp("c", 900, "equal", { a: 1, b: 1 });
    assert.deepEqual(notifyRecipients(g, e, "a@x.com").map((m) => m.id), ["b", "c"]);
  });
});
