"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Expense, Group, Settlement } from "@/lib/types";
import { computeBalances, computeShares, simplifyDebts, type Transfer } from "@/lib/split";
import { formatMoney } from "@/lib/money";
import ExpenseDialog, { type ExpenseInput } from "./ExpenseDialog";
import SettleDialog from "./SettleDialog";

const COLORS = ["#1aa57a", "#3b82f6", "#e0794a", "#a855f7", "#e11d74", "#0ea5b7", "#ca8a04", "#6366f1"];

function Avatar({ name, index }: { name: string; index: number }) {
  return (
    <span className="avatar" style={{ background: COLORS[index % COLORS.length] }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function DateBadge({ date }: { date: string }) {
  const d = new Date(date + "T00:00:00");
  return (
    <span className="date-badge">
      {d.toLocaleDateString(undefined, { month: "short" })}
      <b>{d.getDate()}</b>
    </span>
  );
}

type Activity = { kind: "expense"; item: Expense } | { kind: "settlement"; item: Settlement };

export default function GroupView({ id, me }: { id: string; me: string }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [storageMode, setStorageMode] = useState<string>("redis");
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [settling, setSettling] = useState<Transfer | "new" | null>(null);
  const [newMember, setNewMember] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [editMember, setEditMember] = useState<{ id: string; name: string; email: string } | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (background = false) => {
    try {
      const res = await fetch(`/api/groups/${id}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign(`/login?next=/g/${id}`);
      const data = await res.json();
      // 404 means the group is gone or you were removed from it, so always show that.
      if (!res.ok) {
        if (res.status === 404 || !background) setLoadError(data.error || "Could not load group.");
        return;
      }
      setGroup(data.group);
      setStorageMode(data.storageMode);
      setEmailEnabled(Boolean(data.emailEnabled));
    } catch {
      // A failed background refresh (e.g. briefly offline) shouldn't replace the page; the next one will retry.
      if (!background) setLoadError("Couldn't reach the server. Check your connection and reload.");
    }
  }, [id]);

  useEffect(() => {
    load();
    // Pick up changes made by other people in the group.
    const onFocus = () => document.visibilityState === "visible" && load(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = setInterval(onFocus, 20000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(timer);
    };
  }, [load]);

  async function act(body: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch(`/api/groups/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        window.location.assign(`/login?next=/g/${id}`);
        return "Your session expired. Please sign in again.";
      }
      const data = await res.json();
      if (!res.ok) return data.error || "Something went wrong.";
      setGroup(data.group);
      return null;
    } catch {
      return "Network error. Please try again.";
    }
  }

  const balances = useMemo(() => (group ? computeBalances(group) : {}), [group]);
  const transfers = useMemo(() => simplifyDebts(balances), [balances]);

  if (loadError) {
    return (
      <div className="card empty">
        <h2>{loadError}</h2>
        <p>
          <a href="/">Go home</a>
        </p>
      </div>
    );
  }
  if (!group) return <div className="empty">Loading…</div>;

  const cur = group.currency;
  const nameOf = (mid: string) => group.members.find((m) => m.id === mid)?.name ?? "Someone";
  const indexOf = (mid: string) => group.members.findIndex((m) => m.id === mid);
  const totalSpent = group.expenses.reduce((s, e) => s + e.amount, 0);

  const activity: Activity[] = [
    ...group.expenses.map((item) => ({ kind: "expense" as const, item })),
    ...group.settlements.map((item) => ({ kind: "settlement" as const, item })),
  ].sort((a, b) => b.item.date.localeCompare(a.item.date) || b.item.createdAt - a.item.createdAt);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this link:", window.location.href);
    }
  }

  async function rename() {
    const name = prompt("Group name", group!.name);
    if (name && name.trim() && name !== group!.name) {
      const err = await act({ action: "renameGroup", name });
      if (err) alert(err);
    }
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!newMember.trim()) return;
    const err = await act({ action: "addMember", name: newMember, email: newEmail });
    setMemberError(err ?? "");
    if (!err) {
      setNewMember("");
      setNewEmail("");
    }
  }

  async function saveMember(e: React.FormEvent) {
    e.preventDefault();
    if (!editMember) return;
    const err = await act({ action: "updateMember", memberId: editMember.id, name: editMember.name, email: editMember.email });
    setMemberError(err ?? "");
    if (!err) setEditMember(null);
  }

  async function removeMember(memberId: string) {
    if (!confirm(`Remove ${nameOf(memberId)} from the group?`)) return;
    setMemberError((await act({ action: "removeMember", memberId })) ?? "");
  }

  const saveExpense = (input: ExpenseInput) =>
    editing && editing !== "new"
      ? act({ action: "updateExpense", expenseId: editing.id, expense: input })
      : act({ action: "addExpense", expense: input });

  return (
    <>
      {storageMode === "memory" && (
        <div className="banner">
          Using temporary in-memory storage. Data will be lost when the server restarts. Connect Upstash Redis to keep it (see README).
        </div>
      )}

      <div className="group-head">
        <div>
          <h1>
            {group.name}{" "}
            <button className="icon-btn" onClick={rename} aria-label="Rename group" title="Rename">
              ✎
            </button>
          </h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {group.members.length} people · {formatMoney(totalSpent, cur)} total spent
          </p>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={copyLink}>
            {copied ? "Link copied ✓" : "Share link"}
          </button>
          <button className="btn" onClick={() => setSettling("new")}>
            Settle up
          </button>
          <button className="btn primary" onClick={() => setEditing("new")}>
            + Add expense
          </button>
        </div>
      </div>

      <div className="group-grid">
        <section className="card">
          <h2 style={{ marginBottom: 8 }}>Activity</h2>
          {activity.length === 0 ? (
            <div className="empty">
              <p>No expenses yet.</p>
              <button className="btn primary" onClick={() => setEditing("new")}>
                Add the first expense
              </button>
            </div>
          ) : (
            <ul className="list">
              {activity.map((a) =>
                a.kind === "expense" ? (
                  <li key={a.item.id}>
                    <button className="item" onClick={() => setEditing(a.item as Expense)}>
                      <DateBadge date={a.item.date} />
                      <div className="grow">
                        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(a.item as Expense).description}</div>
                        <div className="muted small">
                          {nameOf((a.item as Expense).paidBy)} paid · split {Object.keys(computeShares(a.item as Expense)).length} ways
                          {(a.item as Expense).splitType !== "equal" && ` (${(a.item as Expense).splitType})`}
                        </div>
                      </div>
                      <div className="amount-col" style={{ fontWeight: 600 }}>
                        {formatMoney(a.item.amount, cur)}
                      </div>
                    </button>
                  </li>
                ) : (
                  <li key={a.item.id}>
                    <div className="item" style={{ cursor: "default" }}>
                      <DateBadge date={a.item.date} />
                      <div className="grow">
                        <div>
                          <b>{nameOf((a.item as Settlement).from)}</b> paid <b>{nameOf((a.item as Settlement).to)}</b>
                        </div>
                        <span className="chip">payment</span>
                      </div>
                      <div className="amount-col pos" style={{ fontWeight: 600 }}>
                        {formatMoney(a.item.amount, cur)}
                      </div>
                      <button
                        className="icon-btn"
                        aria-label="Delete payment"
                        title="Delete payment"
                        onClick={async () => {
                          if (confirm("Delete this payment?")) {
                            const err = await act({ action: "deleteSettlement", settlementId: a.item.id });
                            if (err) alert(err);
                          }
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                )
              )}
            </ul>
          )}
        </section>

        <aside className="stack">
          <section className="card">
            <h2 style={{ marginBottom: 8 }}>Balances</h2>
            {group.members.map((m, i) => {
              const b = balances[m.id] ?? 0;
              return (
                <div className="balance-row" key={m.id}>
                  <Avatar name={m.name} index={i} />
                  <span className="grow">{m.name}</span>
                  <span className={`small ${b > 0 ? "pos" : b < 0 ? "neg" : "muted"}`} style={{ textAlign: "right" }}>
                    {b > 0 ? <>gets back <b>{formatMoney(b, cur)}</b></> : b < 0 ? <>owes <b>{formatMoney(-b, cur)}</b></> : "settled up"}
                  </span>
                </div>
              );
            })}
          </section>

          <section className="card">
            <h2 style={{ marginBottom: 8 }}>Suggested payments</h2>
            {transfers.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Everyone is settled up. 🎉
              </p>
            ) : (
              transfers.map((t) => (
                <div className="transfer" key={t.from + t.to}>
                  <Avatar name={nameOf(t.from)} index={indexOf(t.from)} />
                  <div className="grow small">
                    <b>{nameOf(t.from)}</b> pays <b>{nameOf(t.to)}</b>
                    <div className="neg" style={{ fontWeight: 600 }}>
                      {formatMoney(t.amount, cur)}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => setSettling(t)}>
                    Record
                  </button>
                </div>
              ))
            )}
          </section>

          <section className="card">
            <h2 style={{ marginBottom: 8 }}>People</h2>
            {group.members.map((m, i) =>
              editMember?.id === m.id ? (
                <form className="stack balance-row" style={{ gap: 8, alignItems: "stretch" }} key={m.id} onSubmit={saveMember}>
                  <input aria-label="Name" value={editMember.name} onChange={(e) => setEditMember({ ...editMember, name: e.target.value })} maxLength={40} autoFocus />
                  <input aria-label="Email" type="email" placeholder="Email (optional)" disabled={group.members.find((x) => x.id === editMember.id)?.email === me} value={editMember.email} onChange={(e) => setEditMember({ ...editMember, email: e.target.value })} maxLength={254} />
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button type="button" className="btn sm" onClick={() => setEditMember(null)}>
                      Cancel
                    </button>
                    <button className="btn sm primary">Save</button>
                  </div>
                </form>
              ) : (
                <div className="balance-row" key={m.id}>
                  <Avatar name={m.name} index={i} />
                  <span className="grow">
                    {m.name}
                    {m.email === me && <span className="muted small"> (you)</span>}
                    <span className="member-email">{m.email || "No email"}</span>
                  </span>
                  <button className="icon-btn" aria-label={`Edit ${m.name}`} title="Edit name or email" onClick={() => setEditMember({ id: m.id, name: m.name, email: m.email ?? "" })}>
                    ✎
                  </button>
                  {m.email !== me && (
                    <button className="icon-btn" aria-label={`Remove ${m.name}`} title="Remove" onClick={() => removeMember(m.id)}>
                      ✕
                    </button>
                  )}
                </div>
              )
            )}
            <form className="stack" style={{ marginTop: 10, gap: 8 }} onSubmit={addMember}>
              <input aria-label="New person's name" placeholder="Add a person" value={newMember} onChange={(e) => setNewMember(e.target.value)} maxLength={40} />
              <div className="row">
                <input aria-label="New person's email" type="email" placeholder="Email (optional)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} maxLength={254} />
                <button className="btn">Add</button>
              </div>
            </form>
            {!emailEnabled && group.members.some((m) => m.email) && (
              <p className="muted small" style={{ margin: "10px 0 0" }}>
                Email notifications aren&apos;t set up on this server yet (see README).
              </p>
            )}
            <p className="muted small" style={{ margin: "10px 0 0" }}>
              Only people whose email is listed here can open this group.
            </p>
            {memberError && <p className="error" style={{ marginTop: 8 }}>{memberError}</p>}
          </section>
        </aside>
      </div>

      {editing && (
        <ExpenseDialog
          key={editing === "new" ? "new" : editing.id}
          group={group}
          emailEnabled={emailEnabled}
          me={me}
          expense={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={saveExpense}
          onDelete={editing !== "new" ? () => act({ action: "deleteExpense", expenseId: editing.id }) : undefined}
        />
      )}
      {settling && (
        <SettleDialog
          group={group}
          initial={settling === "new" ? undefined : settling}
          onClose={() => setSettling(null)}
          onSave={(from, to, amount, date) => act({ action: "addSettlement", from, to, amount, date })}
        />
      )}
    </>
  );
}
