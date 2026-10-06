/**
 * End-to-end test against a running dev server. It drives the real HTTP API the way the browser does.
 *
 *   1. Start the app with a fake email endpoint:
 *        RESEND_API_KEY=test RESEND_API_URL=http://localhost:4545/emails npx next dev -p 3000
 *      (no Redis env vars, so it uses fresh in-memory storage)
 *   2. npm run test:e2e
 *
 * The script runs its own fake email server on :4545 to capture sign-in codes and notifications.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { computeBalances, simplifyDebts } from "../lib/split.ts";
import type { Group } from "../lib/types.ts";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const run = Date.now().toString(36); // unique emails per run so rate limits don't carry over
const mail = (name: string) => `${name}.${run}@example.com`;

// ---------- fake email server ----------
type Sent = { to: string; subject: string; text: string; html: string };
const sent: Sent[] = [];
const mailServer = http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      sent.push({ to: b.to[0], subject: b.subject, text: b.text, html: b.html });
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"test"}');
    });
  })
  .listen(4545);

// ---------- tiny client with a cookie per user ----------
class Client {
  cookie = "";
  constructor(public email: string) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...(this.cookie && { Cookie: this.cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    const m = setCookie?.match(/split_session=([^;]*)/);
    if (m) this.cookie = m[1] ? `split_session=${m[1]}` : "";
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, location: res.headers.get("location") };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);

  async login() {
    const r = await this.post("/api/auth/request", { email: this.email });
    assert.equal(r.status, 200, `code request failed: ${r.text}`);
    const code = await waitForCode(this.email);
    const v = await this.post("/api/auth/verify", { email: this.email, code });
    assert.equal(v.status, 200, `verify failed: ${v.text}`);
    assert.ok(this.cookie, "no session cookie set");
  }
}

async function waitFor<T>(fn: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitForCode = (email: string) =>
  waitFor(() => [...sent].reverse().find((s) => s.to === email && /sign-in code/.test(s.subject))?.subject.slice(0, 6), `code for ${email}`);

// ---------- test runner ----------
let passed = 0;
const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n").join("\n      ")}`);
  }
}

async function main() {
  const asha = new Client(mail("asha"));
  const ben = new Client(mail("ben"));
  const chen = new Client(mail("chen"));
  const eve = new Client(mail("eve")); // outsider
  let gid = "";
  let g: Group;
  const id = (name: string) => g.members.find((m) => m.name === name)!.id;
  const refresh = async (c = asha) => {
    const r = await c.get(`/api/groups/${gid}`);
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
    return g;
  };
  const addExpense = (c: Client, expense: object) => c.patch(`/api/groups/${gid}`, { action: "addExpense", expense });
  const cents = (name: string) => computeBalances(g)[id(name)];

  console.log("\nAuth");
  await step("signed-out API calls are rejected (401)", async () => {
    assert.equal((await new Client("x").get("/api/groups")).status, 401);
    assert.equal((await new Client("x").patch("/api/groups/abc", { action: "renameGroup", name: "x" })).status, 401);
  });
  await step("signed-out pages redirect to /login (group link keeps ?next=)", async () => {
    const home = await new Client("x").get("/");
    assert.equal(home.status, 307);
    assert.match(home.location!, /\/login$/);
    const gp = await new Client("x").get("/g/abc123");
    assert.match(gp.location!, /\/login\?next=%2Fg%2Fabc123/);
  });
  await step("invalid email is rejected", async () => {
    assert.equal((await asha.post("/api/auth/request", { email: "not-an-email" })).status, 400);
  });
  await step("wrong code is rejected, right code signs in", async () => {
    await asha.post("/api/auth/request", { email: asha.email });
    const code = await waitForCode(asha.email);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await asha.post("/api/auth/verify", { email: asha.email, code: wrong });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /isn't right/);
    const ok = await asha.post("/api/auth/verify", { email: asha.email, code });
    assert.equal(ok.status, 200);
    assert.ok(asha.cookie);
  });
  await step("a used code can't be reused", async () => {
    const code = await waitForCode(asha.email);
    const again = await new Client(asha.email).post("/api/auth/verify", { email: asha.email, code });
    assert.equal(again.status, 400);
  });
  await step("5 wrong guesses kill the code (brute-force protection)", async () => {
    const c = new Client(mail("brute"));
    await c.post("/api/auth/request", { email: c.email });
    const code = await waitForCode(c.email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await c.post("/api/auth/verify", { email: c.email, code: wrong });
    const r = await c.post("/api/auth/verify", { email: c.email, code });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /expired/);
  });
  await step("code requests are rate limited per email (6th in an hour is refused)", async () => {
    const e = mail("spam");
    let last;
    for (let i = 0; i < 6; i++) last = await new Client(e).post("/api/auth/request", { email: e });
    assert.equal(last!.status, 429);
  });
  await step("login page won't redirect off-site (?next=//evil.com)", async () => {
    const r = await asha.get("/login?next=//evil.com");
    assert.equal(r.status, 307);
    assert.equal(new URL(r.location!, BASE).host, new URL(BASE).host);
  });
  await Promise.all([ben.login(), chen.login(), eve.login()]);

  console.log("\nCreating a group");
  await step("validation: name required, 2+ people, valid & unique emails, unique names", async () => {
    const base = { name: "Trip", currency: "USD" };
    assert.match((await asha.post("/api/groups", { ...base, name: " ", members: [{ name: "A" }, { name: "B" }] })).json.error, /name is required/);
    assert.match((await asha.post("/api/groups", { ...base, members: [{ name: "A" }] })).json.error, /at least two/);
    assert.match((await asha.post("/api/groups", { ...base, members: [{ name: "A" }, { name: "B", email: "bad" }] })).json.error, /valid email/);
    assert.match((await asha.post("/api/groups", { ...base, members: [{ name: "A" }, { name: "a" }] })).json.error, /listed twice/);
    assert.match((await asha.post("/api/groups", { ...base, members: [{ name: "A" }, { name: "B", email: ben.email }, { name: "C", email: ben.email }] })).json.error, /listed twice/);
  });
  await step("creator is always the first member with their own email (can't be spoofed)", async () => {
    const r = await asha.post("/api/groups", {
      name: "Goa trip",
      currency: "USD",
      members: [{ name: "Asha", email: "spoof@example.com" }, { name: "Ben", email: ben.email }, { name: "Chen", email: chen.email }, { name: "Dev" }],
    });
    assert.equal(r.status, 200, r.text);
    gid = r.json.group.id;
    g = r.json.group;
    assert.equal(g.members[0].email, asha.email);
    assert.equal(g.members[3].email, undefined);
    assert.equal(g.members.length, 4);
  });
  await step("every member with an email sees the group in their list; outsiders don't", async () => {
    for (const c of [asha, ben, chen]) {
      const r = await c.get("/api/groups");
      assert.ok(r.json.groups.some((x: Group) => x.id === gid), `${c.email} can't see it`);
    }
    assert.ok(!(await eve.get("/api/groups")).json.groups.some((x: Group) => x.id === gid));
  });

  console.log("\nAccess control");
  await step("outsider gets 404 on GET and PATCH (can't read, can't add themselves)", async () => {
    assert.equal((await eve.get(`/api/groups/${gid}`)).status, 404);
    const p = await eve.patch(`/api/groups/${gid}`, { action: "addMember", name: "Eve", email: eve.email });
    assert.equal(p.status, 404);
    await refresh();
    assert.ok(!g.members.some((m) => m.name === "Eve"));
  });
  await step("outsider opening the group page sees the no-access message", async () => {
    const r = await eve.get(`/g/${gid}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /have access to this group/);
    assert.ok(!r.text.includes("Goa trip"), "group name leaked to outsider");
  });

  console.log("\nExpenses and the Splitwise maths");
  await step("equal: Asha pays $90.00 for all 4 → $22.50 each", async () => {
    await refresh();
    const r = await addExpense(asha, { description: "Dinner", amount: 9000, paidBy: id("Asha"), splitType: "equal", splits: { [id("Asha")]: 1, [id("Ben")]: 1, [id("Chen")]: 1, [id("Dev")]: 1 }, date: "2026-10-01" });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
    assert.deepEqual([cents("Asha"), cents("Ben"), cents("Chen"), cents("Dev")], [6750, -2250, -2250, -2250]);
  });
  await step("exact: Ben pays $10.00 → Asha $3.00, Chen $7.00", async () => {
    const r = await addExpense(ben, { description: "Taxi", amount: 1000, paidBy: id("Ben"), splitType: "exact", splits: { [id("Asha")]: 300, [id("Chen")]: 700 }, date: "2026-10-02" });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
  });
  await step("percent: Chen pays $100.00 → 50% / 25% / 25%", async () => {
    const r = await addExpense(chen, { description: "Hotel", amount: 10000, paidBy: id("Chen"), splitType: "percent", splits: { [id("Asha")]: 50, [id("Ben")]: 25, [id("Chen")]: 25 }, date: "2026-10-03" });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
  });
  await step("shares: Dev pays $7.00 → 2 : 1 : 4 shares (Asha/Ben/Dev)", async () => {
    const r = await addExpense(asha, { description: "Snacks", amount: 700, paidBy: id("Dev"), splitType: "shares", splits: { [id("Asha")]: 2, [id("Ben")]: 1, [id("Dev")]: 4 }, date: "2026-10-04" });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
  });
  await step("balances match the hand calculation: Asha +12.50, Ben −38.50, Chen +45.50, Dev −19.50", async () => {
    await refresh(ben);
    assert.deepEqual([cents("Asha"), cents("Ben"), cents("Chen"), cents("Dev")], [1250, -3850, 4550, -1950]);
    const total = Object.values(computeBalances(g)).reduce((s, v) => s + v, 0);
    assert.equal(total, 0);
  });
  await step("suggested payments settle everyone (Ben→Chen 38.50, Dev→Chen 7.00, Dev→Asha 12.50)", async () => {
    const t = simplifyDebts(computeBalances(g)).map((x) => [g.members.find((m) => m.id === x.from)!.name, g.members.find((m) => m.id === x.to)!.name, x.amount]);
    assert.deepEqual(t, [["Ben", "Chen", 3850], ["Dev", "Chen", 700], ["Dev", "Asha", 1250]]);
  });
  await step("home page shows each person's balance in their group list", async () => {
    assert.match((await asha.get("/")).text, /you get back.*\$12\.50/s);
    assert.match((await ben.get("/")).text, /you owe.*\$38\.50/s);
  });
  await step("recording a payment: Ben pays Chen $38.50 → Ben settled up", async () => {
    const r = await ben.patch(`/api/groups/${gid}`, { action: "addSettlement", from: id("Ben"), to: id("Chen"), amount: 3850, date: "2026-10-05" });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
    assert.equal(cents("Ben"), 0);
    assert.equal(cents("Chen"), 700);
  });
  await step("editing an expense recalculates (Taxi becomes $5.00 / $5.00)", async () => {
    const taxi = g.expenses.find((e) => e.description === "Taxi")!;
    const r = await asha.patch(`/api/groups/${gid}`, { action: "updateExpense", expenseId: taxi.id, expense: { ...taxi, splits: { [id("Asha")]: 500, [id("Chen")]: 500 } } });
    assert.equal(r.status, 200, r.text);
    g = r.json.group;
    assert.equal(g.expenses.length, 4);
    // Asha's share went up by $2, Chen's down by $2
    assert.deepEqual([cents("Asha"), cents("Chen")], [1050, 900]);
  });
  await step("deleting an expense removes its effect (delete Snacks)", async () => {
    const snacks = g.expenses.find((e) => e.description === "Snacks")!;
    const r = await asha.patch(`/api/groups/${gid}`, { action: "deleteExpense", expenseId: snacks.id });
    g = r.json.group;
    assert.equal(g.expenses.length, 3);
    assert.deepEqual([cents("Asha"), cents("Ben"), cents("Chen"), cents("Dev")], [1250, 100, 900, -2250]);
  });
  await step("deleting a payment restores the debt", async () => {
    const r = await asha.patch(`/api/groups/${gid}`, { action: "deleteSettlement", settlementId: g.settlements[0].id });
    g = r.json.group;
    assert.equal(cents("Ben"), -3750);
  });
  await step("rounding: $10.00 split 3 ways stores shares that add up exactly", async () => {
    const before = computeBalances(g);
    const r = await addExpense(asha, { description: "Split 3", amount: 1000, paidBy: id("Asha"), splitType: "equal", splits: { [id("Asha")]: 1, [id("Ben")]: 1, [id("Chen")]: 1 } });
    g = r.json.group;
    const after = computeBalances(g);
    const deltas = ["Ben", "Chen"].map((n) => before[id(n)] - after[id(n)]).sort();
    assert.deepEqual(deltas, [333, 333]); // Asha absorbs the extra cent: 334
    assert.equal(after[id("Asha")] - before[id("Asha")], 1000 - 334);
  });

  console.log("\nExpense validation");
  const bad = async (expense: object, re: RegExp) => {
    const r = await addExpense(asha, expense);
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.match(r.json.error, re);
  };
  await step("rejects bad input", async () => {
    const base = { description: "X", amount: 1000, paidBy: id("Asha"), splitType: "equal", splits: { [id("Asha")]: 1 } };
    await bad({ ...base, description: "  " }, /Description/);
    await bad({ ...base, amount: 0 }, /greater than zero/);
    await bad({ ...base, amount: -500 }, /greater than zero/);
    await bad({ ...base, amount: 10.5 }, /greater than zero/); // must be whole cents
    await bad({ ...base, amount: 1e12 }, /too large/);
    await bad({ ...base, paidBy: "nobody" }, /who paid/);
    await bad({ ...base, splitType: "weird" }, /split type/);
    await bad({ ...base, splits: {} }, /at least one/);
    await bad({ ...base, splits: { nobody: 1 } }, /unknown member/);
    await bad({ ...base, splitType: "exact", splits: { [id("Asha")]: 600, [id("Ben")]: 300 } }, /add up to the total/);
    await bad({ ...base, splitType: "percent", splits: { [id("Asha")]: 60, [id("Ben")]: 30 } }, /100/);
    await bad({ ...base, splitType: "shares", splits: { [id("Asha")]: 1e300 } }, /too large/);
  });
  await step("invalid dates fall back to today instead of breaking the page", async () => {
    const r = await addExpense(asha, { description: "Bad date", amount: 100, paidBy: id("Asha"), splitType: "equal", splits: { [id("Asha")]: 1 }, date: "2026-13-45" });
    assert.equal(r.status, 200);
    const e = r.json.group.expenses.at(-1);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(e.date, "2026-13-45");
    await asha.patch(`/api/groups/${gid}`, { action: "deleteExpense", expenseId: e.id });
  });
  await step("payment validation: same person, zero, unknown member", async () => {
    for (const body of [
      { from: id("Ben"), to: id("Ben"), amount: 100 },
      { from: id("Ben"), to: id("Chen"), amount: 0 },
      { from: "nobody", to: id("Chen"), amount: 100 },
    ]) {
      const r = await asha.patch(`/api/groups/${gid}`, { action: "addSettlement", ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  console.log("\nEmail notifications");
  await step("new expense emails the payer and participants who have emails, not the person who added it", async () => {
    sent.length = 0;
    await refresh();
    await addExpense(ben, { description: "Boat ride", amount: 6000, paidBy: id("Asha"), splitType: "equal", splits: { [id("Ben")]: 1, [id("Chen")]: 1, [id("Dev")]: 1 } });
    await new Promise((r) => setTimeout(r, 1000));
    const boat = sent.filter((s) => s.subject.includes("Boat ride"));
    assert.deepEqual(boat.map((s) => s.to).sort(), [asha.email, chen.email].sort()); // not Ben (actor), not Dev (no email)
    const toAsha = boat.find((s) => s.to === asha.email)!;
    assert.match(toAsha.text, /Ben added "Boat ride"/);
    assert.match(toAsha.text, /You paid \$60\.00, so you get back \$60\.00/);
    const toChen = boat.find((s) => s.to === chen.email)!;
    assert.match(toChen.text, /Asha paid \$60\.00\. Your share is \$20\.00/);
    assert.match(toChen.text, new RegExp(`/g/${gid}`));
  });
  await step("editing an expense sends an 'updated' email", async () => {
    sent.length = 0;
    await refresh();
    const boat = g.expenses.find((e) => e.description === "Boat ride")!;
    await chen.patch(`/api/groups/${gid}`, { action: "updateExpense", expenseId: boat.id, expense: { ...boat, amount: 9000 } });
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(sent.map((s) => s.to).sort(), [asha.email, ben.email].sort());
    assert.ok(sent.every((s) => /Expense updated/.test(s.subject)));
    assert.match(sent.find((s) => s.to === ben.email)!.text, /Your share is \$30\.00/);
  });
  await step("HTML in names/descriptions is escaped in emails", async () => {
    sent.length = 0;
    await addExpense(ben, { description: "<script>x</script>", amount: 100, paidBy: id("Asha"), splitType: "equal", splits: { [id("Asha")]: 1 } });
    const e = await waitFor(() => sent.find((s) => s.to === asha.email), "email");
    assert.ok(!e.html.includes("<script>"));
    assert.ok(e.html.includes("&lt;script&gt;"));
  });

  console.log("\nMembers");
  await step("add person with email → they get access; duplicate name/email rejected", async () => {
    const r = await asha.patch(`/api/groups/${gid}`, { action: "addMember", name: "Eve", email: eve.email });
    assert.equal(r.status, 200, r.text);
    assert.equal((await eve.get(`/api/groups/${gid}`)).status, 200);
    assert.match((await asha.patch(`/api/groups/${gid}`, { action: "addMember", name: "eve" })).json.error, /already in the group/);
    assert.match((await asha.patch(`/api/groups/${gid}`, { action: "addMember", name: "Eve2", email: eve.email })).json.error, /already has that email/);
  });
  await step("removing someone's email revokes their access", async () => {
    await refresh();
    await asha.patch(`/api/groups/${gid}`, { action: "updateMember", memberId: id("Eve"), name: "Eve", email: "" });
    assert.equal((await eve.get(`/api/groups/${gid}`)).status, 404);
    assert.ok(!(await eve.get("/api/groups")).json.groups.some((x: Group) => x.id === gid));
  });
  await step("removing an unused person works; people in expenses can't be removed", async () => {
    await refresh();
    assert.equal((await asha.patch(`/api/groups/${gid}`, { action: "removeMember", memberId: id("Eve") })).status, 200);
    assert.match((await asha.patch(`/api/groups/${gid}`, { action: "removeMember", memberId: id("Dev") })).json.error, /part of an expense/);
  });
  await step("you can't remove yourself or change your own email", async () => {
    await refresh();
    assert.match((await asha.patch(`/api/groups/${gid}`, { action: "removeMember", memberId: id("Asha") })).json.error, /yourself/);
    assert.match((await asha.patch(`/api/groups/${gid}`, { action: "updateMember", memberId: id("Asha"), name: "Asha", email: "other@example.com" })).json.error, /own email/);
    // renaming yourself is fine
    assert.equal((await asha.patch(`/api/groups/${gid}`, { action: "updateMember", memberId: id("Asha"), name: "Asha K", email: asha.email })).status, 200);
  });

  console.log("\nConcurrency");
  await step("30 expenses added at the same moment by 3 people are all saved (no lost updates)", async () => {
    await refresh();
    const before = g.expenses.length;
    const payer = g.members[0].id;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        addExpense([asha, ben, chen][i % 3], { description: `Parallel ${i}`, amount: 100 + i, paidBy: payer, splitType: "equal", splits: { [payer]: 1 }, notify: false })
      )
    );
    await refresh();
    const added = g.expenses.filter((e) => e.description.startsWith("Parallel")).length;
    assert.equal(g.expenses.length - before, 30, `only ${added} of 30 saved`);
  });

  console.log("\nSign out");
  await step("after signing out, the old session no longer works", async () => {
    const old = asha.cookie;
    await asha.post("/api/auth/logout", {});
    const c = new Client("x");
    c.cookie = old;
    assert.equal((await c.get("/api/groups")).status, 401);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  mailServer.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  mailServer.close();
  process.exit(1);
});
