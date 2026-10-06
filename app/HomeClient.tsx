"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CURRENCIES, formatMoney } from "@/lib/money";

export interface GroupSummary {
  id: string;
  name: string;
  currency: string;
  memberCount: number;
  myBalance: number;
}

type Person = { name: string; email: string };
const blank = (): Person => ({ name: "", email: "" });

export default function HomeClient({ me, groups }: { me: string; groups: GroupSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [members, setMembers] = useState([blank(), blank(), blank()]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const setMember = (i: number, patch: Partial<Person>) => {
    const next = [...members];
    next[i] = { ...next[i], ...patch };
    // Always keep one empty slot at the end for adding more people.
    if (i === next.length - 1 && next[i].name.trim()) next.push(blank());
    setMembers(next);
  };

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, currency, members: members.filter((m) => m.name.trim()) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      router.push(`/g/${data.group.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <section className="hero">
        <h1>{groups.length ? "Your groups" : "Split expenses without the awkwardness"}</h1>
        <p>{groups.length ? "Pick a group, or start a new one." : "Create a group, add your friends, and track who owes whom."}</p>
      </section>

      <div className="home-grid">
        {groups.length > 0 && (
          <div className="card">
            <ul className="list">
              {groups.map((g) => (
                <li key={g.id}>
                  <a href={`/g/${g.id}`} className="item" style={{ textDecoration: "none" }}>
                    <span className="grow">
                      <b>{g.name}</b>
                      <span className="member-email">{g.memberCount} people</span>
                    </span>
                    <span className={`small amount-col ${g.myBalance > 0 ? "pos" : g.myBalance < 0 ? "neg" : "muted"}`}>
                      {g.myBalance > 0 ? <>you get back<br /><b>{formatMoney(g.myBalance, g.currency)}</b></> : g.myBalance < 0 ? <>you owe<br /><b>{formatMoney(-g.myBalance, g.currency)}</b></> : "settled up"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form className="card stack" onSubmit={create}>
          <h2>Start a new group</h2>
          <div className="two-col" style={{ gridTemplateColumns: "1fr 110px" }}>
            <div>
              <label htmlFor="gname">Group name</label>
              <input id="gname" placeholder="Goa trip, Flat 4B…" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </div>
            <div>
              <label htmlFor="cur">Currency</label>
              <select id="cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label>People</label>
            <p className="muted small" style={{ margin: "0 0 8px" }}>
              Emails are optional. People with an email get notified when an expense involves them.
            </p>
            <div className="stack" style={{ gap: 8 }}>
              {members.map((m, i) => (
                <div className="person-row" key={i}>
                  <input
                    aria-label={`Person ${i + 1} name`}
                    placeholder={i === 0 ? "Your name" : `Person ${i + 1}`}
                    value={m.name}
                    onChange={(e) => setMember(i, { name: e.target.value })}
                    maxLength={40}
                  />
                  <input
                    aria-label={`Person ${i + 1} email`}
                    type="email"
                    placeholder="Email (optional)"
                    value={i === 0 ? me : m.email}
                    disabled={i === 0}
                    title={i === 0 ? "That's you" : undefined}
                    onChange={(e) => setMember(i, { email: e.target.value })}
                    maxLength={254}
                  />
                  {i > 0 && members.length > 2 && i < members.length - 1 && (
                    <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setMembers(members.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Creating…" : "Create group"}
          </button>
        </form>
      </div>
    </>
  );
}
