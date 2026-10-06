import { NextResponse } from "next/server";
import { listGroupsFor, newId, saveGroup, storageMode } from "@/lib/store";
import { currentUser, rateLimit } from "@/lib/auth";
import { emailEnabled, parseEmail } from "@/lib/email";
import type { Group, Member } from "@/lib/types";

const err = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function GET() {
  const me = await currentUser();
  if (!me) return err("Please sign in.", 401);
  return NextResponse.json({ groups: await listGroupsFor(me) });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return err("Please sign in.", 401);
  if (!(await rateLimit(`create:${me}`, 30, 86400))) return err("You've created a lot of groups today. Try again tomorrow.", 429);

  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 80);
  const currency = String(body?.currency ?? "USD").toUpperCase().slice(0, 3);
  const input: unknown[] = Array.isArray(body?.members) ? body.members : [];

  const members: Member[] = [];
  for (const [i, raw] of input.entries()) {
    const r = typeof raw === "string" ? { name: raw } : (raw as { name?: unknown; email?: unknown });
    const memberName = String(r?.name ?? "").trim().slice(0, 40);
    if (!memberName) continue;
    // The first person is always the signed-in creator.
    const email = i === 0 ? me : parseEmail(r?.email);
    if (email === null) return err(`"${r?.email}" isn't a valid email.`);
    if (members.some((m) => m.name.toLowerCase() === memberName.toLowerCase())) return err(`${memberName} is listed twice.`);
    if (email && members.some((m) => m.email === email)) return err(`${email} is listed twice.`);
    members.push({ id: newId(8), name: memberName, ...(email && { email }) });
  }

  if (!name) return err("Group name is required.");
  if (members[0]?.email !== me) return err("Enter your name first.");
  if (members.length < 2) return err("Add at least two people.");

  const group: Group = {
    id: newId(14),
    name,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    members,
    expenses: [],
    settlements: [],
    createdAt: Date.now(),
  };
  await saveGroup(group);
  return NextResponse.json({ group, storageMode, emailEnabled });
}
