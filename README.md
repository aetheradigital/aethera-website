# aetheradigital.com

Aethera Digital's website plus a native, embedded Stripe checkout.

- `public/` - the site (home page, `/pay` client payments, `/pay/complete` return page, assets)
- `public/pay/` - client payments: invoice lookup, Startup Partnership signup, billing portal link
- `public/pay/invoice/` - a single invoice with line items and a branded Stripe Payment Element (reached by signed link)
- `public/pay/complete/` - payment result page
- `public/admin/` + `public/assets/desk.js|css` - the **Aethera Desk** at admin.aetheradigital.com: overview, clients & prospects,
  projects with checklists, files, approvals, monthly client reports with charts, and invoicing (create, email, resend, void, mark paid)
- `lib/pg.js` - dependency-free Postgres client; `lib/desk.js` - Desk record schema, checklists and storage
- `lib/quote-pdf.js` + `lib/pdf.js` - the branded signed-quote PDF (dependency-free PDF writer): downloaded from the Desk, the quote page and the portal, emailed to the signer, and filed to the client's Files
- `public/assets/pay.js`, `pay.css` - shared Payment Element styling and helpers
- `server.js` - zero-dependency Node server: serves `public/` and a small Stripe API
  - `GET /api/config` - publishable key, test mode, portal URL
  - `GET /api/invoice?i=&k=` - safe invoice fields + payment secret for a signed invoice link
  - `POST /api/invoice-lookup` - invoice number + billing email returns the signed link
  - `POST /api/subscribe` - creates the customer and an incomplete partnership subscription; returns the payment secret
  - `/api/admin/*` - login/logout, list, create (customer, invoice, line items, finalize, email), send, void, mark-paid
  - `POST /api/stripe/webhook` - signed Stripe events; each one is logged and sent to the Apps Script (Payments tab + email)
- `test/server.test.js` - runs the server against a fake Stripe API (`npm test`)
- `forms/apps-script.gs` - Google Apps Script: contact form, payments sheet/alerts, branded invoice emails
- `forms/desk-collector.gs` - Google Apps Script each team member installs: sends recent client emails and Gemini meeting notes to the Desk
- `lib/collector.js` - matches those to Desk clients and asks Claude for action items (suggested to-dos)

## Domains

Add `aetheradigital.com`, `www.aetheradigital.com`, `admin.aetheradigital.com` and `client.aetheradigital.com` as custom domains on the aethera-site service in Render, then create the DNS records Render lists. The admin and portal session cookies are each scoped to their own host.

## Suggested to-dos from email and meetings

1. Each person installs `forms/desk-collector.gs` in their own Google account (steps at the top of the file) with the `DESK_TOKEN` script property.
2. Every morning it sends the last 3 days of email threads involving a Desk client's address or domain, plus "Notes by Gemini" meeting docs, to `/api/collector/items`.
3. The Desk matches each item to clients (email domains, extra addresses, business names and the client's "Also match" field), sends only matched items to Claude, and saves the action items as suggestions.
4. Suggestions appear on the overview and on each client page with Add (to "General to-dos" or a chosen project) and Dismiss. Nothing becomes a task without a click. Items already seen are skipped.

## Monthly client reports

1. On the 1st of each month (checked every 6 hours, Eastern time) the Desk creates a **draft report for the month just ended** for every client marked **Active**.
   A draft you delete isn't recreated by the schedule; **Create Drafts** on the Reports page fills in any that are missing.
2. **Reports** opens on that month as a board: each active client shows **Not Started**, **Needs Data**, **Draft**, **Ready to Send** or **Sent**,
   with arrows to move between months and the full history below.
3. **Fill In** shows only the sections that match the client's services (Reporting & Strategy, or no services, shows all; **Show All Sections** overrides),
   with last month's value under each box.
4. **Draft with Claude** writes What Happened, Wins and Next Actions from the numbers on screen plus that month's finished tasks
   (tasks now record when they were ticked), approvals and decisions, open tasks, and email/meeting follow-ups. It fills the boxes for review; nothing is saved until you save.
5. **Save & Mark Ready**, then **Mark as Sent** once it's shared with the client.

### Pulling numbers from Google automatically

- On a client's page, **Reporting Connections** › **Connect Google**: enter the Search Console site (e.g. `baconroofing.com`, saved as
  `sc-domain:baconroofing.com`, or a URL-prefix property like `https://www.baconroofing.com/`) and the numeric GA4 Property ID.
- `forms/desk-reporting.gs` (Google Apps Script, installed once in nicholas@; setup steps at the top of the file, manifest in
  `forms/desk-reporting.appsscript.json`) runs every morning, asks the Desk which clients are connected, and sends each one's
  Search Console clicks / impressions / average position and GA4 sessions / key events (as leads) / revenue for the last full month.
  It uses the same `DESK_COLLECTOR_TOKEN`. Run `backfill` once to fill the previous 3 months.
- Pulled numbers go into that month's draft (created if needed) and are labelled with their source in the editor. A number typed or
  changed by hand is never overwritten, and reports marked Ready or Sent are left alone.
