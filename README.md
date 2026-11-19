# aetheradigital.com

Aethera Digital's website plus a native, embedded Stripe checkout.

- `public/` - the site (home page, `/pay` client payments, `/pay/complete` return page, assets)
- `server.js` - zero-dependency Node server: serves `public/` and a small Stripe API
  - `GET /api/config` - publishable key + whether payments are configured
  - `POST /api/checkout` - creates an embedded Checkout Session (`partnership` subscription or `invoice` payment)
  - `GET /api/session-status` - safe status fields for the return page
  - `POST /api/stripe/webhook` - signed Stripe events (payments, ACH settlement, renewals, failures, cancellations); each one is logged and sent to the Apps Script, which adds a row to the "Payments" tab and emails hello@
- `test/server.test.js` - runs the server against a fake Stripe API (`npm test`)
- `forms/apps-script.gs` - Google Apps Script behind the contact form (inquiries sheet + email)

## Environment variables (Render)

| Key | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. Set in Render only, never commit. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` / `pk_live_...` |
| `SITE_URL` | Public origin for return URLs, e.g. `https://aetheradigital.com` |
| `PRICE_PARTNERSHIP`, `PRODUCT_INVOICE`, `PORTAL_URL` | Optional overrides; defaults are the sandbox IDs. Set live IDs when going live. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` signing secret of the Stripe webhook endpoint. Sandbox and live endpoints have different secrets. |
| `PAYMENTS_NOTIFY_URL` | Optional. The Apps Script web app URL (same one the contact form uses). |
| `PAYMENTS_NOTIFY_TOKEN` | Optional. Any long random string; set the same value as the `PAYMENTS_TOKEN` script property in Apps Script. |

## Stripe webhook

Endpoint: `https://<site>/api/stripe/webhook`. Events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
Bad or stale signatures get 400. If the Apps Script can't be reached the server returns 500 so Stripe retries.

Payment methods are controlled in the Stripe Dashboard (Settings > Payment methods). Enable ACH Direct Debit there; consumer pay-later methods are excluded in code.
