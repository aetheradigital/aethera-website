# aetheradigital.com

Aethera Digital's website plus a native, embedded Stripe checkout.

- `public/` - the site (home page, `/pay` client payments, `/pay/complete` return page, assets)
- `public/pay/` - client payments: invoice lookup, Startup Partnership signup, billing portal link
- `public/pay/invoice/` - a single invoice with line items and a branded Stripe Payment Element (reached by signed link)
- `public/pay/complete/` - payment result page
- `public/admin/` - password-protected admin: create, email, resend, void and mark invoices paid
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

## How invoicing works

1. Sign in at `/admin` and create an invoice (client, line items, due date, note). It's created and finalized in Stripe.
2. "Create & email" sends a branded email (via the Apps Script) with a **View & pay invoice** button linking to `/pay/invoice/?i=…&k=…`.
   The link is signed, so it can't be guessed or edited. Without the Apps Script, Stripe's own invoice email is sent instead.
3. Clients who lost the email can find the invoice on `/pay` with the invoice number and billing email.
4. They pay by ACH or card in the branded Payment Element. Stripe marks the invoice paid and the webhook records it.

## Environment variables (Render)

| Key | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. Set in Render only, never commit. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` / `pk_live_...` |
| `SITE_URL` | Public origin used in emailed invoice links, e.g. `https://aetheradigital.com`. Leave unset until the domain points at this service; links then use the address the admin page is open on. |
| `ADMIN_PASSWORD` | Password for `/admin`. Admin is off until this is set. Use a long passphrase. |
| `PRICE_PARTNERSHIP`, `PORTAL_URL` | Optional overrides; defaults are the sandbox IDs. Set live IDs when going live. |
| `STRIPE_AUTOMATIC_TAX` | `on` to enable Stripe Tax on new invoices and subscriptions (finish Tax setup and add registrations first). |
| `INVOICE_LINK_SECRET` | Optional. Key for signing invoice links; defaults to one derived from `STRIPE_SECRET_KEY` (changing the key changes the links). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` signing secret of the Stripe webhook endpoint. Sandbox and live endpoints have different secrets. |
| `PAYMENTS_NOTIFY_URL` | Optional. The Apps Script web app URL (same one the contact form uses). |
| `PAYMENTS_NOTIFY_TOKEN` | Optional. Any long random string; set the same value as the `PAYMENTS_TOKEN` script property in Apps Script. |

## Stripe webhook

Endpoint: `https://<site>/api/stripe/webhook`. Events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
Bad or stale signatures get 400. If the Apps Script can't be reached the server returns 500 so Stripe retries.

Invoices and the partnership accept card and US bank account (ACH), set in code (`PAYMENT_METHOD_TYPES`).