- The client page shows the last pull for each connection, including problems such as "No access to this GA4 property".

## Digital Health (SEO + AI search)

**Digital Health** in the Desk scores each page or profile ("asset") for SEO and AI search (AISO) and blends them 50/50
into a Digital Health Score. A pass earns a check's full weight and a partial half; a fail or a check nobody has verified yet
earns nothing, and only N/A checks are left out, so scores rise as things are confirmed. Checks, weights and the page analyzer live in `public/assets/health.js`; server-side
cleaning, page fetching, Claude review and report numbers in `lib/health.js`.

1. **New Asset** (on Digital Health or a client's **Health** tab): name, client (or Aethera internal), type, URL, status.
2. **Scan** fetches the page and its robots.txt through the server (public addresses only, 3 MB cap, up to 5 redirects) and runs
   the 25 automatic checks in the browser. Pages that build their content with JavaScript from a `<template>` are scored on that
   content, and "Readable without JavaScript" is scored on the raw HTML. Preview or password-protected pages: paste the source.
   Scans only run when you click Scan.
3. **Checks**: mark the manual ones Pass / Partial / Fail / N/A with notes. **Review With Claude** (needs `ANTHROPIC_API_KEY`)
   scores the judgment checks and suggests fixes, a title, a meta description, FAQs and prompts.
4. **AI Visibility**: questions customers would ask an assistant, with the result per engine (cited, mentioned, not present).
5. **Fixes**: failed checks and Claude's recommendations go to the client's **General To-Dos** with one click. Internal
   assets keep their own task list.
6. **Reports**: draft monthly reports get a **Digital Health** section (score, SEO, AISO) for clients on SEO & AI Search or
   Website services: the average of the client's **Live** assets' latest scans in that month. Typed numbers and reports marked
   Ready or Sent are left alone.
7. **Import** brings in assets from the standalone Digital Health tool ("Copy export for the Desk", then paste). Assets match
   clients by name, business name or "Also Matches"; unmatched ones come in as internal.

## How invoicing works

1. Sign in at `https://admin.aetheradigital.com` (or `/admin` on the onrender.com address) and create an invoice (client, line items, due date, note). It's created and finalized in Stripe.
2. "Create & email" sends a branded email (via the Apps Script) with a **View & pay invoice** button linking to `/pay/invoice/?i=…&k=…`.
   The link is signed, so it can't be guessed or edited. Without the Apps Script, Stripe's own invoice email is sent instead.
3. Clients who lost the email can find the invoice on `/pay` with the invoice number and billing email.
4. They pay by ACH or card in the branded Payment Element. Stripe marks the invoice paid and the webhook records it.

## Quotes and e-signatures

Desk → **Quotes**. Build a quote from the **Service Catalog** (or type lines in): hourly phases are priced at the client's rate
(the $50/hr standard rate shown struck through), a startup discount takes a % off the one-time work, optional lines become add-ons
the client can tick, and monthly lines are billed every month.

1. **Send to Client** emails a private link (`/quote/?t=…`) through the Apps Script, or gives you the link to send yourself.
   The client's status moves to Proposal; the first time they open it, the quote shows as Viewed.
2. The client reviews it, picks add-ons, reads the **Terms of Service**, draws a signature, and agrees to sign electronically.
   The server re-checks the price and terms version before accepting.
3. On signing the Desk records the signature, name, email, time, IP address, browser, the terms version and a SHA-256 fingerprint
   of exactly what was signed. Signed quotes can't be edited or deleted (duplicate them to make a new version).
4. Billing follows the quote's payment schedule: **On signing** payments (and dated ones already past) are invoiced and emailed
   straight away, **On a date** payments go out that morning (checked hourly), **At a milestone** payments wait for **Bill Now**.
   Monthly lines start a Stripe subscription billed by invoice from the monthly start date (or the day they sign).
5. A signed copy is emailed to the client (copying the business inbox) as a PDF made by the Apps Script, and the PDF is saved
   to the client's Files (Contract).

Terms of Service are versioned under Quotes → Terms of Service. Saving creates a new version; signed quotes keep theirs.
Version 1 (the starting text) has been reviewed and approved by Aethera's attorney. Have later changes reviewed the same way.

Apps Script: quote emails use the `quote_email` handler in `forms/apps-script.gs`. Paste the updated script and deploy a
**new version** of the web app, or quote emails will fail. For monthly invoices from quotes to use the Aethera email instead of
Stripe's, add `invoice.finalized` to the webhook's events.

## Client portal (client.aetheradigital.com)

Each client gets a private portal with their **sent** monthly reports (charts, wins, next actions), projects and checklists,
files you share, approvals, their Stripe invoices (paid natively with the Payment Element, "Powered by Stripe") and their own activity log.

- **Turning it on:** a client's **Overview** tab in the Desk › **Client Portal** › tick "Let this client sign in", then **Send Portal Invite**.
  The client's email in the Desk is their login (one login per client; two clients can't share an email). Turning access off signs them out everywhere.
