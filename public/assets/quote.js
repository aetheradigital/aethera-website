/* Client quote page: shows the quote, lets the client pick add-ons, read the terms, draw a signature and accept. */
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('t') || '';
  var preview = new URLSearchParams(location.search).get('preview') === '1';
  var $ = function (id) { return document.getElementById(id); };
  var Q = null; var selected = [];

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v; else if (k === 'class') el.className = v; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) return c.forEach(function (x) { add(el, x); }); el.appendChild(c.nodeType ? c : document.createTextNode(String(c))); }
  function money(c) { return (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }); }
  function rate(n) { return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '/hr'; }
  function day(s) { return s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''; }
  function stamp(s) { return new Date(s).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
  function lines(t) { return String(t || '').split(/\n+/).map(function (x) { return x.replace(/^\s*(•|-|\*)\s*/, '').trim(); }).filter(Boolean); }
  function show(id) { ['loading', 'missing', 'view'].forEach(function (x) { $(x).hidden = x !== id; }); }

  // Same math as the server (lib/quotes.js); the server re-checks it when you sign.
  function totals(q, sel) {
    var t = { hours: 0, standard: 0, subtotal: 0, monthly: 0, lines: {} };
    q.items.forEach(function (it) {
      var a = it.pricing === 'fixed' ? { standard: Math.round(it.amount * 100), amount: Math.round(it.amount * 100), hours: 0 }
        : { standard: Math.round(it.hours * q.standard_rate * 100), amount: Math.round(it.hours * q.rate * 100), hours: Number(it.hours) };
      t.lines[it.id] = a;
      if (it.optional && sel.indexOf(it.id) < 0) return;
      if (it.billing === 'monthly') { t.monthly += a.amount; return; }
      t.hours += a.hours; t.standard += a.standard; t.subtotal += a.amount;
    });
    var pct = Number(q.startup_discount_pct) || 0;
    t.rate_discount = t.standard - t.subtotal; t.startup_discount = Math.round(t.subtotal * pct / 100);
    t.startup_hours = Math.round(t.hours * pct) / 100; t.total = t.subtotal - t.startup_discount;
    t.hours_after = Math.round((t.hours - t.startup_hours) * 100) / 100; t.hours = Math.round(t.hours * 100) / 100;
    t.savings = t.rate_discount + t.startup_discount;
    return t;
  }
  function split(q, total) {
    var s = q.schedule.length ? q.schedule : [{ label: 'Due on signing', percent: 100, when: 'signing' }];
    var used = 0;
    if (!total) return [];
    return s.map(function (x, i) { var a = i === s.length - 1 ? total - used : Math.round(total * x.percent / 100); used += a; return Object.assign({}, x, { amount: a }); });
  }
  function whenText(s) { return s.when === 'signing' ? 'On signing' : s.when === 'date' ? day(s.date) : 'At milestone'; }

  // ---------- render ----------
  function render() {
    var q = Q; var done = q.state === 'accepted';
    var sel = done ? (q.acceptance.selected || []) : selected;
    var t = totals(q, sel);
    var doc = $('doc'); doc.innerHTML = '';
    $('view').classList.toggle('done', done);
    var oneTime = q.items.filter(function (it) { return it.billing !== 'monthly' && !it.optional; });
    var addons = q.items.filter(function (it) { return it.optional; });
    var monthly = q.items.filter(function (it) { return it.billing === 'monthly' && (!it.optional || sel.indexOf(it.id) >= 0); });
    var chosenOneTime = q.items.filter(function (it) { return it.billing !== 'monthly' && (!it.optional || sel.indexOf(it.id) >= 0); });
    var discounted = q.rate < q.standard_rate;
    var who = q.client.company || q.client.name;

    add(doc, [
      h('div', { class: 'qtop' }, h('p', { class: 'eyebrow', text: 'Proposal & Quote' }),
        h('div', { class: 'qmeta' }, h('b', { text: 'Quote ' + q.number }), h('br'), 'Issued ' + day(q.issued), q.valid_until ? [h('br'), 'Valid through ' + day(q.valid_until)] : null)),
      h('h1', { id: 'q-title', text: q.title }),
      q.summary ? h('p', { class: 'lede', text: q.summary }) : null,
      h('div', { class: 'parties' },
        h('div', null, h('h3', { text: 'Prepared For' }), h('p', null, q.client.name, q.client.company ? [h('br'), q.client.company] : null)),
        h('div', null, h('h3', { text: 'Prepared By' }), h('p', null, q.prepared_by || 'Aethera Digital', h('br'), 'Aethera Digital', h('br'), h('a', { href: 'mailto:hello@aetheradigital.com', text: 'hello@aetheradigital.com' })))),
      discounted && t.hours ? h('p', { class: 'callout' }, 'Our standard rate is ' + rate(q.standard_rate) + '. For this project, ' + who + '’s rate is ', h('s', { text: rate(q.standard_rate) }), h('b', { text: rate(q.rate) }), '.') : null,
      t.subtotal ? h('div', { class: 'price', 'aria-label': 'Price summary' },
        h('div', null, h('small', { text: 'Standard Price' }), h('s', { text: money(t.standard) }), h('em', { text: t.hours + ' h × ' + rate(q.standard_rate) })),
        h('div', null, h('small', { text: 'Rate Discount' }), h('b', { text: '−' + money(t.rate_discount) }), h('em', { text: discounted ? rate(q.standard_rate) + ' → ' + rate(q.rate) : 'None' })),
        h('div', null, h('small', { text: 'Startup Discount' }), h('b', { text: '−' + money(t.startup_discount) }), h('em', { text: q.startup_discount_pct ? q.startup_discount_pct + '% · −' + t.startup_hours + ' h' : 'None' })),
        h('div', { class: 'you' }, h('small', { text: 'Your Price' }), h('b', { text: money(t.total) }), h('em', { text: t.hours_after + ' h' }))) : null,
      t.savings > 0 ? h('p', { class: 'saves', text: 'You save ' + money(t.savings) + ' on this project.' }) : null,
      q.key_dates.length ? h('ul', { class: 'dates' }, q.key_dates.map(function (k) { return h('li', null, h('b', { text: k.label }), k.date ? day(k.date) : 'TBD'); })) : null,

      chosenOneTime.length ? [h('h2', { text: 'Scope & Pricing' }),
        discounted ? h('p', { class: 'note', text: 'Hours below are at your rate of ' + rate(q.rate) + ' (standard ' + rate(q.standard_rate) + ').' }) : null,
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'Phase' }), h('th', { class: 'num', text: 'Hours' }), h('th', { class: 'num', text: 'Amount' }))),
          h('tbody', null, chosenOneTime.map(function (it) {
            return h('tr', null, h('td', null, h('b', { text: it.name }), it.optional ? h('span', { class: 'badge', text: 'Add-On' }) : null, it.description ? h('span', { class: 'sub', text: it.description }) : null, it.timeline ? h('span', { class: 'sub', text: it.timeline }) : null),
              h('td', { class: 'num', text: it.pricing === 'hours' ? String(it.hours) : '—' }), h('td', { class: 'num', text: money(t.lines[it.id].amount) }));
          }),
          h('tr', null, h('td', { text: 'Subtotal' }), h('td', { class: 'num', text: String(t.hours) }), h('td', { class: 'num', text: money(t.subtotal) })),
          t.startup_discount ? h('tr', { class: 'disc' }, h('td', null, 'Startup Discount ', h('span', { class: 'badge', text: q.startup_discount_pct + '% Off' })), h('td', { class: 'num', text: '−' + t.startup_hours }), h('td', { class: 'num', text: '−' + money(t.startup_discount) })) : null,
          h('tr', { class: 'tot' }, h('td', { text: 'Project Total' }), h('td', { class: 'num', text: String(t.hours_after) }), h('td', { class: 'num', text: money(t.total) }))))] : null,

      addons.length ? [h('h2', { text: 'Optional Add-Ons' }), h('p', { class: 'note', text: done ? 'Add-ons chosen when this quote was signed.' : 'Tick anything you’d like to include. Your total updates as you go.' }),
        h('div', { class: 'addons' }, addons.map(function (it) {
          var on = sel.indexOf(it.id) >= 0; var a = t.lines[it.id];
          var after = it.billing === 'monthly' ? a.amount : Math.round(a.amount * (1 - (Number(q.startup_discount_pct) || 0) / 100));
          var box = h('input', { type: 'checkbox', checked: on, disabled: done, 'aria-label': 'Add ' + it.name, onchange: function (e) {
            if (e.target.checked) selected.push(it.id); else selected = selected.filter(function (x) { return x !== it.id; });
            render();
          } });
          box.checked = on;
          return h('label', { class: 'addon' + (on ? ' on' : ''), 'aria-disabled': done ? 'true' : null }, box,
            h('span', null, h('b', { text: it.name }), it.description ? h('span', { class: 'sub', text: it.description }) : null, it.pricing === 'hours' ? h('span', { class: 'sub', text: it.hours + ' h' }) : null),
            h('span', { class: 'amt' }, a.standard > after ? h('s', { text: money(a.standard) }) : null, money(after) + (it.billing === 'monthly' ? '/mo' : '')));
        }))] : null,

      monthly.length ? [h('h2', { text: 'Monthly Services' }),
        h('table', { class: 'tbl' }, h('tbody', null, monthly.map(function (it) {
          return h('tr', null, h('td', null, h('b', { text: it.name }), it.description ? h('span', { class: 'sub', text: it.description }) : null), h('td', { class: 'num', text: money(t.lines[it.id].amount) + '/mo' }));
        }), h('tr', { class: 'tot' }, h('td', { text: 'Monthly Total' }), h('td', { class: 'num', text: money(t.monthly) + '/mo' })))),
        h('p', { class: 'note', style: 'margin-top:10px', text: 'Billed monthly starting ' + (q.monthly_start && (!done || q.monthly_start > q.acceptance.at.slice(0, 10)) ? day(q.monthly_start) : done ? day(q.acceptance.at) : 'the day you sign') + '. Month-to-month.' })] : null,

      t.total ? [h('h2', { text: 'Payment Schedule' }),
        h('table', { class: 'tbl' }, h('tbody', null, split(q, t.total).map(function (s) {
          return h('tr', null, h('td', null, h('b', { text: s.label }), h('span', { class: 'sub', text: s.percent + '% · ' + whenText(s) })), h('td', { class: 'num', text: money(s.amount) }));
        }))),
        h('p', { class: 'note', style: 'margin-top:10px', text: 'Each payment is invoiced by email and due within ' + q.days_until_due + ' days. Pay by bank account (ACH) or card.' })] : null,

      lines(q.included).length || lines(q.not_included).length ? h('div', { class: 'two', style: 'margin-top:44px' },
        h('div', { class: 'box' }, h('h3', { text: 'Included' }), lines(q.included).length ? h('ul', null, lines(q.included).map(function (x) { return h('li', { text: x }); })) : h('p', { class: 'note', text: 'Everything listed above.' })),
        h('div', { class: 'box' }, h('h3', { text: 'Not Included' }), lines(q.not_included).length ? h('ul', null, lines(q.not_included).map(function (x) { return h('li', { text: x }); })) : h('p', { class: 'note', text: '—' }))) : null,
      q.notes ? [h('h2', { text: 'Notes' }), h('p', { style: 'white-space:pre-line;color:#D6D6DC', text: q.notes })] : null,

      q.terms ? [h('h2', { id: 'terms', text: 'Terms of Service' }), h('p', { class: 'note', text: 'Version ' + q.terms.version }), h('div', { class: 'terms', tabindex: '0', text: q.terms.body })] : null,

      done ? acceptanceBlock(q) : null
    ]);
    renderSide(t);
  }

  function acceptanceBlock(q) {
    var a = q.acceptance;
    var words = { sent: 'Sent to client', viewed: 'Opened by client', accepted: 'Signed by ' + a.name };
    return [h('h2', { text: 'Acceptance' }),
      h('div', { class: 'sigblock' },
        h('div', null, h('div', { class: 'sig' }, h('img', { src: a.signature, alt: 'Signature of ' + a.name })), h('p', null, h('b', { text: a.name }), a.title ? ', ' + a.title : '', h('br'), a.email, h('br'), 'Signed ' + stamp(a.at))),
        h('div', null, h('p', { style: 'margin-top:0' }, h('b', { text: Q.prepared_by || 'Aethera Digital' }), h('br'), 'Aethera Digital', h('br'), 'Issued ' + day(Q.issued)))),
      h('ul', { class: 'trail' }, q.trail.map(function (e) { return h('li', { text: stamp(e.at) + ' · ' + (words[e.what] || e.what) + (e.ip ? ' · IP ' + e.ip : '') }); })),
      h('p', { class: 'fp', text: 'Terms version ' + a.terms_version + ' · Document fingerprint (SHA-256) ' + a.fingerprint })];
  }

  function renderSide(t) {
    var q = Q;
    $('sign').hidden = true; $('closed').hidden = true;
    var acts = $('closed-acts'); acts.innerHTML = '';
    function closed(icon, color, title, text) {
      $('closed').hidden = false; $('closed-icon').style.background = color; $('closed-icon').textContent = icon;
      $('closed-h').innerHTML = title; $('closed-p').textContent = text;
    }
    if (q.state === 'accepted') {
      var first = (q.invoices || []).filter(function (b) { return b.pay_url; });
      closed('✓', '#CFE8B4', 'Signed. <em>Thank you.</em>', 'Signed by ' + q.acceptance.name + ' on ' + stamp(q.acceptance.at) + '. A signed copy was emailed to ' + q.acceptance.email + '.' +
        (first.length ? ' Your ' + first[0].label.toLowerCase() + ' invoice is ready.' : ''));
      first.forEach(function (b, i) { add(acts, h('a', { class: 'pill' + (i ? ' ghost' : ''), href: b.pay_url, text: 'Pay ' + b.label + ' · ' + money(b.amount) })); });
      add(acts, h('button', { class: 'pill ghost', type: 'button', text: 'Print or Save as PDF', onclick: function () { window.print(); } }));
      return;
    }
    if (q.state === 'declined') return closed('×', '#FFB3B3', 'Quote <em>declined.</em>', 'Thanks for letting us know. If anything changes, reply to the quote email or write to hello@aetheradigital.com.');
    if (q.state === 'expired') return closed('!', '#FFC4A8', 'This quote <em>expired.</em>', 'It was valid through ' + day(q.valid_until) + '. Email hello@aetheradigital.com and we’ll send an updated one.');
    $('sign').hidden = false;
    var due = $('due'); due.innerHTML = '';
    var parts = split(q, t.total);
    var now = parts.filter(function (s) { return s.when === 'signing'; }).reduce(function (s, x) { return s + x.amount; }, 0);
    if (t.total) add(due, [h('dt', { text: 'Project Total' }), h('dd', { text: money(t.total) })]);
    if (t.monthly) add(due, [h('dt', { text: 'Monthly' }), h('dd', { text: money(t.monthly) + '/mo' })]);
    if (now) add(due, [h('dt', { text: 'Invoiced on Signing' }), h('dd', { class: 'big', text: money(now) })]);
    $('terms-v').textContent = 'version ' + (q.terms ? q.terms.version : '1');
  }

  // ---------- signature pad ----------
  var pad = $('pad'), ctx = pad.getContext('2d'), inked = 0, drawing = false, last = null;
  function sizePad() {
    var r = pad.getBoundingClientRect(); var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var keep = inked ? pad.toDataURL() : null;
    pad.width = Math.max(1, Math.round(r.width * dpr)); pad.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2.4;
    if (keep) { var img = new Image(); img.onload = function () { ctx.drawImage(img, 0, 0, r.width, r.height); }; img.src = keep; }
  }
  function pos(e) { var r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  pad.addEventListener('pointerdown', function (e) { e.preventDefault(); drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); $('pad-hint').hidden = true; $('pad-wrap').classList.remove('bad'); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill(); });
  pad.addEventListener('pointermove', function (e) {
    if (!drawing) return; var p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    inked += Math.abs(p.x - last.x) + Math.abs(p.y - last.y); last = p;
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { pad.addEventListener(ev, function () { drawing = false; }); });
  $('pad-clear').addEventListener('click', function () { inked = 0; sizePad(); $('pad-hint').hidden = false; });
  window.addEventListener('resize', function () { if (!$('sign').hidden) sizePad(); });

  // ---------- sign ----------
  function fail(msg, el) { var e = $('sign-err'); e.textContent = msg; e.hidden = false; if (el) el.focus(); }
  $('sign-form').addEventListener('submit', function (e) {
    e.preventDefault(); $('sign-err').hidden = true;
    var name = $('s-name').value.trim(), email = $('s-email').value.trim();
    if (name.length < 2) return fail('Type your full name.', $('s-name'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter your email address so we can send your signed copy.', $('s-email'));
    if (inked < 40) { $('pad-wrap').classList.add('bad'); return fail('Draw your signature in the box.'); }
    if (!$('agree-terms').checked) return fail('Please confirm you agree to the quote and the Terms of Service.', $('agree-terms'));
    if (!$('agree-esign').checked) return fail('Please confirm you agree to sign electronically.', $('agree-esign'));
    if (preview) return fail('This is a preview link, so signing is turned off.');
    var t = totals(Q, selected);
    var b = $('sign-btn'); b.disabled = true; b.textContent = 'Signing…';
    fetch('/api/quote/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      t: token, name: name, title: $('s-title').value.trim(), email: email, signature: pad.toDataURL('image/png'),
      agree_terms: true, agree_esign: true, terms_version: Q.terms.version, selected: selected, total_seen: t.total, monthly_seen: t.monthly }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) { var er = new Error(d.error || 'Something went wrong. Please try again.'); er.reload = d.reload; throw er; } return d; }); })
      .then(function (d) { Q = d.quote; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); })
      .catch(function (er) {
        b.disabled = false; b.textContent = 'Sign & Accept Quote'; fail(er.message);
        if (er.reload) { var btn = h('button', { class: 'pill small ghost', type: 'button', text: 'Reload Quote', onclick: function () { location.reload(); } }); $('sign-err').appendChild(h('br')); $('sign-err').appendChild(btn); }
      });
  });
  $('decline').addEventListener('click', function () {
    if (preview) return fail('This is a preview link, so declining is turned off.');
    var reason = window.prompt('Sorry to hear it. Anything we should know? (Optional)', '');
    if (reason === null) return;
    fetch('/api/quote/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, reason: reason }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
      .then(function (d) { Q = d.quote; render(); }).catch(function (er) { fail(er.message); });
  });

  // ---------- load ----------
  fetch('/api/quote?t=' + encodeURIComponent(token) + (preview ? '&preview=1' : ''))
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
    .then(function (d) {
      Q = d.quote; $('testbar').hidden = !d.testMode;
      if (preview) { $('testbar').hidden = false; $('testbar').textContent = 'Preview · signing is off'; }
      document.title = Q.title + ' · Quote ' + Q.number + ' — Aethera Digital';
      if (!$('s-email').value && Q.client.email) $('s-email').value = Q.client.email;
      if (!$('s-name').value && Q.client.name) $('s-name').value = Q.client.name;
      show('view'); render(); sizePad();
    })
    .catch(function (e) { if (e.message) $('missing-msg').textContent = e.message; show('missing'); });
})();
