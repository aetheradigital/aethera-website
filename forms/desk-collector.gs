/**
 * Aethera Desk collector (Google Apps Script).
 *
 * Runs inside one person's Google account. Each morning it sends that person's recent emails with Desk
 * clients and their Gemini meeting notes to the Aethera Desk, which turns them into suggested to-dos.
 * Nothing is changed in Gmail or Drive; the script only reads.
 *
 * Install (once per inbox: nicholas@, hello@, Joseph):
 *   1. script.google.com > New project, name it "Aethera Desk collector", paste this file.
 *   2. Project Settings (gear) > Script properties > Add: DESK_TOKEN = <token from Nicholas>.
 *   3. Back in the editor choose the "setup" function and click Run. Approve the Google permissions.
 *      setup() runs a first check right away and schedules a daily check at about 6 AM Eastern.
 *
 * hello@ (prospects and website form submissions): also add the script property DESK_MODE = leads.
 * In lead mode it checks every 2 hours and also sends new inbound emails from people who aren't clients yet,
 * so the Desk can spot new-business inquiries and suggest them as leads.
 */
var DESK_URL = 'https://aetheradigital.com';
var LOOKBACK_DAYS = 3;          // re-reads the last few days each run; the Desk ignores anything it has already seen
var MAX_THREADS = 60;
var BATCH = 8;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'collect') ScriptApp.deleteTrigger(t);
  });
  if (leadMode_()) ScriptApp.newTrigger('collect').timeBased().everyHours(2).create();
  else ScriptApp.newTrigger('collect').timeBased().everyDays(1).atHour(6).inTimezone('America/New_York').create();
  collect();
}

function leadMode_() {
  return String(PropertiesService.getScriptProperties().getProperty('DESK_MODE') || '').trim().toLowerCase() === 'leads';
}

function collect() {
  var token = PropertiesService.getScriptProperties().getProperty('DESK_TOKEN');
  if (!token) throw new Error('Add DESK_TOKEN under Project Settings > Script properties first.');
  var me = Session.getActiveUser().getEmail() || 'unknown';
  var info = call_('get', '/api/collector/clients', null, token);
  if (!info.ai) console.warn('The Desk has no Claude API key yet; items will be refused until ANTHROPIC_API_KEY is set in Render.');
  var clients = info.clients || [];

  var items = emails_(clients, me).concat(meetings_());
  if (leadMode_()) {
    var have = {}; items.forEach(function (x) { have[x.url] = true; });   // same thread already sent as a client email
    inbound_(me).forEach(function (x) { if (!have[x.url]) items.push(x); });
  }
  var queued = 0;
  for (var i = 0; i < items.length; i += BATCH) {
    var r = call_('post', '/api/collector/items', { by: me, items: items.slice(i, i + BATCH) }, token);
    queued += r.queued || 0;
  }
  console.log('Aethera Desk: sent ' + items.length + ' item(s), ' + queued + ' new for ' + me);
}

// Email threads from the last few days that involve a Desk client's address or domain.
function emails_(clients, me) {
  var terms = [];
  clients.forEach(function (c) {
    (c.domains || []).forEach(function (d) { terms.push(d); });
    (c.emails || []).forEach(function (e) { if ((c.domains || []).indexOf(e.split('@')[1]) < 0) terms.push(e); });
  });
  if (!terms.length) return [];
  var seen = {}; var out = [];
  for (var i = 0; i < terms.length; i += 15) {
    var part = terms.slice(i, i + 15).map(function (t) { return 'from:' + t + ' to:' + t + ' cc:' + t; }).join(' ');
    var q = 'newer_than:' + LOOKBACK_DAYS + 'd -category:promotions -category:social -in:spam -in:trash {' + part + '}';
    GmailApp.search(q, 0, MAX_THREADS).forEach(function (th) {
      if (seen[th.getId()]) return; seen[th.getId()] = true;
      var msgs = th.getMessages(); var last = msgs[msgs.length - 1];
      var recent = msgs.slice(-4);
      var people = { from: [], to: [], cc: [] };
      var text = recent.map(function (m) {
        people.from.push(m.getFrom()); people.to.push(m.getTo()); people.cc.push(m.getCc());
        return 'From: ' + m.getFrom() + '\nDate: ' + m.getDate().toISOString() + '\n\n' + stripQuoted_(m.getPlainBody()).slice(0, 4000);
      }).join('\n\n---\n\n');
      var id = '';
      try { id = last.getHeader('Message-ID'); } catch (e) { id = ''; }
      out.push({
        kind: 'email',
        key: 'mail:' + (id || last.getId()),
        url: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + th.getId(),
        title: th.getFirstMessageSubject(),
        date: last.getDate().toISOString().slice(0, 10),
        from: people.from.join(', '), to: people.to.join(', '), cc: people.cc.join(', '),
        text: text
      });
    });
  }
  return out;
}

// Lead mode: new inbound mail from outside the team (plus website form notifications, which come from our own address).
function inbound_(me) {
  var out = []; var seen = {};
  var queries = [
    'in:inbox newer_than:' + LOOKBACK_DAYS + 'd -from:aetheradigital.com -from:oakgrovebusiness.com -category:promotions -category:social -category:updates -category:forums -from:noreply -from:no-reply -from:donotreply -from:mailer-daemon',
    'newer_than:' + LOOKBACK_DAYS + 'd subject:"New website inquiry"'
  ];
  queries.forEach(function (q) {
    GmailApp.search(q, 0, 40).forEach(function (th) {
      if (seen[th.getId()]) return; seen[th.getId()] = true;
      var first = th.getMessages()[0];
      var id = '';
      try { id = first.getHeader('Message-ID'); } catch (e) { id = ''; }
      out.push({
        kind: 'email', lead: true,
        key: 'mail:' + (id || first.getId()),
        url: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + th.getId(),
        title: th.getFirstMessageSubject(),
        date: first.getDate().toISOString().slice(0, 10),
        from: first.getFrom(), to: first.getTo(), cc: first.getCc(), reply_to: first.getReplyTo(),
        text: stripQuoted_(first.getPlainBody()).slice(0, 8000)
      });
    });
  });
  return out;
}

// Gemini "Notes by Gemini" docs created or updated in the last few days (Meet recordings).
function meetings_() {
  var since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
  var files = DriveApp.searchFiles("title contains 'Notes by Gemini' and modifiedDate > '" + since + "' and trashed = false");
  var out = [];
  while (files.hasNext() && out.length < 40) {
    var f = files.next();
    var text = '';
    try { text = DocumentApp.openById(f.getId()).getBody().getText(); } catch (e) { continue; }
    if (!text.trim()) continue;
    out.push({
      kind: 'meeting',
      key: 'doc:' + f.getId() + ':' + f.getLastUpdated().getTime(),
      url: f.getUrl(),
      title: f.getName(),
      date: f.getDateCreated().toISOString().slice(0, 10),
      text: text.slice(0, 20000)
    });
  }
  return out;
}

// Drop quoted earlier replies so each message is read once.
function stripQuoted_(body) {
  var lines = String(body || '').split(/\r?\n/); var keep = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+/.test(l) && i > 3) break;
    if (/^\s*>/.test(l)) continue;
    keep.push(l);
  }
  return keep.join('\n').trim();
}

function call_(method, path, body, token) {
  var res = UrlFetchApp.fetch(DESK_URL + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: body ? JSON.stringify(body) : undefined
  });
  var code = res.getResponseCode(); var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) { data = {}; }
  if (code >= 300) throw new Error('Aethera Desk ' + code + ': ' + (data.error || res.getContentText().slice(0, 200)));
  return data;
}
