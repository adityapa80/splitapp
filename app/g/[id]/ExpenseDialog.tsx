"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Expense, Group, SplitType } from "@/lib/types";
import { centsToInput, formatMoney, localToday, toCents } from "@/lib/money";
import { computeShares, notifyRecipients, validateSplit } from "@/lib/split";

export interface ExpenseInput {
  description: string;
  amount: number;
  paidBy: string;
  splitType: SplitType;
  splits: Record<string, number>;
  date: string;
}

interface Props {
  group: Group;
  emailEnabled: boolean;
  me: string;
  expense: Expense | null; // null = new expense
  onClose: () => void;
  onSave: (input: ExpenseInput) => Promise<string | null>;
  onDelete?: () => Promise<string | null>;
}

const TYPES: { id: SplitType; label: string }[] = [
  { id: "equal", label: "Equally" },
  { id: "exact", label: "Exact" },
  { id: "percent", label: "Percent" },
  { id: "shares", label: "Shares" },
];

const today = localToday;

function defaultValues(type: SplitType, memberIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  memberIds.forEach((id, i) => {
    if (type === "equal" || type === "shares") out[id] = "1";
    else if (type === "exact") out[id] = "";
    else {
      // Even percentages that still add up to exactly 100.
      const base = Math.floor((10000 / memberIds.length)) / 100;
      const last = Math.round((100 - base * (memberIds.length - 1)) * 100) / 100;
      out[id] = String(i === memberIds.length - 1 ? last : base);
    }
  });
  return out;
}

function parseValue(type: SplitType, raw: string): number {
  if (type === "equal") return raw === "1" ? 1 : 0;
  if (type === "exact") return raw.trim() === "" ? 0 : toCents(raw);
  const n = parseFloat(raw);
  return raw.trim() === "" ? 0 : n;
}

export default function ExpenseDialog({ group, emailEnabled, me, expense, onClose, onSave, onDelete }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const memberIds = group.members.map((m) => m.id);

  const [description, setDescription] = useState(expense?.description ?? "");
  const [amountStr, setAmountStr] = useState(expense ? centsToInput(expense.amount) : "");
  const [paidBy, setPaidBy] = useState(expense?.paidBy ?? group.members.find((m) => m.email === me)?.id ?? memberIds[0]);
  const [date, setDate] = useState(expense?.date ?? today());
  const [splitType, setSplitType] = useState<SplitType>(expense?.splitType ?? "equal");
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!expense) return defaultValues("equal", memberIds);
    const out: Record<string, string> = {};
    for (const id of memberIds) {
      const v = expense.splits[id] ?? 0;
      out[id] = expense.splitType === "equal" ? (v > 0 ? "1" : "0") : expense.splitType === "exact" ? (v ? centsToInput(v) : "") : v ? String(v) : "";
    }
    return out;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    // showModal() focuses the first focusable element (the close button), so move focus explicitly.
    ref.current?.querySelector<HTMLInputElement>("#desc")?.focus();
  }, []);

  const amount = toCents(amountStr);
  const splits = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of memberIds) out[id] = parseValue(splitType, values[id] ?? "");
    return out;
  }, [values, splitType, memberIds.join()]);

  const validAmount = Number.isFinite(amount) && amount > 0;
  const problem = validAmount ? validateSplit(amount, splitType, splits) : null;
  const shares = validAmount && !problem ? computeShares({ amount, splitType, splits }) : {};

  const sum = Object.values(splits).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  let remainingNote = "";
  if (splitType === "exact" && validAmount) {
    const left = amount - sum;
    remainingNote = left === 0 ? "Adds up ✓" : left > 0 ? `${formatMoney(left, group.currency)} left to assign` : `${formatMoney(-left, group.currency)} over the total`;
  } else if (splitType === "percent") {
    const left = Math.round((100 - sum) * 100) / 100;
    remainingNote = left === 0 ? "Adds up to 100% ✓" : left > 0 ? `${left}% left to assign` : `${-left}% over 100%`;
  }

  function changeType(t: SplitType) {
    setSplitType(t);
    setValues(defaultValues(t, memberIds));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return setError("Add a description.");
    if (!validAmount) return setError("Enter a valid amount.");
    if (problem) return setError(problem);
    setBusy(true);
    const err = await onSave({ description, amount, paidBy, splitType, splits, date });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  async function remove() {
    if (!onDelete || !confirm("Delete this expense?")) return;
    setBusy(true);
    const err = await onDelete();
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  const notified = emailEnabled && validAmount && !problem ? notifyRecipients(group, { amount, splitType, splits, paidBy }, me).map((m) => m.name) : [];

  const allSelected = splitType === "equal" && memberIds.every((id) => values[id] === "1");

  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="row between">
            <h2>{expense ? "Edit expense" : "Add an expense"}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>

          <div>
            <label htmlFor="desc">Description</label>
            <input id="desc" placeholder="Dinner, groceries, taxi…" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />
          </div>

          <div className="two-col">
            <div>
              <label htmlFor="amt">Amount ({group.currency})</label>
              <input id="amt" inputMode="decimal" placeholder="0.00" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
            </div>
            <div>
              <label htmlFor="date">Date</label>
              <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div>
            <label htmlFor="paid">Paid by</label>
            <select id="paid" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Split</label>
            <div className="seg" role="tablist">
              {TYPES.map((t) => (
                <button type="button" key={t.id} role="tab" aria-selected={splitType === t.id} className={splitType === t.id ? "on" : ""} onClick={() => changeType(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            {splitType === "equal" && (
              <label className="row" style={{ marginBottom: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setValues(Object.fromEntries(memberIds.map((id) => [id, e.target.checked ? "1" : "0"])))}
                />
                Everyone
              </label>
            )}
            {group.members.map((m) => (
              <div className="split-row" key={m.id}>
                {splitType === "equal" ? (
                  <label className="row" style={{ margin: 0, color: "var(--text)", fontWeight: 400, cursor: "pointer", gridColumn: "span 2" }}>
                    <input type="checkbox" checked={values[m.id] === "1"} onChange={(e) => setValues({ ...values, [m.id]: e.target.checked ? "1" : "0" })} />
                    {m.name}
                  </label>
                ) : (
                  <>
                    <span>{m.name}</span>
                    <input
                      aria-label={`${m.name} ${splitType}`}
                      inputMode="decimal"
                      placeholder={splitType === "exact" ? "0.00" : "0"}
                      value={values[m.id] ?? ""}
                      onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                    />
                  </>
                )}
                <span className="share">{shares[m.id] ? formatMoney(shares[m.id], group.currency) : "—"}</span>
              </div>
            ))}
            {remainingNote && <p className={`small ${remainingNote.includes("✓") ? "pos" : "muted"}`} style={{ margin: "6px 0 0" }}>{remainingNote}</p>}
          </div>

          {notified.length > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              ✉ {notified.join(", ")} will be emailed about this {expense ? "change" : "expense"}.
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="dialog-foot">
          <div>
            {onDelete && (
              <button type="button" className="btn danger ghost" onClick={remove} disabled={busy}>
                Delete
              </button>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
