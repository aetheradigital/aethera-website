/* Aethera Desk: quotes (builder, sending, signatures, billing), service catalog and terms of service. */
(function () {
  'use strict';
  var D = window.Desk;
  var h = D.h, btn = D.btn, desk = D.desk, toast = D.toast, money = D.money, day = D.day;

  var STATE = { draft: 'Draft', sent: 'Sent', viewed: 'Viewed', accepted: 'Signed', declined: 'Declined', expired: 'Expired', void: 'Withdrawn' };
  var WHEN = [['signing', 'On Signing'], ['date', 'On a Date'], ['milestone', 'At a Milestone']];
  function qbadge(s) { return h('span', { class: 'st q-' + s, text: STATE[s] || s }); }
  function dollars(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function stamp(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
  function totalText(t, monthly) { return [t ? money(t) : null, monthly ? money(monthly) + '/mo' : null].filter(Boolean).join(' + ') || '—'; }

  // Same math as lib/quotes.js (the server re-checks it when the client signs).
  function totals(q, selected) {
    var sel = selected || [];
    var std = q.standard_rate != null && q.standard_rate !== '' ? Number(q.standard_rate) : 50;
    var rate = q.rate != null && q.rate !== '' ? Number(q.rate) : std;
    var pct = Number(q.startup_discount_pct) || 0;
    var t = { hours: 0, standard: 0, subtotal: 0, monthly: 0, lines: {} };
    (q.items || []).forEach(function (it) {
      var a = it.pricing === 'fixed' ? { standard: Math.round(Number(it.amount || 0) * 100), amount: Math.round(Number(it.amount || 0) * 100), hours: 0 }
        : { standard: Math.round(Number(it.hours || 0) * std * 100), amount: Math.round(Number(it.hours || 0) * rate * 100), hours: Number(it.hours || 0) };
      t.lines[it.id] = a;
      if (it.optional && sel.indexOf(it.id) < 0) return;
      if (it.billing === 'monthly') { t.monthly += a.amount; return; }
      t.hours += a.hours; t.standard += a.standard; t.subtotal += a.amount;
    });
    t.rate_discount = t.standard - t.subtotal;
    t.startup_pct = pct; t.startup_discount = Math.round(t.subtotal * pct / 100);
    t.startup_hours = Math.round(t.hours * pct) / 100;
    t.total = t.subtotal - t.startup_discount;
    t.hours = Math.round(t.hours * 100) / 100;
    return t;
  }
  function split(q, total) {
    var s = q.schedule && q.schedule.length ? q.schedule : [{ label: 'Due on signing', percent: 100, when: 'signing' }];
    var used = 0;
    return s.map(function (x, i) { var a = i === s.length - 1 ? total - used : Math.round(total * Number(x.percent || 0) / 100); used += a; return Object.assign({}, x, { amount: a }); });
  }

  // ---------- routes ----------
  function route(p, q) {
    if (p[1] === 'catalog') return catalogView();
    if (p[1] === 'terms') return termsView();
    if (p[1] && p[2] === 'edit') return editorView(p[1]);
    if (p[1]) return quoteView(p[1]);
    return listView(q.state || '');
  }

  function newQuote(clientId) {
    desk('GET', '/clients').then(function (r) {
      var clients = r.items.slice().sort(function (a, b) { return (a.company || a.name).localeCompare(b.company || b.name); });
      if (!clients.length) { toast('Add a client first', true); return; }
      D.modal({ title: 'New Quote', submit: 'Create Quote', values: { client_id: clientId || '' },
        fields: [
          { name: 'client_id', label: 'Client', type: 'select', options: [['', 'Choose a client…']].concat(clients.map(function (c) { return [c.id, (c.company || c.name) + (c.company ? ' (' + c.name + ')' : '')]; })) },
          { name: 'title', label: 'Project Title', placeholder: 'e.g. Website Redesign & Launch' }
        ],
        onSubmit: function (d) {
          if (!d.client_id) throw new Error('Choose a client.');
          return desk('POST', '/quotes', d).then(function (x) { location.hash = '#/quotes/' + x.item.id + '/edit'; });
        } });
    }).catch(function (x) { toast(x.message, true); });
  }

  // ---------- list ----------
  function quoteTable(items, showClient) {
    if (!items.length) return D.emptyLine('No quotes yet.');
    return h('div', { class: 'card flush' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', { text: 'Quote' }), showClient ? h('th', { text: 'Client' }) : null, h('th', { class: 'num', text: 'Total' }), h('th', { text: 'Status' }), h('th', { text: 'Last Activity' }))),
      h('tbody', null, items.map(function (x) {
        var last = x.accepted_at ? 'Signed ' + day(x.accepted_at) : x.viewed_at ? 'Viewed ' + day(x.viewed_at) : x.sent_at ? 'Sent ' + day(x.sent_at) : 'Created ' + day(x.created_at);
        return h('tr', { class: 'link', onclick: function () { location.hash = '#/quotes/' + x.id; } },
          h('td', { class: 'who' }, h('b', { text: x.title }), h('small', { text: x.number })),
          showClient ? h('td', { text: x.client }) : null,
          h('td', { class: 'num', text: totalText(x.total, x.monthly) }),
          h('td', null, qbadge(x.state), x.needs_billing ? h('span', { class: 'st pending', style: 'margin-left:6px', text: 'Bill' }) : null),
          h('td', { text: last }));
      }))));
  }
  function listView(state) {
    D.loading();
    desk('GET', '/quotes').then(function (r) {
      var groups = { '': 'All', open: 'Open', draft: 'Drafts', accepted: 'Signed', closed: 'Declined & Expired' };
      var match = function (x) {
        return !state || (state === 'open' ? x.state === 'sent' || x.state === 'viewed' : state === 'closed' ? ['declined', 'expired', 'void'].indexOf(x.state) >= 0 : x.state === state);
      };
      var signed = r.items.filter(function (x) { return x.state === 'accepted'; });
      var open = r.items.filter(function (x) { return x.state === 'sent' || x.state === 'viewed'; });
      D.render(D.pageHead('Billing', 'Quotes', [btn('Service Catalog', function () { location.hash = '#/quotes/catalog'; }, 'ghost'), btn('Terms of Service', function () { location.hash = '#/quotes/terms'; }, 'ghost'), btn('New Quote', function () { newQuote(null); })]),
        h('div', { class: 'grid g3', style: 'margin-bottom:18px' },
          D.tile('Open Quotes', String(open.length), money(open.reduce(function (s, x) { return s + x.total; }, 0)) + ' waiting on signature'),
          D.tile('Signed, Last 90 Days', String(signed.filter(function (x) { return Date.now() - Date.parse(x.accepted_at) < 90 * 864e5; }).length), money(signed.filter(function (x) { return Date.now() - Date.parse(x.accepted_at) < 90 * 864e5; }).reduce(function (s, x) { return s + x.total; }, 0)) + ' in project work'),
          D.tile('Ready to Bill', String(r.items.filter(function (x) { return x.needs_billing; }).length), 'Milestone payments waiting')),
        h('div', { class: 'toolbar' }, Object.keys(groups).map(function (k) { return h('a', { class: 'chip', href: '#/quotes' + (k ? '?state=' + k : ''), 'aria-pressed': String(state === k), text: groups[k] }); })),
        quoteTable(r.items.filter(match), true));
    }).catch(D.failed);
  }
  function clientTab(c, d) {
    return h('div', null, h('div', { class: 'toolbar' }, btn('New Quote', function () { newQuote(c.id); })), quoteTable(d.quotes || [], false));
  }

  // ---------- one quote ----------
  function quoteView(id) {
    D.loading();
    desk('GET', '/quotes/' + id).then(function (r) {
      var q = r.item, c = r.client || {}, st = r.state, t = r.totals;
      var reload = function () { quoteView(id); };
      var editable = ['draft', 'sent', 'viewed', 'expired'].indexOf(st) >= 0;
      var acts = [];
      if (editable) acts.push(btn(st === 'draft' ? 'Send to Client' : 'Resend', function () { sendQuote(q, c, r, reload); }));
      if (r.url && st !== 'draft') acts.push(btn('Copy Link', function () { D.copy(r.url); }, 'ghost'));
      if (r.url) acts.push(h('a', { class: 'pill small ghost', href: r.url + (q.status === 'accepted' ? '' : '&preview=1'), target: '_blank', rel: 'noopener', text: q.status === 'accepted' ? 'Signed Copy ↗' : 'Preview ↗' }));
      else acts.push(btn('Preview', function () { toast('Send the quote (or choose “Get Link Only”) to create its private link', true); }, 'ghost'));
      if (editable) acts.push(btn('Edit', function () { location.hash = '#/quotes/' + q.id + '/edit'; }, 'ghost'));
      acts.push(btn('Duplicate', function () { desk('POST', '/quotes/' + q.id + '/duplicate').then(function (x) { toast('Copied to ' + x.item.number); location.hash = '#/quotes/' + x.item.id + '/edit'; }).catch(function (x) { toast(x.message, true); }); }, 'ghost'));

      var parts = [];
      parts.push(h('div', { class: 'grid g4' },
        D.tile('Project Total', money(t.total), t.savings ? 'Saves ' + money(t.savings) + ' vs. standard' : (t.hours ? t.hours + ' h' : 'One-time')),
        D.tile('Monthly', t.monthly ? money(t.monthly) + '/mo' : '—', t.monthly ? (q.monthly_start ? 'Starts ' + day(q.monthly_start) : 'Starts on signing') : 'No monthly services'),
        D.tile('With All Add-Ons', money(r.totals_all.total), (q.items || []).filter(function (i) { return i.optional; }).length + ' optional line(s)'),
        D.tile(st === 'accepted' ? 'Signed' : 'Valid Through', st === 'accepted' ? day(q.acceptance.at) : day(q.valid_until), st === 'accepted' ? 'by ' + q.acceptance.name : st === 'expired' ? 'Expired. Edit the date to reopen' : 'Issued ' + day(q.issued), st === 'expired')));

      if (q.acceptance) parts.push(signaturePanel(q, r));
      if (q.status === 'accepted') parts.push(billingPanel(q, reload));
      if (q.declined) parts.push(h('div', { class: 'panel', style: 'margin-top:18px' }, h('h2', null, 'Declined'), h('p', { text: 'Declined ' + stamp(q.declined.at) + (q.declined.reason ? ': “' + q.declined.reason + '”' : '.') })));
      parts.push(previewPanel(q, t));
      parts.push(h('div', { class: 'grid g2', style: 'margin-top:18px' }, trailPanel(q),
        h('div', { class: 'panel' }, h('h2', null, 'Housekeeping'),
          h('p', { class: 'was', text: q.status === 'accepted' ? 'Signed quotes are kept as a record. To change the work, duplicate this quote and send the new version.' : 'Editing a sent quote updates what the client sees at the same link.' }),
          h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
            ['sent', 'viewed'].indexOf(q.status) >= 0 ? btn('Withdraw Quote', function () { if (!confirm('Withdraw ' + q.number + '? The client’s link will stop working.')) return; desk('POST', '/quotes/' + q.id + '/void').then(function () { toast('Quote withdrawn'); reload(); }).catch(function (x) { toast(x.message, true); }); }, 'ghost') : null,
            q.status !== 'accepted' ? btn('Delete Quote', function () { if (!D.confirmDelete('quote ' + q.number)) return; desk('DELETE', '/quotes/' + q.id).then(function () { toast('Quote deleted'); location.hash = '#/quotes'; }).catch(function (x) { toast(x.message, true); }); }, 'ghost') : null))));

      D.render(D.pageHead(h('span', null, (c.company || c.name || '') + ' · ' + q.number + ' ', qbadge(st)), [q.title], acts, ['#/quotes', 'All Quotes']), parts);
    }).catch(D.failed);
  }

  function sendQuote(q, c, r, reload) {
    var hasEmail = Boolean(c.email);
    D.modal({ title: q.status === 'draft' ? 'Send Quote' : 'Resend Quote', submit: r.email ? 'Send Email' : 'Get Link',
      values: { to: c.email || '' },
      fields: [
        { name: 'to', label: 'Client Email', type: 'email', help: r.email ? 'They get a private link to review, choose add-ons and sign.' + (hasEmail ? '' : ' This will be their email from now on.') : 'Email isn’t set up on the server, so you’ll get the link to send yourself.' },
        { name: 'mode', label: 'How', type: 'select', options: [['email', 'Email the link'], ['link', 'Get Link Only (I’ll send it myself)']] }
      ],
      onSubmit: function (d) {
        var emailIt = r.email && d.mode === 'email';
        return desk('POST', '/quotes/' + q.id + '/send', { to: d.to, email: emailIt }).then(function (x) {
          if (!hasEmail && d.to) desk('PATCH', '/clients/' + c.id, { email: d.to }).catch(function () {});
          if (x.emailed) toast('Quote emailed to ' + d.to);
          else { D.copy(x.url); if (x.email_error) toast(x.email_error, true); }
          reload();
        });
      } });
  }

  function signaturePanel(q, r) {
    var a = q.acceptance;
    return h('div', { class: 'panel', style: 'margin-top:18px' }, h('h2', null, 'Signature'),
      h('div', { class: 'sigrow' },
        h('div', { class: 'sigbox' }, h('img', { src: a.signature, alt: 'Signature of ' + a.name })),
        h('dl', { class: 'dl' },
          h('dt', { text: 'Signed By' }), h('dd', { text: a.name + (a.title ? ', ' + a.title : '') }),
          h('dt', { text: 'Email' }), h('dd', { text: a.email }),
          h('dt', { text: 'When' }), h('dd', { text: stamp(a.at) }),
          h('dt', { text: 'IP Address' }), h('dd', { text: a.ip || '—' }),
          h('dt', { text: 'Terms' }), h('dd', { text: 'Version ' + a.terms_version }),
          h('dt', { text: 'Add-Ons Chosen' }), h('dd', { text: (q.items || []).filter(function (i) { return (a.selected || []).indexOf(i.id) >= 0; }).map(function (i) { return i.name; }).join(', ') || 'None' }),
          h('dt', { text: 'Fingerprint' }), h('dd', { class: 'mono', text: a.fingerprint }))),
      h('div', { class: 'toolbar', style: 'margin:14px 0 0' },
        q.signed_file_id ? h('a', { class: 'pill small ghost', href: '/api/admin/desk/files/' + q.signed_file_id, target: '_blank', rel: 'noopener', text: 'Signed PDF ↗' }) : null,
        r.email ? btn('Email Signed Copy Again', function (e) { e.target.disabled = true; desk('POST', '/quotes/' + q.id + '/resend-signed').then(function () { toast('Signed copy emailed'); }).catch(function (x) { toast(x.message, true); }).then(function () { e.target.disabled = false; }); }, 'ghost') : null));
  }

  function billingPanel(q, reload) {
    var rows = (q.billing || []).map(function (b, i) {
      var status = b.status === 'invoiced' ? h('span', null, h('span', { class: 'st open', text: 'Invoiced' }), ' ', b.invoice_number || '')
        : b.status === 'scheduled' ? h('span', { class: 'st review', text: 'Scheduled ' + day(b.date) })
        : b.status === 'milestone' ? h('span', { class: 'st pending', text: 'Waiting on Milestone' })
        : h('span', { class: 'st declined', text: 'Failed' });
      var act = b.status === 'invoiced' ? h('div', { class: 'rowacts' }, h('button', { type: 'button', text: 'Copy Link', onclick: function () { D.copy(b.pay_url); } }), h('a', { href: '#/invoices', text: 'Invoices' }))
        : h('div', { class: 'rowacts' }, h('button', { type: 'button', text: b.status === 'failed' ? 'Retry' : 'Bill Now', onclick: function (e) {
          if (!confirm('Create and email the ' + b.label + ' invoice for ' + money(b.amount) + '?')) return;
          e.target.disabled = true;
          desk('POST', '/quotes/' + q.id + '/bill/' + i).then(function () { toast('Invoice created and emailed'); reload(); }).catch(function (x) { e.target.disabled = false; toast(x.message, true); });
        } }));
      return h('tr', null, h('td', { class: 'who' }, h('b', { text: b.label }), h('small', { text: b.percent + '% · ' + (b.when === 'signing' ? 'On signing' : b.when === 'date' ? day(b.date) : 'At milestone') })),
        h('td', { class: 'num', text: money(b.amount) }), h('td', null, status, b.error ? h('small', { class: 'was', style: 'display:block', text: b.error }) : null, b.email_error ? h('small', { class: 'was', style: 'display:block', text: b.email_error }) : null), h('td', { class: 'num' }, act));
    });
    var mb = q.monthly_billing;
    if (mb) rows.push(h('tr', null, h('td', { class: 'who' }, h('b', { text: 'Monthly Services' }), h('small', { text: 'Every month from ' + day(mb.start) })),
      h('td', { class: 'num', text: money(mb.amount) + '/mo' }),
      h('td', null, mb.status === 'failed' ? h('span', { class: 'st declined', text: 'Failed' }) : h('span', { class: 'st active', text: mb.status === 'scheduled' ? 'Starts ' + day(mb.start) : 'Active' }), mb.error ? h('small', { class: 'was', style: 'display:block', text: mb.error }) : null),
      h('td', { class: 'num' }, mb.status === 'failed' ? h('div', { class: 'rowacts' }, h('button', { type: 'button', text: 'Retry', onclick: function (e) { e.target.disabled = true; desk('POST', '/quotes/' + q.id + '/start-monthly').then(function () { toast('Monthly billing started'); reload(); }).catch(function (x) { e.target.disabled = false; toast(x.message, true); }); } })) : null)));
    return h('div', { class: 'card flush', style: 'margin-top:18px' }, h('h2', { style: 'padding:22px 24px 0' }, 'Billing'),
      rows.length ? h('table', { class: 'tbl' }, h('tbody', null, rows)) : D.emptyLine('Nothing to bill.'));
  }

  function previewPanel(q, t) {
    var items = q.items || [];
    var line = function (it) {
      var a = t.lines[it.id] || { amount: 0 };
      return h('tr', null, h('td', { class: 'who' }, h('b', null, it.name, it.optional ? h('span', { class: 'tag', style: 'margin-left:8px', text: 'Add-On' }) : null), h('small', { text: [it.description, it.timeline].filter(Boolean).join(' · ') })),
        h('td', { class: 'num', text: it.pricing === 'hours' ? it.hours + ' h' : 'Fixed' }), h('td', { class: 'num', text: money(a.amount) + (it.billing === 'monthly' ? '/mo' : '') }));
    };
    var sched = split(q, t.total);
    return h('div', { class: 'panel', style: 'margin-top:18px' }, h('h2', null, 'Scope & Pricing'),
      q.summary ? h('p', { style: 'margin:0 0 14px', text: q.summary }) : null,
      items.length ? h('table', { class: 'tbl' }, h('tbody', null, items.map(line))) : D.emptyLine('No lines yet. Click Edit to build the quote.'),
      h('p', { class: 'was', style: 'margin:12px 0 0', text: 'Rate $' + q.standard_rate + '/hr → $' + q.rate + '/hr' + (q.startup_discount_pct ? ' · Startup discount ' + q.startup_discount_pct + '%' : '') + ' · Invoices due in ' + (q.days_until_due || 7) + ' days' }),
      t.total ? h('p', { class: 'was', style: 'margin:6px 0 0', text: 'Payments: ' + sched.map(function (s) { return s.label + ' ' + s.percent + '% (' + money(s.amount) + ', ' + (s.when === 'signing' ? 'on signing' : s.when === 'date' ? day(s.date) : 'milestone') + ')'; }).join(' · ') }) : null);
  }

  function trailPanel(q) {
    var words = { created: 'Created', sent: 'Sent', viewed: 'Opened by client', edited: 'Edited after sending', accepted: 'Signed', declined: 'Declined', withdrawn: 'Withdrawn', billed: 'Invoices created' };
    return h('div', { class: 'panel' }, h('h2', null, 'Activity'),
      h('ul', { class: 'list' }, (q.events || []).slice().reverse().map(function (e) {
        return h('li', null, h('span', { class: 'grow' }, h('span', { class: 't', text: (words[e.what] || e.what) + (e.to ? ' to ' + e.to : '') + (e.by ? ' by ' + e.by : '') }), h('span', { class: 'm', text: stamp(e.at) + (e.ip ? ' · IP ' + e.ip : '') })));
      })));
  }

  // ---------- editor ----------
  function editorView(id) {
    D.loading();
    Promise.all([desk('GET', '/quotes/' + id), desk('GET', '/catalog'), desk('GET', '/clients')]).then(function (r) {
      var q = JSON.parse(JSON.stringify(r[0].item)); var catalog = r[1].items; var clients = r[2].items;
      if (['accepted', 'declined', 'void'].indexOf(q.status) >= 0) { location.hash = '#/quotes/' + id; return; }
      q.items = q.items || []; q.schedule = q.schedule || []; q.key_dates = q.key_dates || [];
      var services = D.meta().services;
      var err = h('p', { class: 'err', role: 'alert', hidden: true });
      var sumBox = h('div', { class: 'qsum' });

      function inp(obj, key, attrs) {
        var el = h('input', Object.assign({ value: obj[key] == null ? '' : obj[key], autocomplete: 'off' }, attrs || {}));
        el.addEventListener('input', function () { obj[key] = el.value; refresh(); });
        return el;
      }
      function sel(obj, key, options, onchange) {
        var el = h('select', null, options.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(obj[key] || '') === o[0] ? 'selected' : null }); }));
        el.addEventListener('change', function () { obj[key] = el.value; if (onchange) onchange(); refresh(); });
        return el;
      }
      function lbl(text, el, span) { return h('div', { class: 'fld', style: span ? 'grid-column:span ' + span : '' }, h('label', { text: text }), el); }
      function area(key, label, rows, ph) { var el = h('textarea', { rows: rows || 4, maxlength: 3000, placeholder: ph || '' }); el.value = q[key] || ''; el.addEventListener('input', function () { q[key] = el.value; }); return lbl(label, el); }

      // lines
      var lineBody = h('tbody');
      function drawLines() {
        lineBody.innerHTML = '';
        q.items.forEach(function (it, i) {
          var amountCell = h('td', { class: 'lt' });
          var qty = it.pricing === 'fixed' ? inp(it, 'amount', { inputmode: 'decimal', placeholder: '$', 'aria-label': 'Price in dollars' }) : inp(it, 'hours', { inputmode: 'decimal', placeholder: 'h', 'aria-label': 'Hours' });
          var tr = h('tr', null,
            h('td', { class: 'qname' }, inp(it, 'name', { placeholder: 'Phase or service', 'aria-label': 'Name', maxlength: 160 }), inp(it, 'description', { placeholder: 'One-line description', 'aria-label': 'Description', maxlength: 1000, class: 'sub' })),
            h('td', null, inp(it, 'timeline', { placeholder: 'e.g. Weeks 1–2', 'aria-label': 'Timeline', maxlength: 80 })),
            h('td', null, sel(it, 'billing', [['one_time', 'One-Time'], ['monthly', 'Monthly']]), sel(it, 'pricing', [['hours', 'Hourly'], ['fixed', 'Fixed Price']], drawLines)),
            h('td', { class: 'q' }, qty),
            h('td', { class: 'opt' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: it.optional, onchange: function (e) { it.optional = e.target.checked; refresh(); } }), 'Add-On')),
            amountCell,
            h('td', { class: 'x' },
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function () { q.items.splice(i - 1, 0, q.items.splice(i, 1)[0]); drawLines(); } }),
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove line', text: '×', onclick: function () { q.items.splice(i, 1); drawLines(); } })));
          tr._amount = amountCell; tr._it = it;
          lineBody.appendChild(tr);
        });
        refresh();
      }
      function addLine(src) {
        var it = { id: rid(), name: '', description: '', timeline: '', pricing: 'hours', hours: '', amount: '', billing: 'one_time', optional: false, service: '' };
        if (src) ['name', 'description', 'pricing', 'hours', 'amount', 'billing', 'service'].forEach(function (k) { if (src[k] != null) it[k] = src[k]; });
        q.items.push(it); drawLines();
        var rows = lineBody.querySelectorAll('tr'); var last = rows[rows.length - 1]; if (last && !src) last.querySelector('input').focus();
      }
      var catPick = h('select', { 'aria-label': 'Add from service catalog', onchange: function () {
        var c = catalog.filter(function (x) { return x.id === catPick.value; })[0]; if (c) addLine(c); catPick.value = '';
      } }, [h('option', { value: '', text: '+ Add From Catalog…' })].concat(catalog.map(function (c) { return h('option', { value: c.id, text: c.name + ' · ' + (c.pricing === 'fixed' ? dollars(c.amount) : c.hours + ' h') + (c.billing === 'monthly' ? '/mo' : '') }); })));

      // schedule
      var schedBody = h('div', { class: 'sched' }); var schedNote = h('small', { class: 'was' });
      function drawSchedule() {
        schedBody.innerHTML = '';
        q.schedule.forEach(function (s, i) {
          var dateIn = inp(s, 'date', { type: 'date', 'aria-label': 'Date', hidden: s.when !== 'date' });
          schedBody.appendChild(h('div', { class: 'srow' },
            inp(s, 'label', { placeholder: 'Deposit', 'aria-label': 'Payment name', maxlength: 120 }),
            h('div', { class: 'pct' }, inp(s, 'percent', { inputmode: 'decimal', 'aria-label': 'Percent' }), h('span', { text: '%' })),
            sel(s, 'when', WHEN, function () { drawSchedule(); }), dateIn,
            h('span', { class: 'samt' }),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove payment', text: '×', onclick: function () { q.schedule.splice(i, 1); drawSchedule(); } })));
        });
        refresh();
      }
      // key dates
      var keyBody = h('div', { class: 'sched' });
      function drawKeys() {
        keyBody.innerHTML = '';
        q.key_dates.forEach(function (k, i) {
          keyBody.appendChild(h('div', { class: 'srow keys' }, inp(k, 'label', { placeholder: 'e.g. Launch', 'aria-label': 'Key date name', maxlength: 120 }), inp(k, 'date', { type: 'date', 'aria-label': 'Date' }),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove date', text: '×', onclick: function () { q.key_dates.splice(i, 1); drawKeys(); } })));
        });
      }

      var monthlyRow = h('div', { class: 'grid g3', style: 'margin-top:14px' }, lbl('Monthly Services Start', inp(q, 'monthly_start', { type: 'date' })), h('small', { class: 'was', style: 'grid-column:span 2;align-self:end;padding-bottom:12px', text: 'Leave blank to start billing on the day the client signs. Monthly lines aren’t affected by the startup discount.' }));

      function refresh() {
        var all = q.items.filter(function (i) { return i.optional; }).map(function (i) { return i.id; });
        var t = totals(q, []); var ta = totals(q, all);
        Array.prototype.forEach.call(lineBody.children, function (tr) { var a = ta.lines[tr._it.id]; tr._amount.textContent = a ? money(a.amount) + (tr._it.billing === 'monthly' ? '/mo' : '') : ''; });
        var pct = q.schedule.reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0);
        var parts = split(q, t.total);
        Array.prototype.forEach.call(schedBody.children, function (row, i) { row.querySelector('.samt').textContent = parts[i] ? money(parts[i].amount) : ''; var d = row.querySelector('input[type=date]'); d.hidden = q.schedule[i].when !== 'date'; });
        schedNote.textContent = q.schedule.length ? 'Adds up to ' + Math.round(pct * 100) / 100 + '%' + (Math.abs(pct - 100) > 0.001 ? ' (needs to be 100%)' : '') : 'No schedule: the whole project total is due on signing.';
        schedNote.className = 'was' + (q.schedule.length && Math.abs(pct - 100) > 0.001 ? ' bad' : '');
        monthlyRow.hidden = !q.items.some(function (i) { return i.billing === 'monthly'; });
        sumBox.innerHTML = '';
        D.add(sumBox, [
          h('div', null, h('small', { text: 'Standard Price' }), h('s', { text: money(t.standard) }), h('em', { text: t.hours + ' h × $' + (q.standard_rate || 0) })),
          h('div', null, h('small', { text: 'Rate Discount' }), h('b', { text: '−' + money(t.rate_discount) }), h('em', { text: '$' + (q.standard_rate || 0) + ' → $' + (q.rate === '' || q.rate == null ? q.standard_rate : q.rate) + '/hr' })),
          h('div', null, h('small', { text: 'Startup Discount' }), h('b', { text: '−' + money(t.startup_discount) }), h('em', { text: (t.startup_pct || 0) + '% · −' + t.startup_hours + ' h' })),
          h('div', { class: 'your' }, h('small', { text: 'Your Price' }), h('b', { text: money(t.total) }), h('em', { text: (ta.total !== t.total ? 'With all add-ons ' + money(ta.total) : 'Project total') + (t.monthly || ta.monthly ? ' · ' + money(ta.monthly) + '/mo' : '') }))]);
      }

      var clientSel = h('select', { disabled: q.status !== 'draft' ? true : null, onchange: function (e) { q.client_id = e.target.value; } }, clients.slice().sort(function (a, b) { return (a.company || a.name).localeCompare(b.company || b.name); }).map(function (c) { return h('option', { value: c.id, text: c.company || c.name, selected: c.id === q.client_id ? 'selected' : null }); }));

      var form = h('form', { novalidate: true, class: 'qedit' },
        h('div', { class: 'panel' }, h('h2', null, 'Basics'),
          h('div', { class: 'grid g3' },
            lbl('Project Title', inp(q, 'title', { maxlength: 160, required: true }), 2), lbl('Client', clientSel),
            lbl('One-Sentence Description', inp(q, 'summary', { maxlength: 1000, placeholder: 'What the client gets, in a sentence' }), 3),
            lbl('Quote Number', inp(q, 'number', { maxlength: 40 })), lbl('Issued', inp(q, 'issued', { type: 'date' })), lbl('Valid Through', inp(q, 'valid_until', { type: 'date' })),
            lbl('Prepared By', inp(q, 'prepared_by', { maxlength: 120 })))),
        h('div', { class: 'panel' }, h('h2', null, 'Rates & Discounts'),
          h('div', { class: 'grid g4' },
            lbl('Standard Rate ($/hr)', inp(q, 'standard_rate', { inputmode: 'decimal' })), lbl('Client’s Rate ($/hr)', inp(q, 'rate', { inputmode: 'decimal' })),
            lbl('Startup Discount (%)', inp(q, 'startup_discount_pct', { inputmode: 'decimal', placeholder: '0' })), lbl('Invoices Due In (Days)', inp(q, 'days_until_due', { inputmode: 'numeric' })))),
        h('div', { class: 'panel' }, h('div', { class: 'hrow' }, h('h2', null, 'Scope & Pricing'), h('div', { class: 'toolbar', style: 'margin:0' }, catPick, btn('+ Add Line', function () { addLine(null); }, 'ghost'))),
          h('div', { class: 'scroll' }, h('table', { class: 'items qitems' }, h('thead', null, h('tr', null, h('th', { text: 'Phase / Service' }), h('th', { text: 'Timeline' }), h('th', { text: 'Billing' }), h('th', { class: 'q', text: 'Hours / Price' }), h('th', { text: '' }), h('th', { class: 'lt', text: 'Amount' }), h('th', { class: 'x' }))), lineBody)),
          h('small', { class: 'was', text: 'Hourly lines are priced at the client’s rate (standard rate shown struck through). Tick Add-On for optional extras the client can choose when signing.' }),
          monthlyRow, sumBox),
        h('div', { class: 'panel' }, h('div', { class: 'hrow' }, h('h2', null, 'Payment Schedule'), btn('+ Add Payment', function () { q.schedule.push({ label: '', percent: '', when: 'milestone', date: null }); drawSchedule(); }, 'ghost')),
          schedBody, schedNote,
          h('small', { class: 'was', style: 'display:block;margin-top:6px', text: 'On signing: invoiced and emailed the moment they sign. On a date: invoiced that morning. At a milestone: you click Bill Now when it’s reached.' })),
        h('div', { class: 'panel' }, h('div', { class: 'hrow' }, h('h2', null, 'Key Dates'), btn('+ Add Date', function () { q.key_dates.push({ label: '', date: '' }); drawKeys(); }, 'ghost')), keyBody),
        h('div', { class: 'panel' }, h('h2', null, 'Included, Not Included & Notes'),
          h('div', { class: 'grid g2' }, area('included', 'Included', 5, 'One item per line'), area('not_included', 'Not Included', 5, 'One item per line')),
          h('div', { style: 'margin-top:14px' }, area('notes', 'Notes to Client (Optional)', 3))),
        err,
        h('div', { class: 'toolbar', style: 'justify-content:flex-end;margin-top:18px' }, h('a', { class: 'pill ghost', href: '#/quotes/' + q.id, text: 'Cancel' }), h('button', { class: 'pill', type: 'submit', text: 'Save Quote' })));

      form.addEventListener('submit', function (e) {
        e.preventDefault(); err.hidden = true;
        var body = {};
        ['title', 'summary', 'number', 'issued', 'valid_until', 'prepared_by', 'standard_rate', 'rate', 'startup_discount_pct', 'days_until_due', 'included', 'not_included', 'notes', 'monthly_start'].forEach(function (k) { body[k] = q[k] == null ? '' : q[k]; });
        if (q.status === 'draft') body.client_id = q.client_id;
        body.items = q.items.map(function (it) { return { id: it.id, name: it.name, description: it.description, timeline: it.timeline, pricing: it.pricing, hours: it.hours, amount: it.amount, billing: it.billing, optional: it.optional, service: it.service }; });
        body.schedule = q.schedule; body.key_dates = q.key_dates.filter(function (k) { return k.label || k.date; });
        var b = form.querySelector('button[type=submit]'); b.disabled = true;
        desk('PATCH', '/quotes/' + q.id, body).then(function () { toast('Quote saved'); location.hash = '#/quotes/' + q.id; })
          .catch(function (x) { err.textContent = x.message; err.hidden = false; b.disabled = false; err.scrollIntoView({ block: 'center' }); });
      });

      D.render(D.pageHead(h('span', null, q.number + ' ', qbadge(r[0].state)), ['Edit ', h('em', { text: 'Quote' })], null, ['#/quotes/' + q.id, 'Back to Quote']),
        q.status !== 'draft' ? h('p', { class: 'banner', text: 'This quote has been sent. Saving updates what the client sees at their link.' }) : null, form);
      drawLines(); drawSchedule(); drawKeys();
      if (!q.items.length) addLine(null);
    }).catch(D.failed);
  }

  // ---------- service catalog ----------
  function catalogView() {
    D.loading();
    desk('GET', '/catalog').then(function (r) {
      var services = D.meta().services;
      function edit(it) {
        D.modal({ title: it ? 'Edit Catalog Item' : 'New Catalog Item', submit: it ? 'Save Changes' : 'Add to Catalog', values: it || { pricing: 'hours', billing: 'one_time' },
          fields: [
            { name: 'name', label: 'Name' },
            { name: 'description', label: 'Description' },
            { name: 'service', label: 'Service Area', type: 'select', options: [['', '—']].concat(services.map(function (s) { return [s, s]; })) },
            { name: 'billing', label: 'Billing', type: 'select', options: [['one_time', 'One-Time'], ['monthly', 'Monthly']], half: true },
            { name: 'pricing', label: 'Pricing', type: 'select', options: [['hours', 'Hourly'], ['fixed', 'Fixed Price']], half: true },
            { name: 'hours', label: 'Default Hours (Hourly)', inputmode: 'decimal', half: true },
            { name: 'amount', label: 'Price in $ (Fixed)', inputmode: 'decimal', half: true }
          ],
          onSubmit: function (d) { return desk(it ? 'PATCH' : 'POST', '/catalog' + (it ? '/' + it.id : ''), d).then(function () { toast('Catalog saved'); catalogView(); }); } });
      }
      D.render(D.pageHead('Quotes', 'Service Catalog', [btn('New Item', function () { edit(null); })], ['#/quotes', 'All Quotes']),
        h('p', { class: 'was', style: 'margin:0 0 14px', text: 'Saved lines you can drop into any quote. Changing an item here doesn’t change quotes already written.' }),
        r.items.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', { text: 'Item' }), h('th', { text: 'Service Area' }), h('th', { class: 'num', text: 'Price' }), h('th'))),
          h('tbody', null, r.items.map(function (it) {
            return h('tr', null, h('td', { class: 'who' }, h('b', { text: it.name }), h('small', { text: it.description || '' })), h('td', { text: it.service || '—' }),
              h('td', { class: 'num', text: (it.pricing === 'fixed' ? dollars(it.amount) : it.hours + ' h') + (it.billing === 'monthly' ? '/mo' : '') }),
              h('td', { class: 'num' }, h('div', { class: 'rowacts' }, h('button', { type: 'button', text: 'Edit', onclick: function () { edit(it); } }),
                h('button', { class: 'danger', type: 'button', text: 'Delete', onclick: function () { if (D.confirmDelete(it.name + ' from the catalog')) desk('DELETE', '/catalog/' + it.id).then(catalogView); } }))));
          })))) : D.emptyLine('No catalog items yet.'));
    }).catch(D.failed);
  }

  // ---------- terms of service ----------
  function termsView() {
    D.loading();
    desk('GET', '/terms').then(function (r) {
      var cur = r.current;
      var ta = h('textarea', { rows: 26, maxlength: 30000, class: 'terms', 'aria-label': 'Terms of Service' }); ta.value = cur.body;
      var note = h('input', { maxlength: 200, placeholder: 'What changed (for your records)', 'aria-label': 'What changed' });
      var err = h('p', { class: 'err', role: 'alert', hidden: true });
      D.render(D.pageHead('Quotes', 'Terms of Service', null, ['#/quotes', 'All Quotes']),
        h('p', { class: 'banner', text: 'Every quote shows the current version, and each signature records the version that was signed. Saving creates a new version; quotes already signed keep theirs.' }),
        h('div', { class: 'grid', style: 'grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:18px;align-items:start' },
          h('div', { class: 'panel' }, h('h2', null, 'Version ' + cur.version, h('small', { text: 'Since ' + day(cur.created_at) })), ta,
            h('div', { class: 'fld', style: 'margin-top:12px' }, note), err,
            h('div', { class: 'toolbar', style: 'justify-content:flex-end;margin:14px 0 0' }, btn('Save as Version ' + (cur.version + 1), function (e) {
              err.hidden = true; e.target.disabled = true;
              desk('POST', '/terms', { body: ta.value, note: note.value }).then(function (x) { toast('Terms saved as version ' + x.current.version); termsView(); })
                .catch(function (x) { err.textContent = x.message; err.hidden = false; e.target.disabled = false; });
            }))),
          h('div', { class: 'panel' }, h('h2', null, 'History'),
            h('ul', { class: 'list' }, r.versions.map(function (v) {
              return h('li', null, h('span', { class: 'grow' }, h('span', { class: 't', text: 'Version ' + v.version + (v.version === cur.version ? ' (Current)' : '') }), h('span', { class: 'm', text: day(v.created_at) + (v.note ? ' · ' + v.note : '') })),
                v.version !== cur.version ? h('button', { class: 'pill small ghost', type: 'button', text: 'View', onclick: function () { var w = window.open('', '_blank'); if (w) { w.document.title = 'Terms v' + v.version; var pre = w.document.createElement('pre'); pre.style.cssText = 'white-space:pre-wrap;font:15px/1.6 sans-serif;max-width:760px;margin:40px auto'; pre.textContent = v.body; w.document.body.appendChild(pre); } } }) : null);
            })))));
    }).catch(D.failed);
  }

  window.DeskQuotes = { route: route, clientTab: clientTab, newQuote: newQuote };
  // The Desk may have already tried to show #/quotes before this file loaded.
  if (/^#\/quotes/.test(location.hash)) D.route();
})();
