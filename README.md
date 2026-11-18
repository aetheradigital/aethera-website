# aetheradigital.com

Aethera Digital's website plus a native, embedded Stripe checkout.

- `public/` - the site (home page, `/pay` client payments, `/pay/complete` return page, assets)
- `server.js` - zero-dependency Node server: serves `public/` and a small Stripe API
  - `GET /api/config` - publishable key + whether payments are configured
  - `POST /api/checkout` - creates an embedded Checkout Session (`partnership` subscription or `invoice` payment)
  - `GET /api/session-status` - safe status fields for the return page
- `test/server.test.js` - runs the server against a fake Stripe API (`npm test`)
- `forms/apps-script.gs` - Google Apps Script behind the contact form (inquiries sheet + email)

## Environment variables (Render)

| Key | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted key. Set in Render only, never commit. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` / `pk_live_...` |
| `SITE_URL` | Public origin for return URLs, e.g. `https://aetheradigital.com` |
| `PRICE_PARTNERSHIP`, `PRODUCT_INVOICE`, `PORTAL_URL` | Optional overrides; defaults are the sandbox IDs. Set live IDs when going live. |

Payment methods are controlled in the Stripe Dashboard (Settings > Payment methods). Enable ACH Direct Debit there; consumer pay-later methods are excluded in code.
