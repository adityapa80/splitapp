import type { Expense, Group } from "./types";
import { computeShares, notifyRecipients } from "./split";
import { formatMoney } from "./money";
import { rateLimit } from "./auth";

/** Max notification emails one user can trigger per day. */
const DAILY_NOTIFY_LIMIT = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes an email; returns "" for blank, null for invalid. */
export function parseEmail(input: unknown): string | null {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

export const emailEnabled = Boolean(process.env.RESEND_API_KEY);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function send(to: string, subject: string, html: string, text: string) {
  const res = await fetch(process.env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "SplitApp <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/** Sends expense notifications. Failures are logged, never thrown. */
export async function notifyExpense(group: Group, expense: Expense, groupUrl: string, kind: "added" | "updated", actorEmail: string) {
  if (!emailEnabled) return;
  const shares = computeShares(expense);
  const cur = group.currency;
  const payer = group.members.find((m) => m.id === expense.paidBy)?.name ?? "Someone";
  const total = formatMoney(expense.amount, cur);

  const actor = group.members.find((m) => m.email === actorEmail)?.name ?? actorEmail;
  const recipients: typeof group.members = [];
  for (const m of notifyRecipients(group, expense, actorEmail)) {
    if (await rateLimit(`notify:${actorEmail}`, DAILY_NOTIFY_LIMIT, 86400)) recipients.push(m);
    else console.warn(`Daily email limit reached for ${actorEmail}; skipping notification.`);
  }
  const results = await Promise.allSettled(
    recipients.map((m) => {
      const share = shares[m.id] ?? 0;
      const isPayer = m.id === expense.paidBy;
      const line = isPayer
        ? `You paid ${total}${share ? ` and your share is ${formatMoney(share, cur)}` : ""}, so you get back ${formatMoney(expense.amount - share, cur)}.`
        : `${payer} paid ${total}. Your share is ${formatMoney(share, cur)}.`;
      const subject = `${kind === "added" ? "New expense" : "Expense updated"} in ${group.name}: ${expense.description}`;
      const text = `Hi ${m.name},\n\n${actor} ${kind} "${expense.description}" in ${group.name}.\n${line}\n\nView the group: ${groupUrl}\n`;
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#17201c">
          <p>Hi ${esc(m.name)},</p>
          <p>${esc(actor)} ${kind} <b>${esc(expense.description)}</b> in <b>${esc(group.name)}</b>.</p>
          <p style="font-size:16px">${esc(line)}</p>
          <p><a href="${esc(groupUrl)}" style="display:inline-block;background:#1aa57a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">View group</a></p>
          <p style="color:#64716b;font-size:12px">You're getting this because you're a member of ${esc(group.name)} on SplitApp.</p>
        </div>`;
      return send(m.email!, subject, html, text);
    })
  );
  for (const r of results) if (r.status === "rejected") console.error("Email failed:", r.reason);
}

export async function sendLoginCode(to: string, code: string) {
  const text = `Your SplitApp sign-in code is ${code}

It expires in 10 minutes. If you didn't request it, you can ignore this email.
`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#17201c">
      <p>Your SplitApp sign-in code is</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
      <p style="color:#64716b;font-size:13px">It expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    </div>`;
  await send(to, `${code} is your SplitApp sign-in code`, html, text);
}
