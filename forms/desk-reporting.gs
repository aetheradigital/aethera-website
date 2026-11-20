/**
 * Aethera Desk reporting (Google Apps Script).
 *
 * Pulls each client's Search Console and Google Analytics (GA4) numbers for the last full month and sends them
 * to that client's monthly report in the Aethera Desk. Which accounts belong to which client comes from the
 * Desk (client page > Reporting Connections), so adding a client never means editing this script.
 * It only reads from Google; numbers typed into a report by hand are never overwritten.
 *
 * Install once, in the Google account that can see every client's Search Console and GA4 (nicholas@):
 *   1. script.google.com > New project, name it "Aethera Desk reporting", paste this file into Code.gs.
 *   2. Project Settings (gear) > tick "Show appsscript.json manifest file in editor". Open appsscript.json in the
 *      editor and replace its contents with forms/desk-reporting.appsscript.json from the repo.
 *   3. Project Settings > Script properties > Add: DESK_TOKEN = the same token the Desk collector uses.
 *   4. In the editor choose "setup" and click Run. Approve the Google permissions (read-only Search Console
 *      and Analytics). setup() pulls right away and then checks every morning at about 7 AM Eastern.
 *   Optional: run "backfill" once to fill in the previous 3 months, so the report charts have history.
 *
 * Search Console finalizes data about 3 days after a month ends, so the first days of each month refresh
 * the draft until it's complete. Once a report is marked Ready or Sent it's left alone.
 */
var DESK_URL = 'https://aetheradigital.com';
var BACKFILL_MONTHS = 3;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pull') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pull').timeBased().everyDays(1).atHour(7).inTimezone('America/New_York').create();
  pull();
}

// Last full month (the Desk decides which month that is).
function pull() { pullMonth_(null); }

// The previous few months as well, for history on the charts.
function backfill() {
  var info = call_('get', '/api/collector/reporting', null);
  var p = info.period;
  for (var i = 0; i < BACKFILL_MONTHS; i++) { pullMonth_(p); p = prevMonth_(p); }
}

function pullMonth_(period) {
  var info = call_('get', '/api/collector/reporting' + (period ? '?period=' + period : ''), null);
  var range = monthRange_(info.period);
  if (!info.clients.length) console.log('No clients have Reporting Connections yet. Add them on a client page in the Desk.');
  info.clients.forEach(function (c) {
    if (c.gsc_site) send_(c, info.period, 'gsc', function () { return searchConsole_(c.gsc_site, range); });
    if (c.ga4_property) send_(c, info.period, 'ga4', function () { return analytics_(c.ga4_property, range); });
  });
}

// Pull one source and send the numbers, or the reason it failed (shown on the client's page in the Desk).
function send_(client, period, source, fetchMetrics) {
  var body = { client_id: client.id, period: period, source: source };
  try { body.metrics = fetchMetrics(); }
  catch (e) { body.error = friendly_(source, String(e && e.message || e)); }
  var r = call_('post', '/api/collector/metrics', body);
  console.log(client.name + ' · ' + source + ' · ' + period + ': ' + (body.error ? 'ERROR ' + body.error
    : (r.reviewed ? 'report already reviewed, left alone' : (r.written || []).length + ' updated' + ((r.kept || []).length ? ', ' + r.kept.length + ' kept (typed by hand)' : ''))));
}

// Search Console totals for the month: clicks, impressions, average position.
function searchConsole_(site, range) {
  var url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ startDate: range.start, endDate: range.end, type: 'web' })
  });
  var data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error((data.error && data.error.message) || ('HTTP ' + res.getResponseCode()));
  var row = (data.rows || [])[0];
  if (!row) return { seo_clicks: 0, seo_impressions: 0 };
  return { seo_clicks: Math.round(row.clicks), seo_impressions: Math.round(row.impressions), seo_avg_position: Math.round(row.position * 10) / 10 };
}

// GA4 totals for the month: sessions, key events (leads) and revenue (only when there is some).
function analytics_(propertyId, range) {
  var r = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }]
  }, 'properties/' + propertyId);
  var v = ((r.rows || [])[0] || { metricValues: [{ value: '0' }, { value: '0' }, { value: '0' }] }).metricValues;
  var out = { sessions: Number(v[0].value), leads: Number(v[1].value) };
  if (Number(v[2].value) > 0) out.revenue = Math.round(Number(v[2].value) * 100) / 100;
  return out;
}

function friendly_(source, msg) {
  if (/permission|forbidden|403|not have (sufficient )?permission|User does not have/i.test(msg)) {
    return (source === 'gsc' ? 'No access to this Search Console property' : 'No access to this GA4 property') +
      ' from ' + (Session.getActiveUser().getEmail() || 'the script’s Google account') + '. Ask the client to add you as a user, then it retries tomorrow.';
  }
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return 'The Google API isn’t enabled for the script yet: ' + msg.slice(0, 200);
  if (/not found|404/i.test(msg)) return (source === 'gsc' ? 'Search Console site not found. Check it matches the property exactly.' : 'GA4 property not found. Check the Property ID.');
  return msg.slice(0, 280);
}

function monthRange_(period) {
  var y = Number(period.slice(0, 4)); var m = Number(period.slice(5, 7));
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: period + '-01', end: period + '-' + (last < 10 ? '0' : '') + last };
}
function prevMonth_(period) {
  var y = Number(period.slice(0, 4)); var m = Number(period.slice(5, 7)) - 1;
  if (m === 0) { m = 12; y--; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}

function call_(method, path, body) {
  var token = PropertiesService.getScriptProperties().getProperty('DESK_TOKEN');
  if (!token) throw new Error('Add DESK_TOKEN under Project Settings > Script properties first.');
  var opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(DESK_URL + path, opts);
  var data = {}; try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (res.getResponseCode() !== 200) throw new Error('Desk ' + res.getResponseCode() + ': ' + (data.error || res.getContentText().slice(0, 200)));
  return data;
}
