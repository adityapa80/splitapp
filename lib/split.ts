import type { Expense, Group, SplitType } from "./types";

/**
 * Divide `total` cents in proportion to `weights`, using the largest-remainder
 * method so the parts always sum exactly to `total`.
 */
export function allocate(total: number, weights: [string, number][]): Record<string, number> {
  const sum = weights.reduce((s, [, w]) => s + w, 0);
  const out: Record<string, number> = {};
  if (sum <= 0) return out;
  const parts = weights.map(([id, w], i) => {
    const exact = (total * w) / sum;
    const floor = Math.floor(exact);
    return { id, floor, frac: exact - floor, i };
  });
  let remaining = total - parts.reduce((s, p) => s + p.floor, 0);
  const byFrac = [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const p of byFrac) {
    if (remaining <= 0) break;
    p.floor += 1;
    remaining -= 1;
  }
  for (const p of parts) out[p.id] = p.floor;
  return out;
}

/** How many cents each member owes for this expense. */
export function computeShares(e: Pick<Expense, "amount" | "splitType" | "splits">): Record<string, number> {
  const entries = Object.entries(e.splits).filter(([, v]) => v > 0);
  if (e.splitType === "exact") return Object.fromEntries(entries);
  return allocate(e.amount, entries);
}

/** Returns an error message, or null if the split is valid. */
export function validateSplit(amount: number, splitType: SplitType, splits: Record<string, number>): string | null {
  const values = Object.values(splits);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return "Split values must be non-negative numbers.";
  const positive = values.filter((v) => v > 0);
  if (positive.length === 0) return "Choose at least one person to split with.";
  const sum = positive.reduce((s, v) => s + v, 0);
  if (splitType === "exact" && sum !== amount) return "Exact amounts must add up to the total.";
  if (splitType === "percent" && Math.abs(sum - 100) > 0.001) return "Percentages must add up to 100.";
  return null;
}

/** Net balance per member in cents: positive = is owed money, negative = owes money. */
export function computeBalances(group: Group): Record<string, number> {
  const net: Record<string, number> = {};
  for (const m of group.members) net[m.id] = 0;
  for (const e of group.expenses) {
    net[e.paidBy] = (net[e.paidBy] ?? 0) + e.amount;
    for (const [id, owed] of Object.entries(computeShares(e))) net[id] = (net[id] ?? 0) - owed;
  }
  for (const s of group.settlements) {
    net[s.from] = (net[s.from] ?? 0) + s.amount;
    net[s.to] = (net[s.to] ?? 0) - s.amount;
  }
  return net;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/** Minimal-ish set of payments that settles everyone up (greedy largest-first). */
export function simplifyDebts(balances: Record<string, number>): Transfer[] {
  const debtors = Object.entries(balances).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const creditors = Object.entries(balances).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  debtors.sort((a, b) => b.v - a.v);
  creditors.sort((a, b) => b.v - a.v);
  const out: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount: amt });
    debtors[i].v -= amt;
    creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return out;
}

/**
 * Who gets emailed about an expense: the payer and anyone who owes a share,
 * if they have an email, except the person who made the change.
 */
export function notifyRecipients(group: Group, expense: Pick<Expense, "amount" | "splitType" | "splits" | "paidBy">, actorEmail: string) {
  const shares = computeShares(expense);
  return group.members.filter((m) => m.email && m.email !== actorEmail && (shares[m.id] || m.id === expense.paidBy));
}
