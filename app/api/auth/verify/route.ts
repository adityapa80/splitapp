import { NextResponse } from "next/server";
import { startSession, verifyLoginCode } from "@/lib/auth";
import { parseEmail } from "@/lib/email";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = parseEmail(body?.email);
  const code = String(body?.code ?? "").replace(/\s/g, "");
  if (!email || !/^\d{6}$/.test(code)) return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });

  const result = await verifyLoginCode(email, code);
  if (result === "expired") return NextResponse.json({ error: "That code has expired. Request a new one." }, { status: 400 });
  if (result === "invalid") return NextResponse.json({ error: "That code isn't right." }, { status: 400 });

  await startSession(email);
  return NextResponse.json({ ok: true });
}
