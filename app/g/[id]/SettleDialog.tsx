"use client";

import { useEffect, useRef, useState } from "react";
import type { Group } from "@/lib/types";
import { centsToInput, localToday, toCents } from "@/lib/money";

interface Props {
  group: Group;
  initial?: { from: string; to: string; amount: number };
  onClose: () => void;
  onSave: (from: string, to: string, amount: number, date: string) => Promise<string | null>;
}

export default function SettleDialog({ group, initial, onClose, onSave }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [from, setFrom] = useState(initial?.from ?? group.members[0].id);
  const [to, setTo] = useState(initial?.to ?? group.members[1]?.id ?? "");
  const [amountStr, setAmountStr] = useState(initial ? centsToInput(initial.amount) : "");
  const [date, setDate] = useState(localToday);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amount = toCents(amountStr);
    if (from === to) return setError("Choose two different people.");
    if (!Number.isFinite(amount) || amount <= 0) return setError("Enter a valid amount.");
    setBusy(true);
    const err = await onSave(from, to, amount, date);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  }

  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="row between">
            <h2>Record a payment</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="two-col">
            <div>
              <label htmlFor="from">Who paid</label>
              <select id="from" value={from} onChange={(e) => setFrom(e.target.value)}>
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="to">Paid to</label>
              <select id="to" value={to} onChange={(e) => setTo(e.target.value)}>
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="two-col">
            <div>
              <label htmlFor="samt">Amount ({group.currency})</label>
              <input id="samt" inputMode="decimal" placeholder="0.00" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
            </div>
            <div>
              <label htmlFor="sdate">Date</label>
              <input id="sdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="dialog-foot" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save payment"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
