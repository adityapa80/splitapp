import { NextResponse, after } from "next/server";
import { getGroup, memberEmails, newId, saveGroup, storageMode, withLock } from "@/lib/store";
import { currentUser } from "@/lib/auth";
import { validateSplit } from "@/lib/split";
import { emailEnabled, notifyExpense, parseEmail } from "@/lib/email";
import type { Expense, Group, SplitType } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const SPLIT_TYPES: SplitType[] = ["equal", "exact", "percent", "shares"];
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (d: unknown): d is string =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z")) &&
  new Date(d + "T00:00:00Z").toISOString().startsWith(d);
const err = (error: string, status = 400) => NextResponse.json({ error }, { status });
const MAX_MEMBERS = 50;
const MAX_AMOUNT = 1e11; // cents
const MAX_WEIGHT = 1e6; // largest allowed percent/shares value

/** Loads the group if the signed-in user is one of its members. */
async function loadForUser(id: string): Promise<{ me: string; group: Group } | NextResponse> {
  const me = await currentUser();
  if (!me) return err("Please sign in.", 401);
  const group = await getGroup(id);
  // Same response for "missing" and "not yours" so group IDs can't be probed.
  if (!group || !memberEmails(group).has(me)) return err("Group not found, or you're not a member.", 404);
  return { me, group };
}

export async function GET(_req: Request, { params }: Ctx) {
  const loaded = await loadForUser((await params).id);
  if (loaded instanceof NextResponse) return loaded;
  return NextResponse.json({ group: loaded.group, me: loaded.me, storageMode, emailEnabled });
}

function parseExpense(group: Group, input: any): Omit<Expense, "id" | "createdAt"> | string {
  const description = String(input?.description ?? "").trim().slice(0, 120);
  const amount = Number(input?.amount);
  const paidBy = String(input?.paidBy ?? "");
  const splitType = input?.splitType as SplitType;
  const memberIds = new Set(group.members.map((m) => m.id));

  if (!description) return "Description is required.";
  if (!Number.isInteger(amount) || amount <= 0) return "Amount must be greater than zero.";
  if (amount > MAX_AMOUNT) return "Amount is too large.";
  if (!memberIds.has(paidBy)) return "Choose who paid.";
  if (!SPLIT_TYPES.includes(splitType)) return "Invalid split type.";

  const splits: Record<string, number> = {};
  for (const [id, v] of Object.entries(input?.splits ?? {})) {
    if (!memberIds.has(id)) return "Split includes an unknown member.";
    const n = Number(v);
    if (n > MAX_WEIGHT && splitType !== "exact") return "Split value is too large.";
    if (n > 0) splits[id] = splitType === "equal" ? 1 : splitType === "exact" ? Math.round(n) : n;
  }
  const problem = validateSplit(amount, splitType, splits);
  if (problem) return problem;

  return { description, amount, paidBy, splitType, splits, date: isDate(input?.date) ? input.date : today() };
}

function isReferenced(group: Group, memberId: string) {
  return (
    group.expenses.some((e) => e.paidBy === memberId || (e.splits[memberId] ?? 0) > 0) ||
    group.settlements.some((s) => s.from === memberId || s.to === memberId)
  );
}

export async function PATCH(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") return err("Missing action.");
  // Lock the group for the whole read-modify-write so simultaneous edits don't overwrite each other.
  const res = await withLock(`group:${id}`, () => applyChange(req, id, body));
  return res ?? err("The group is busy. Please try again.", 503);
}

