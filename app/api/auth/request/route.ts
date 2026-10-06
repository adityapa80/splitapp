import { NextResponse } from "next/server";
import { clientIp, createLoginCode, rateLimit } from "@/lib/auth";
import { emailEnabled, parseEmail, sendLoginCode } from "@/lib/email";

const isProd = process.env.NODE_ENV === "production";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = parseEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });

  // Throttle both per address and per IP so the sign-in form can't be used to spam people.
  const allowed =
    (await rateLimit(`code:email:${email}`, 5, 60 * 60)) && (await rateLimit(`code:ip:${clientIp(req)}`, 20, 60 * 60));
  if (!allowed) return NextResponse.json({ error: "Too many codes requested. Try again in an hour." }, { status: 429 });

  const code = await createLoginCode(email);

  if (!emailEnabled) {
    if (isProd) return NextResponse.json({ error: "Email sign-in isn't configured on this server." }, { status: 503 });
    // Local development without Resend: hand the code back so you can still sign in.
    console.log(`[dev] Sign-in code for ${email}: ${code}`);
    return NextResponse.json({ ok: true, devCode: code });
  }

  try {
    await sendLoginCode(email, code);
  } catch (err) {
    console.error("Sign-in email failed:", err);
    return NextResponse.json({ error: "Couldn't send the email. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
