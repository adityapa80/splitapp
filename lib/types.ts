export type SplitType = "equal" | "exact" | "percent" | "shares";

export interface Member {
  id: string;
  name: string;
  /** Optional; used to notify the member about expenses that involve them. */
  email?: string;
}

export interface Expense {
  id: string;
  description: string;
  /** Total in minor units (cents). */
  amount: number;
  paidBy: string;
  splitType: SplitType;
  /**
   * Per-member split input, keyed by member id. Meaning depends on splitType:
   * equal → 1 for each participant; exact → cents; percent → percentage; shares → weight.
   */
  splits: Record<string, number>;
  date: string; // YYYY-MM-DD
  createdAt: number;
}

export interface Settlement {
  id: string;
  from: string;
  to: string;
  amount: number; // cents
  date: string;
  createdAt: number;
}

export interface Group {
  id: string;
  name: string;
  currency: string;
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
  createdAt: number;
}
