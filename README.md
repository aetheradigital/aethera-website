# aetheradigital.com

Static site for Aethera Digital. No build step: Render serves the repo root.

- `index.html` – the whole site (styles and scripts inline)
- `assets/` – logo, icon, favicons, social image
- `robots.txt`, `sitemap.xml` – search engine basics
- Contact form posts to the Google Apps Script web app URL set in `window.AETHERA_FORM_ENDPOINT` near the bottom of `index.html`. The script logs each inquiry to the "Aethera Website Inquiries" Google Sheet and emails a notification.