- **Signing in:** the client enters their email and gets a one-time link (15 minutes, single use) through the Apps Script email
  (same `quote_email` sender as quotes, so no Apps Script changes are needed). The link opens a "Continue to your portal" page,
  so email scanners that open links can't use it up. Sessions last 30 days in an HttpOnly cookie on the portal host only.
  The sign-in form gives the same answer whether or not an email has access.
- **What they see:** reports marked **Sent**, every project except "General To-Dos", files with **Client Portal › Shared** ticked
  (new uploads have a "Share in the client portal" box; signed quote PDFs are shared automatically), and all approvals.
  Approval **notes** stay internal; the client's reply is saved as their comment. Attach a file to an approval to have them review it.
  Invoices are found by the client's email in Stripe, and an invoice belonging to another Stripe customer can't be opened or paid.
- **Quotes:** every quote you send (not drafts or withdrawn ones) shows under **Quotes**, with a "Ready to sign" count and an overview card. Opening one
  is logged and goes to the quote's review & sign page. Sending, re-sending, withdrawing, signing and declining are all in the audit log.
- **Client actions:** approve or request changes (with a note), mark access requests done, download and upload files,
  pay invoices by card or ACH, save a payment method, download invoice PDFs and receipts.
- **Audit log:** every sign-in, sign-in link, refused link, new device, report view, download, upload, approval, payment and portal
  change made in the Desk is written to `portal_audit` with time, IP and device. It's append-only (Postgres rules ignore UPDATE and
  DELETE) and kept when a client is deleted. Clients see their own entries under **Activity**; the Desk's **Client Portal** page shows
  everything with filters (client, type, needs review, search) and **Export CSV**. Sign-ins from a new device, reused or expired links
  and too many link requests are marked **Review**.
- **Files** go to Cloudflare R2 when the four `R2_*` variables are set (up to 50 MB each; otherwise Postgres, 15 MB). Downloads are
  10-minute signed links. Files uploaded before R2 was set up stay in Postgres and keep working.

## Environment variables (Render)

| Key | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. Set in Render only, never commit. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` / `pk_live_...` |
| `SITE_URL` | Public origin used in emailed invoice links, e.g. `https://aetheradigital.com`. Leave unset until the domain points at this service; links then use the address the admin page is open on. |
| `DATABASE_URL` | Render Postgres **Internal Database URL** for the Desk (`aethera-desk`). Without it the Desk keeps data in memory only. |
| `DESK_COLLECTOR_TOKEN` | Shared secret for the Apps Script collector (same value as each script's `DESK_TOKEN`). |
| `ANTHROPIC_API_KEY` | Claude API key (console.anthropic.com) used to extract action items. `ANTHROPIC_MODEL` optionally overrides the default `claude-haiku-5-5`. |
| `ANTHROPIC_REPORT_MODEL` | Optional model for report commentary (defaults to `ANTHROPIC_MODEL`). |
| `DESK_TIMEZONE` | Optional, default `America/New_York`: when a new month starts for report drafts and task finish dates. |
| `REPORT_DRAFTS` | `off` stops the automatic monthly drafts. |
| `QUOTE_BILLING` | `off` stops the hourly check that invoices dated quote payments. |
| `ADMIN_PASSWORD` | Password for the admin site. Admin is off until this is set. Use a long passphrase. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 bucket for Desk and portal files (token with Object Read & Write on that bucket only). All four turn R2 on. |
| `CLIENT_HOST` | Optional, default `client.aetheradigital.com`. On that host `/` is the client portal; elsewhere (onrender.com, localhost) it's at `/client/`. |
| `ADMIN_HOST` | Optional, default `admin.aetheradigital.com`. On that host `/` is the admin dashboard; on `aetheradigital.com` and `www.` the `/admin` path redirects there and the admin API is disabled. The onrender.com address keeps `/admin` as a fallback. |
| `PRICE_PARTNERSHIP`, `PORTAL_URL` | Optional overrides; leave unset. The server picks live or sandbox defaults from `STRIPE_SECRET_KEY`: live keys use the five Startup Package prices ($200 + $600 + $450 + $750 + $250) and the live billing portal. `PRICE_PARTNERSHIP` takes comma-separated price IDs. |
| `STRIPE_AUTOMATIC_TAX` | `on` to enable Stripe Tax on new invoices and subscriptions (finish Tax setup and add registrations first). |
| `INVOICE_LINK_SECRET` | Optional. Key for signing invoice links; defaults to one derived from `STRIPE_SECRET_KEY` (changing the key changes the links). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` signing secret of the Stripe webhook endpoint. Sandbox and live endpoints have different secrets. |
| `PAYMENTS_NOTIFY_URL` | Optional. The Apps Script web app URL (same one the contact form uses). |
| `PAYMENTS_NOTIFY_TOKEN` | Optional. Any long random string; set the same value as the `PAYMENTS_TOKEN` script property in Apps Script. |

## Stripe webhook

Endpoint: `https://<site>/api/stripe/webhook`. Events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `customer.subscription.updated`, `customer.subscription.deleted`.
Bad or stale signatures get 400. If the Apps Script can't be reached the server returns 500 so Stripe retries.

Invoices and the partnership accept card and US bank account (ACH), set in code (`PAYMENT_METHOD_TYPES`).
