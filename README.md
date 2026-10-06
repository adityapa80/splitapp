# SplitApp

A lightweight Splitwise-style app for splitting group expenses. Sign in with your email, create a group, add your friends by email, and track who owes whom.

## Features

- Passwordless sign-in: enter your email and type in the 6-digit code you receive
- Private groups: only people whose email is on the member list can open a group
- Groups with any number of people, in your chosen currency
- Optional email for each person: they get an email whenever an expense involving them is added or edited
- Expenses split **equally**, by **exact amounts**, by **percentages**, or by **shares**
- Live per-person preview while you enter a split, rounded to the cent so totals always match
- Balances for every member, plus a simplified "who pays whom" list that needs the fewest payments
- Record settle-up payments (one tap from a suggestion)
- Edit or delete expenses, add or remove people, rename the group
- Recently opened groups are remembered in your browser
- Works on phones and in light or dark mode

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Without Redis configured, data is kept in memory and is lost when the dev server restarts. If no email service is set up, the sign-in code appears on the login page (local development only).

Run the split-math tests with `npm test`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, go to **Add New → Project** and import the repo. The framework preset is detected as Next.js.
3. In the project, open **Storage** (or **Integrations → Marketplace**), add **Upstash for Redis** (free tier is fine), and connect it to the project. This sets the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables automatically.
4. Redeploy. The yellow "in-memory storage" banner disappears once Redis is connected.

### Email: sign-in codes and notifications (required)

**Option 1: Gmail (no domain needed)**
1. On the Gmail account you want to send from, turn on 2-Step Verification: https://myaccount.google.com/signinoptions/twosv
2. Create an App Password at https://myaccount.google.com/apppasswords (name it "SplitApp") and copy the 16-character password.
3. In Vercel, under **Settings → Environment Variables**, add `GMAIL_USER` (your Gmail address) and `GMAIL_APP_PASSWORD` (the App Password).
4. Redeploy.

Gmail allows about 500 emails per day. Emails come from your Gmail address with the display name "SplitApp".

**Option 2: Resend (if you have a domain)**: set `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain you've verified in Resend).

When someone adds or edits an expense, the payer and everyone who owes a share are emailed if they have an email address. **Sign-in depends on email**, so in production nobody can sign in until one of the options above is set up.

You can also deploy from the command line with `npx vercel`, then add the Redis integration in the dashboard.

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` work too, if you create an Upstash database yourself.

## How it works

- **Next.js App Router.** The API routes are `app/api/groups` and `app/api/groups/[id]`.
- Each group is stored as one JSON document under `group:<id>` in Redis.
- Amounts are stored as integer cents. The split math in `lib/split.ts` uses largest-remainder rounding so shares always add up exactly to the total.
- **Sign-in:** a 6-digit code is emailed to you. It expires after 10 minutes, and 5 wrong guesses cancel it. Codes are stored hashed. A successful sign-in creates a 30-day session, stored in Redis and in an HttpOnly cookie.
- **Access:** a group can only be opened or changed by signed-in users whose email is on its member list. Members without an email are just names, with no login. To give someone access, add their email to their name in the People panel. You can't remove yourself or change your own email.
- **Abuse limits:** 5 code requests per email and 20 per IP address per hour, 30 new groups per user per day, 50 people per group, and 100 notification emails per user per day. Each notification can be traced to the signed-in user who triggered it, and you don't get emailed about your own changes.
