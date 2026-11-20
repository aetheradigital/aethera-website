'use strict';
/**
 * Reporting connections: which Google accounts belong to each client, and how numbers pulled by the
 * reporting Apps Script are written into that month's report without overwriting anything typed by hand.
 */

// Which report metrics each source fills in.
const SOURCES = {
  gsc: { label: 'Search Console', metrics: ['seo_clicks', 'seo_impressions', 'seo_avg_position'] },
  ga4: { label: 'Google Analytics', metrics: ['sessions', 'leads', 'revenue'] }
};

// Tidy what people paste into the client form. Returns an error message, or null (and fixes data in place).
function normalizeConnections(data) {
  if (typeof data.gsc_site === 'string' && data.gsc_site) {
    let v = data.gsc_site.trim();
    if (/^sc-domain:/i.test(v)) v = 'sc-domain:' + v.slice(10).trim().toLowerCase().replace(/^www\./, '');
    else if (/^https?:\/\//i.test(v)) { if (!v.endsWith('/')) v += '/'; }
    else if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test(v)) v = 'sc-domain:' + v.toLowerCase().replace(/^www\./, '').replace(/\/$/, '');
    if (!/^(sc-domain:[a-z0-9-]+(\.[a-z0-9-]+)+|https?:\/\/[^\s/]+\.[^\s]*\/)$/i.test(v)) return 'Search Console site should look like baconroofing.com, sc-domain:baconroofing.com or https://www.baconroofing.com/.';
    data.gsc_site = v;
  }
  if (typeof data.ga4_property === 'string' && data.ga4_property) {
    const v = data.ga4_property.trim().replace(/^properties\//i, '');
    if (/^G-/i.test(v)) return 'That’s a measurement ID (G-…). Use the numeric Property ID from GA4: Admin › Property details.';
    if (!/^\d{6,12}$/.test(v)) return 'GA4 property ID is a number, e.g. 412345678 (GA4: Admin › Property details).';
    data.ga4_property = v;
  }
  return null;
}

// Clients the script should pull for: anyone not marked Past with at least one connection.
function reportingClients(clients) {
  return clients.filter((c) => c.status !== 'past' && (c.gsc_site || c.ga4_property))
    .map((c) => ({ id: c.id, name: c.company || c.name, gsc_site: c.gsc_site || null, ga4_property: c.ga4_property || null }));
}

// Write a source's numbers into a report. A number is written when the box is empty or was last filled by this
// same source; anything typed (or edited) by hand stays. Returns the new metrics/sources and what happened.
function mergeMetrics(report, source, incoming) {
  const metrics = Object.assign({}, report.metrics || {});
  const sources = Object.assign({}, report.sources || {});
  const written = []; const kept = [];
  for (const k of SOURCES[source].metrics) {
    if (incoming[k] === undefined) continue;
    if (metrics[k] !== undefined && sources[k] !== source) { kept.push(k); continue; }
    metrics[k] = incoming[k]; sources[k] = source; written.push(k);
  }
  return { metrics, sources, written, kept };
}

// When a report is edited by hand, numbers that changed are no longer "from" their source.
function sourcesAfterEdit(before, after) {
  const src = Object.assign({}, before.sources || {}); const old = before.metrics || {};
  Object.keys(src).forEach((k) => { if (after[k] === undefined || Number(after[k]) !== Number(old[k])) delete src[k]; });
  return src;
}

module.exports = { SOURCES, normalizeConnections, reportingClients, mergeMetrics, sourcesAfterEdit };