async function applyChange(req: Request, id: string, body: any): Promise<NextResponse> {
  const loaded = await loadForUser(id);
  if (loaded instanceof NextResponse) return loaded;
  const { me, group } = loaded;
  const previousEmails = memberEmails(group);
  const emailTaken = (email: string, exceptId?: string) => group.members.some((m) => m.id !== exceptId && m.email === email);
  let notify: { expense: Expense; kind: "added" | "updated" } | null = null;

  switch (body.action) {
    case "renameGroup": {
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name) return err("Group name is required.");
      group.name = name;
      break;
    }
    case "addMember": {
      const name = String(body.name ?? "").trim().slice(0, 40);
      if (!name) return err("Name is required.");
      if (group.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) return err("That person is already in the group.");
      if (group.members.length >= MAX_MEMBERS) return err(`A group can have at most ${MAX_MEMBERS} people.`);
      const email = parseEmail(body.email);
      if (email === null) return err("That email doesn't look right.");
      if (email && emailTaken(email)) return err("Someone in the group already has that email.");
      group.members.push({ id: newId(8), name, ...(email && { email }) });
      break;
    }
    case "updateMember": {
      const member = group.members.find((m) => m.id === body.memberId);
      if (!member) return err("Person not found.", 404);
      const name = String(body.name ?? "").trim().slice(0, 40);
      if (!name) return err("Name is required.");
      if (group.members.some((m) => m.id !== member.id && m.name.toLowerCase() === name.toLowerCase()))
        return err("Someone else in the group already has that name.");
      const email = parseEmail(body.email);
      if (email === null) return err("That email doesn't look right.");
      if (email && emailTaken(email, member.id)) return err("Someone in the group already has that email.");
      if (member.email === me && email !== me) return err("You can't change your own email, or you'd lose access to the group.");
      member.name = name;
      if (email) member.email = email;
      else delete member.email;
      break;
    }
    case "removeMember": {
      if (group.members.find((m) => m.id === body.memberId)?.email === me) return err("You can't remove yourself.");
      if (isReferenced(group, body.memberId)) return err("Can't remove someone who is part of an expense or payment.");
      if (group.members.length <= 2) return err("A group needs at least two people.");
      group.members = group.members.filter((m) => m.id !== body.memberId);
      break;
    }
    case "addExpense": {
      const parsed = parseExpense(group, body.expense);
      if (typeof parsed === "string") return err(parsed);
      const expense = { ...parsed, id: newId(10), createdAt: Date.now() };
      group.expenses.push(expense);
      notify = { expense, kind: "added" };
      break;
    }
    case "updateExpense": {
      const idx = group.expenses.findIndex((e) => e.id === body.expenseId);
      if (idx < 0) return err("Expense not found.", 404);
      const parsed = parseExpense(group, body.expense);
      if (typeof parsed === "string") return err(parsed);
      group.expenses[idx] = { ...group.expenses[idx], ...parsed };
      notify = { expense: group.expenses[idx], kind: "updated" };
      break;
    }
    case "deleteExpense": {
      group.expenses = group.expenses.filter((e) => e.id !== body.expenseId);
      break;
    }
    case "addSettlement": {
      const amount = Number(body.amount);
      const ids = new Set(group.members.map((m) => m.id));
      if (!ids.has(body.from) || !ids.has(body.to) || body.from === body.to) return err("Choose two different people.");
      if (!Number.isInteger(amount) || amount <= 0) return err("Amount must be greater than zero.");
      if (amount > MAX_AMOUNT) return err("Amount is too large.");
      group.settlements.push({
        id: newId(10), from: body.from, to: body.to, amount,
        date: isDate(body.date) ? body.date : today(), createdAt: Date.now(),
      });
      break;
    }
    case "deleteSettlement": {
      group.settlements = group.settlements.filter((s) => s.id !== body.settlementId);
      break;
    }
    default:
      return err("Unknown action.");
  }

  await saveGroup(group, previousEmails);
  if (notify && body.notify !== false) {
    const { expense, kind } = notify;
    const base = process.env.APP_URL?.replace(/\/$/, "") || new URL(req.url).origin;
    // Runs after the response is sent, so emailing never slows down the UI.
    after(() => notifyExpense(group, expense, `${base}/g/${group.id}`, kind, me));
  }
  return NextResponse.json({ group, me, storageMode, emailEnabled });
}
