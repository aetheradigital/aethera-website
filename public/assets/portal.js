/* Aethera client portal: sign-in with an emailed one-time link, then reports, projects, files & approvals, billing and activity. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var WORDMARK = '/assets/wordmark.png';
  var CAT_COLOR = { signin: '#C8B6FF', security: '#FFB3B3', file: '#FFC4A8', approval: '#FFB3D1', report: '#AFCBFF', quote: '#F6E7A1', billing: '#CFE8B4', account: '#C9C9D1' };
  var METRIC = {
    seo_clicks: ['Search clicks', 'n', 1], seo_impressions: ['Search impressions', 'n', 1], seo_avg_position: ['Avg. search position', 'p', -1],
    sessions: ['Website visits', 'n', 1], leads: ['Leads', 'n', 1], revenue: ['Attributed revenue', '$', 1],
    ad_spend: ['Ad spend', '$', 0], ad_clicks: ['Ad clicks', 'n', 1], ad_conversions: ['Ad conversions', 'n', 1],
    social_followers: ['Social followers', 'n', 1], social_engagement: ['Social engagements', 'n', 1],
    health_score: ['Digital Health score', 'n', 1], seo_score: ['SEO score', 'n', 1], aiso_score: ['AI search score', 'n', 1]
  };
  var CHART_PREF = ['leads', 'sessions', 'seo_clicks', 'ad_conversions', 'social_engagement', 'health_score'];
  var TABS = [['overview', 'Overview'], ['reports', 'Reports'], ['projects', 'Projects'], ['files', 'Files'], ['quotes', 'Quotes'], ['billing', 'Billing'], ['activity', 'Activity']];

  var S = { data: null, billing: null, billingErr: null, tab: 'overview', report: null, chartMetric: null, fileFilter: 'all', logFilter: 'all', viewed: {}, changing: null };

  // ---------- tiny DOM helper ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with fixed strings (icons)
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function icon(name, size) {
    var paths = {
      arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', down: '<path d="M12 4v12"/><path d="m6 11 6 6 6-6"/><path d="M4 20h16"/>',
      up: '<path d="M12 20V8"/><path d="m6 13 6-6 6 6"/><path d="M4 4h16"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', check: '<path d="m5 12 5 5 9-10"/>',
      shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>', print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'
    };
    var s = size || 16;
    var span = document.createElement('span');
    span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
    return span.firstChild;
  }
  function toast(msg, bad) { var t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(t._h); t._h = setTimeout(function () { t.className = 'toast'; }, 3200); }
  function api(method, path, body) {
    return fetch('/api/portal' + path, { method: method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401 && path !== '/session') { showLogin(); throw new Error(d.error || 'Please sign in.'); }
          if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
          return d;
        });
      });
  }
  function busy(btn, on, label) {
    if (on) { btn._label = btn.innerHTML; btn.disabled = true; btn.innerHTML = ''; btn.appendChild(h('span', { class: 'spin' })); if (label) btn.appendChild(document.createTextNode(label)); }
    else { btn.disabled = false; if (btn._label !== undefined) btn.innerHTML = btn._label; }
  }

  // ---------- formatting ----------
  function num(v, dec) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: dec || 0 }); }
  function mfmt(k, v) { var t = (METRIC[k] || [k, 'n'])[1]; return t === '$' ? Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : t === 'p' ? num(v, 1) : num(v); }
  function when(iso) {
    var d = new Date(iso); var now = new Date();
    var time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today · ' + time;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday · ' + time;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' · ' + time;
  }
  function day(s) { if (!s) return ''; var d = new Date(s.length === 10 ? s + 'T12:00:00' : s); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function monthShort(p) { var a = p.split('-'); return new Date(Number(a[0]), Number(a[1]) - 1, 15).toLocaleDateString('en-US', { month: 'short' }); }
  function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }
  function ext(name) { var m = /\.([A-Za-z0-9]{1,5})$/.exec(name || ''); return m ? m[1].toUpperCase() : 'FILE'; }
  function tileColor(e) { return { PDF: '#FFC4A8', PNG: '#C8B6FF', JPG: '#C8B6FF', JPEG: '#C8B6FF', SVG: '#C8B6FF', WEBP: '#C8B6FF', ZIP: '#AFCBFF', DOC: '#CFE8B4', DOCX: '#CFE8B4', XLS: '#CFE8B4', XLSX: '#CFE8B4', CSV: '#CFE8B4', MP4: '#FFB3D1', MOV: '#FFB3D1' }[e] || '#E4E4EA'; }
  function lines(text) { return String(text || '').split(/\n+/).map(function (l) { return l.replace(/^\s*(?:[•\-*]|\d+[.)])\s*/, '').trim(); }).filter(Boolean); }
  var STATUS_LABEL = { planned: 'Planned', in_progress: 'In progress', review: 'In review', done: 'Done', on_hold: 'On hold', pending: 'Awaiting you', approved: 'Approved', changes: 'Changes requested', declined: 'Declined',
    open: 'Open', overdue: 'Overdue', paid: 'Paid', void: 'Void', uncollectible: 'Uncollectible',
    sent: 'Ready to sign', viewed: 'Ready to sign', accepted: 'Signed', expired: 'Expired' };
  var PRIVACY_URL = 'https://aetheradigital.com/privacy/';
  function badge(s) { return h('span', { class: 'badge ' + s, text: STATUS_LABEL[s] || s }); }

  // ---------- sign in ----------
  function authShell(card) {
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'auth' },
      h('img', { class: 'logo', src: WORDMARK, alt: 'æthera' }),
      h('div', { class: 'mid' }, h('section', { class: 'card' }, card)),
      h('p', { class: 'note' }, 'Need help? ', h('a', { href: 'mailto:hello@aetheradigital.com', text: 'hello@aetheradigital.com' }), ' · ', h('a', { href: PRIVACY_URL, text: 'Privacy Policy' }))));
  }
  function showLogin(message, email) {
    document.title = 'Sign In — Aethera Client Portal';
    var input = h('input', { id: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com', required: true, value: email || '' });
    var err = h('p', { class: 'err', role: 'alert', hidden: !message, text: message || '' });
    var submit = h('button', { class: 'pill block', type: 'submit' }, 'Email me a sign-in link', icon('arrow'));
    var form = h('form', { class: 'stack', novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v)) { err.textContent = 'Enter the email address on file for your account.'; err.hidden = false; input.focus(); return; }
      err.hidden = true; busy(submit, true, 'Sending…');
      api('POST', '/login', { email: v }).then(function () { showSent(v); }).catch(function (x) { busy(submit, false); err.textContent = x.message; err.hidden = false; });
    } },
      h('p', { class: 'eyebrow', text: 'Aethera Digital · Client portal' }),
      h('h1', null, 'Your ', h('em', { text: 'client' }), ' portal.'),
      h('p', { class: 'lead', text: 'Reports, projects, files, approvals and billing in one place. Enter the email we have on file and we’ll send you a secure sign-in link. No password needed.' }),
      h('div', { class: 'fld' }, h('label', { for: 'email', text: 'Email address' }), input),
      err, submit,
      h('p', { class: 'note' }, icon('lock', 14), 'Links expire in 15 minutes and work once.'));
    authShell(form);
    setTimeout(function () { input.focus(); }, 60);
  }
  function showSent(email) {
    var resend = h('button', { class: 'link', type: 'button', text: 'Resend link', onclick: function () {
      api('POST', '/login', { email: email }).then(function () { toast('A new link is on its way'); }).catch(function (x) { toast(x.message, true); });
    } });
    authShell(h('div', { class: 'stack center' },
      h('div', { class: 'bubble' }, icon('mail', 30)),
      h('h1', null, 'Check your ', h('em', { text: 'inbox' }), '.'),
      h('p', { class: 'lead' }, 'If ', h('strong', { style: 'color:#fff', text: email }), ' has portal access, a sign-in link is on its way. It expires in 15 minutes and can only be used once.'),
      h('p', { class: 'note', text: 'Don’t see it? Check spam, or ask us to confirm which email is on file.' }),
      h('div', { style: 'display:flex;gap:20px;justify-content:center;flex-wrap:wrap' }, resend,
        h('button', { class: 'link', type: 'button', text: 'Use a different email', onclick: function () { showLogin('', email); } }))));
  }
  // The emailed link lands here with ?t=. Signing in takes one click, so email security scanners that open links can't use it up.
  function showContinue(t) {
    document.title = 'Sign In — Aethera Client Portal';
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var go = h('button', { class: 'pill block', type: 'button', onclick: function () {
      busy(go, true, 'Signing in…');
      api('POST', '/verify', { token: t }).then(function () { history.replaceState(null, '', location.pathname); loadApp(); })
        .catch(function (x) { history.replaceState(null, '', location.pathname); showLogin(x.message); });
    } }, 'Continue to your portal', icon('arrow'));
    authShell(h('div', { class: 'stack center' },
      h('div', { class: 'bubble' }, icon('lock', 28)),
      h('h1', null, 'Welcome ', h('em', { text: 'back' }), '.'),
      h('p', { class: 'lead', text: 'Your sign-in link is ready. Continue to open your portal on this device.' }), err, go));
    setTimeout(function () { go.focus(); }, 60);
  }

  // ---------- app shell ----------
  function loadApp() {
    app.innerHTML = ''; app.appendChild(h('div', { class: 'dots center', 'aria-label': 'Loading' }, h('span'), h('span'), h('span')));
    return api('GET', '/data').then(function (d) {
      S.data = d;
      if (!S.report && d.reports.length) S.report = d.reports[0].id;
      loadBilling();
      route();
    }).catch(function (x) { if (!/sign in/i.test(x.message)) showLogin(x.message); });
  }
  function loadBilling() {
    return api('GET', '/billing').then(function (b) { S.billing = b; S.billingErr = null; refreshShell(); }).catch(function (x) { S.billingErr = x.message; refreshShell(); });
  }
  function refreshShell() { if (S.data && app.querySelector('.top')) route(); }
  function counts() {
    var d = S.data; var b = S.billing;
    return { files: d.approvals.filter(function (a) { return a.status === 'pending'; }).length, quotes: (d.quotes || []).filter(awaitingQuote).length, billing: b ? b.open_count : 0 };
  }
  function route() {
    var tab = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'overview';
    if (!TABS.some(function (t) { return t[0] === tab; })) tab = 'overview';
    S.tab = tab;
    var d = S.data; var c = counts();
    document.title = (TABS.filter(function (t) { return t[0] === tab; })[0][1]) + ' — ' + d.client.name + ' · Aethera Client Portal';
    var nav = h('nav', { class: 'tabs', 'aria-label': 'Portal sections' }, TABS.map(function (t) {
      return h('a', { class: 'tab', href: '#' + t[0], 'aria-current': t[0] === tab ? 'page' : null }, t[1], c[t[0]] ? h('span', { class: 'count', text: String(c[t[0]]), 'aria-label': c[t[0]] + ' waiting' }) : null);
    }));
    var top = h('header', { class: 'top' }, h('div', { class: 'navbar' },
      h('a', { class: 'brand', href: '#overview', 'aria-label': 'Portal home' }, h('img', { src: WORDMARK, alt: 'æthera' })),
      nav,
      h('div', { class: 'who' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(d.client.name) }), h('span', { class: 'name', text: d.client.name }),
        h('button', { class: 'pill ghost small', type: 'button', text: 'Sign out', onclick: signOut }))));
    var view = { overview: overview, reports: reports, projects: projects, files: files, quotes: quotes, billing: billing, activity: activity }[tab]();
    var foot = h('footer', { class: 'foot' }, h('p', null, '© ' + new Date().getFullYear() + ' Aethera Digital · Questions? ', h('a', { href: 'mailto:hello@aetheradigital.com', text: 'hello@aetheradigital.com' }), ' · ', h('a', { href: PRIVACY_URL, text: 'Privacy Policy' })),
      S.billing && S.billing.test_mode ? h('span', { class: 'testbar', text: 'Test mode · no real charges' }) : null);
    var y = window.scrollY;
    app.innerHTML = '';
    app.appendChild(top); app.appendChild(h('main', { id: 'main', tabindex: '-1' }, view, foot));
    if (route._last === tab) window.scrollTo(0, y); else window.scrollTo(0, 0);
    route._last = tab;
  }
  window.addEventListener('hashchange', function () { if (S.data) route(); });
  function signOut() {
    api('POST', '/logout', {}).catch(function () {}).then(function () { S.data = null; S.billing = null; location.hash = ''; showLogin('', ''); toast('You’re signed out'); });
  }
  function head(eyebrow, title, aside) {
    return h('div', { class: 'head' }, h('div', { class: 't' }, h('p', { class: 'eyebrow', text: eyebrow }), title), aside || null);
  }
  function feed(items) {
    if (!items.length) return h('p', { class: 'empty', text: 'Nothing yet.' });
    return h('ul', { class: 'feed' }, items.map(function (e) {
      return h('li', null, h('span', { class: 'dot', style: 'background:' + (CAT_COLOR[e.category] || '#fff') }),
        h('div', { class: 'txt' }, h('b', { text: e.event }), h('small', { text: e.detail })), h('time', { datetime: e.at, text: when(e.at) }));
    }));
  }

  // ---------- overview ----------
  function overview() {
    var d = S.data; var b = S.billing;
    var pending = d.approvals.filter(function (a) { return a.status === 'pending'; });
    var latest = d.reports[0];
    var cards = [];
    cards.push(h('div', { class: 'card hov stat' }, h('p', { class: 'eyebrow', text: 'Balance due' }),
      h('p', { class: 'big', text: b ? b.balance_text : S.billingErr ? '—' : '…' }),
      h('p', { class: 'sub', text: b ? (b.open_count ? b.open_count + (b.open_count === 1 ? ' open invoice' : ' open invoices') : 'You’re all paid up') : S.billingErr || 'Loading invoices' }),
      h('div', { class: 'act' }, h('a', { class: 'pill small' + (b && b.open_count ? '' : ' ghost'), href: '#billing', text: b && b.open_count ? 'Pay now' : 'View invoices' }))));
    cards.push(h('div', { class: 'card hov stat' }, h('p', { class: 'eyebrow', text: 'Waiting on you' }),
      h('p', { class: 'big', text: String(pending.length) }),
      h('p', { class: 'sub', text: pending.length ? (pending.length === 1 ? 'item needs your review' : 'items need your review') : 'Nothing needs you right now' }),
      h('div', { class: 'act' }, h('a', { class: 'pill ghost small', href: '#files', text: pending.length ? 'Review now' : 'Open files' }))));
    var toSign = (d.quotes || []).filter(awaitingQuote);
    if (toSign.length) {
      var q0 = toSign[0];
      cards.push(h('div', { class: 'card hov stat' }, h('p', { class: 'eyebrow', text: toSign.length === 1 ? 'Quote ready to sign' : toSign.length + ' quotes ready to sign' }),
        h('p', { class: 'big', style: 'font-size:34px', text: q0.total_text || q0.monthly_text || q0.number }),
        h('p', { class: 'sub', text: q0.title + (q0.valid_until ? ' · valid through ' + day(q0.valid_until) : '') }),
        h('div', { class: 'act' }, h('a', { class: 'pill small', href: '#quotes', text: 'Review quote' }))));
    }
    if (latest) {
      var key = chartKey(latest);
      var series = key ? seriesFor(key) : [];
      var change = key ? delta(key, latest) : null;
      cards.push(h('div', { class: 'card hov stat' }, h('p', { class: 'eyebrow', text: 'Latest report · ' + latest.label.split(' ')[0] }),
        series.length ? h('div', { class: 'minibars', 'aria-hidden': 'true' }, series.map(function (pt, i) { return h('div', { class: i === series.length - 1 ? 'on' : '', style: 'height:' + pt.h + '%' }); })) : null,
        h('p', { class: 'sub' }, key ? h('span', { style: 'color:#fff;font-weight:700', text: METRIC[key][0] + ' ' + mfmt(key, latest.metrics[key]) }) : 'Your latest monthly report',
          change ? h('span', { text: ' · ' + change.text + ' vs. last month' }) : null),
        h('div', { class: 'act' }, h('a', { class: 'pill ghost small', href: '#reports', text: 'Open report' }))));
    }
    if (d.health) {
      var dash = Math.max(0, Math.min(100, d.health.score)) / 100 * 213.6;
      var ring = document.createElement('span');
      ring.innerHTML = '<svg width="84" height="84" viewBox="0 0 84 84" role="img" aria-label="Digital Health score ' + Math.round(d.health.score) + ' out of 100"><circle cx="42" cy="42" r="34" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="8"/><circle cx="42" cy="42" r="34" fill="none" stroke="#CFE8B4" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' 213.6" transform="rotate(-90 42 42)"/><text x="42" y="48" text-anchor="middle" fill="#fff" font-family="Raleway, sans-serif" font-size="22" font-weight="300">' + Math.round(d.health.score) + '</text></svg>';
      cards.push(h('div', { class: 'card hov stat' }, h('p', { class: 'eyebrow', text: 'Digital Health score' }),
        h('div', { class: 'ring' }, ring.firstChild, h('p', { text: 'Search and AI readiness.' + (d.health.change ? ' ' + (d.health.change > 0 ? 'Up ' : 'Down ') + Math.abs(Math.round(d.health.change)) + ' since last month.' : '') }))));
    }
    var active = d.projects.filter(function (p) { return p.status !== 'done'; });
    return h('div', { class: 'view' },
      head(d.client.name + ' · Client portal', h('h1', { class: 'xl' }, 'Welcome back. Here’s where things ', h('em', { text: 'stand' }), '.'),
        h('p', { text: 'Everything Aethera is working on for you, updated as it happens.' })),
      h('div', { class: 'grid g4' }, cards),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:20px' },
          h('div', { class: 'ptitle' }, h('h2', null, 'Projects in ', h('em', { text: 'motion' })), h('a', { class: 'link', href: '#projects', text: 'All projects' })),
          active.length ? active.slice(0, 5).map(function (p) {
            var pr = progress(p);
            return h('div', { class: 'prog' }, h('div', { class: 'row' }, h('b', { text: p.name }), h('span', { class: 'mute', text: STATUS_LABEL[p.status] + (pr.t ? ' · ' + pr.pct + '%' : '') })),
              h('div', { class: 'bar' }, h('span', { style: 'width:' + pr.pct + '%' })));
          }) : h('p', { class: 'empty', text: 'No active projects right now.' })),
        h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' },
          h('div', { class: 'ptitle' }, h('h2', null, 'Recent ', h('em', { text: 'activity' })), h('a', { class: 'link', href: '#activity', text: 'Full activity log' })),
          feed(d.activity.slice(0, 6)))));
  }
  function progress(p) { var t = p.tasks.length; var dn = p.tasks.filter(function (x) { return x.done; }).length; return { t: t, d: dn, pct: t ? Math.round(dn / t * 100) : (p.status === 'done' ? 100 : 0) }; }

  // ---------- reports ----------
  function chartKey(r) { for (var i = 0; i < CHART_PREF.length; i++) if (typeof r.metrics[CHART_PREF[i]] === 'number') return CHART_PREF[i]; var k = Object.keys(r.metrics)[0]; return k && METRIC[k] ? k : null; }
  function seriesFor(key, uptoPeriod) {
    var list = S.data.reports.filter(function (r) { return typeof r.metrics[key] === 'number' && (!uptoPeriod || r.period <= uptoPeriod); }).slice(0, 6).reverse();
    var max = Math.max.apply(null, list.map(function (r) { return Math.abs(r.metrics[key]); }).concat([0]));
    return list.map(function (r) { return { v: r.metrics[key], m: monthShort(r.period), period: r.period, h: max ? Math.max(4, Math.round(Math.abs(r.metrics[key]) / max * 100)) : 4 }; });
  }
  function delta(key, r) {
    var prev = S.data.reports.filter(function (x) { return x.period < r.period && typeof x.metrics[key] === 'number'; })[0];
    if (!prev || typeof r.metrics[key] !== 'number') return null;
    var a = prev.metrics[key]; var b = r.metrics[key];
    var dir = METRIC[key] ? METRIC[key][2] : 1;
    var cls = b === a ? 'flat' : dir === 0 ? 'flat' : ((b > a) === (dir > 0) ? 'good' : 'bad');
    var text = METRIC[key] && METRIC[key][1] === 'p' ? (b < a ? '▲ ' : b > a ? '▼ ' : '') + num(Math.abs(b - a), 1) : (a ? (b >= a ? '+' : '−') + num(Math.abs((b - a) / a * 100)) + '%' : (b >= a ? '+' : '−') + mfmt(key, Math.abs(b - a)));
    return { cls: cls, text: text };
  }
  function reports() {
    var d = S.data;
    if (!d.reports.length) return h('div', { class: 'view' }, head('Monthly reporting', h('h1', null, 'Your ', h('em', { text: 'reports' }), '.')),
      h('div', { class: 'card emptycard' }, h('p', { class: 'empty', text: 'Your first monthly report will appear here as soon as it’s ready.' })));
    var r = d.reports.filter(function (x) { return x.id === S.report; })[0] || d.reports[0];
    S.report = r.id;
    if (!S.viewed[r.id]) { S.viewed[r.id] = true; api('POST', '/event', { type: 'report_view', id: r.id }).catch(function () {}); }
    var keys = Object.keys(r.metrics).filter(function (k) { return METRIC[k]; });
    if (!S.chartMetric || typeof r.metrics[S.chartMetric] !== 'number') S.chartMetric = chartKey(r);
    var series = S.chartMetric ? seriesFor(S.chartMetric, r.period) : [];
    var groups = d.metric_groups.map(function (g) {
      var ks = g.metrics.filter(function (k) { return typeof r.metrics[k] === 'number'; });
      if (!ks.length) return null;
      return h('div', { class: 'group' }, h('h3', { text: g.label }), h('div', { class: 'kpis' }, ks.map(function (k) {
        var dl = delta(k, r);
        return h('div', { class: 'kpi' }, h('span', { class: 'k', text: METRIC[k][0] }), h('span', { class: 'v', text: mfmt(k, r.metrics[k]) }),
          dl ? h('span', { class: 'd ' + dl.cls }, dl.text + ' ', h('span', { text: 'vs. last month' })) : h('span', { class: 'd flat', text: '—' }));
      })));
    }).filter(Boolean);
    var wins = lines(r.wins); var next = lines(r.next_actions);
    return h('div', { class: 'view' },
      head('Monthly reporting', h('h1', null, 'Your ', h('em', { text: 'reports' }), '.')),
      h('div', { class: 'split' },
        h('div', { class: 'rlist', role: 'list' }, d.reports.map(function (x) {
          var k = chartKey(x); var dl = k ? delta(k, x) : null;
          return h('button', { class: 'ritem', type: 'button', role: 'listitem', 'aria-current': x.id === r.id ? 'true' : 'false', onclick: function () { S.report = x.id; route(); } },
            h('b', { text: x.label }), dl ? h('span', { class: 'up', style: dl.cls === 'bad' ? 'color:#FFC4A8' : '', text: METRIC[k][0] + ' ' + dl.text }) : null,
            x.sent_at ? h('small', { text: 'Shared ' + day(x.sent_at) }) : null);
        })),
        h('div', { class: 'card rdetail' },
          h('div', { class: 'head' }, h('div', { class: 't' }, h('p', { class: 'eyebrow', text: 'Monthly report' }), h('h2', { style: 'font-size:40px', text: r.label })),
            h('button', { class: 'pill ghost small noprint', type: 'button', onclick: function () { window.print(); } }, icon('print'), 'Print or save PDF')),
          groups.length ? groups : h('p', { class: 'empty', text: 'No numbers in this report.' }),
          series.length > 1 ? h('div', null,
            h('div', { class: 'head', style: 'align-items:center' }, h('p', { class: 'eyebrow', text: METRIC[S.chartMetric][0] + ' by month' }),
              h('div', { class: 'metricpick noprint' }, keys.filter(function (k) { return seriesFor(k, r.period).length > 1; }).slice(0, 6).map(function (k) {
                return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === S.chartMetric), text: METRIC[k][0], onclick: function () { S.chartMetric = k; route(); } });
              }))),
            h('div', { class: 'chart', role: 'img', 'aria-label': METRIC[S.chartMetric][0] + ' by month: ' + series.map(function (p) { return p.m + ' ' + mfmt(S.chartMetric, p.v); }).join(', ') },
              series.map(function (p) { return h('div', { class: 'col' + (p.period === r.period ? ' on' : '') }, h('b', { text: mfmt(S.chartMetric, p.v) }), h('i', { style: 'height:' + p.h + '%' }), h('small', { text: p.m })); }))) : null,
          h('div', { class: 'callouts' },
            r.summary ? h('div', { class: 'callout lav' }, h('p', { class: 'eyebrow', text: 'What this means' }), h('p', { class: 'body', text: r.summary })) : null,
            wins.length ? h('div', { class: 'callout' }, h('p', { class: 'eyebrow', text: 'Wins' }), h('ul', { class: 'feed' }, wins.map(function (w) { return h('li', null, h('span', { class: 'dot', style: 'background:#CFE8B4' }), h('div', { class: 'txt' }, h('span', { text: w }))); }))) : null,
            next.length ? h('div', { class: 'callout' }, h('p', { class: 'eyebrow', text: 'Next actions' }), h('ol', { class: 'steps' }, next.map(function (n) { return h('li', null, h('span', { text: n })); }))) : null))));
  }

  // ---------- projects ----------
  function projects() {
    var d = S.data;
    return h('div', { class: 'view' },
      head('Work in progress', h('h1', null, 'Your ', h('em', { text: 'projects' }), '.')),
      d.projects.length ? d.projects.map(function (p) {
        var pr = progress(p);
        return h('div', { class: 'card proj' },
          h('div', { class: 'ph' }, h('div', null, h('h2', { text: p.name }),
            h('p', { class: 'meta', text: [pr.t ? pr.d + ' of ' + pr.t + ' steps done' : null, p.due ? 'Target ' + day(p.due) : null].filter(Boolean).join(' · ') || ' ' })), badge(p.status)),
          p.description ? h('p', { class: 'mute', style: 'margin:0;font-size:15px;white-space:pre-line', text: p.description }) : null,
          h('div', { class: 'bar' }, h('span', { style: 'width:' + pr.pct + '%' })),
          p.tasks.length ? h('ul', { class: 'tasks' }, p.tasks.map(function (t) {
            return h('li', { class: t.done ? 'done' : '' }, h('span', { class: 'tick', 'aria-hidden': 'true' }, t.done ? icon('check', 12) : null), h('span', { text: t.title }), h('span', { class: 'sr', text: t.done ? ' (done)' : ' (to do)' }));
          })) : null);
      }) : h('div', { class: 'card emptycard' }, h('p', { class: 'empty', text: 'Projects will show up here once they kick off.' })));
  }

  // ---------- files & approvals ----------
  function fileUrl(id) { return '/api/portal/files/' + encodeURIComponent(id); }
  function upload(list) {
    var arr = Array.prototype.slice.call(list || []); if (!arr.length) return;
    var limit = S.data.files_limit === '50 MB' ? 50 * 1048576 : 15 * 1048576;
    var big = arr.filter(function (f) { return f.size > limit; });
    if (big.length) { toast(big[0].name + ' is over ' + S.data.files_limit, true); return; }
    toast('Uploading ' + arr.length + ' file' + (arr.length > 1 ? 's' : '') + '…');
    arr.reduce(function (p, f) {
      return p.then(function () {
        return fetch('/api/portal/files?name=' + encodeURIComponent(f.name), { method: 'POST', body: f, credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream' } })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (x) { if (!r.ok) throw new Error(x.error || 'Upload failed'); S.data.files.unshift(x.file); }); });
      });
    }, Promise.resolve()).then(function () { toast('Uploaded. Aethera can see ' + (arr.length > 1 ? 'them' : 'it') + ' now.'); refreshData(); }).catch(function (x) { toast(x.message, true); refreshData(); });
  }
  function refreshData() { return api('GET', '/data').then(function (d) { S.data = d; route(); }).catch(function () {}); }
  function decide(a, action, comment, btn) {
    if (btn) busy(btn, true);
    api('POST', '/approvals/' + a.id, { action: action, comment: comment || '' }).then(function () {
      S.changing = null; toast(action === 'approve' ? 'Thanks. Aethera has your approval.' : 'Your notes were sent to Aethera'); refreshData();
    }).catch(function (x) { if (btn) busy(btn, false); toast(x.message, true); });
  }
  function approvalCard(a) {
    var isPending = a.status === 'pending';
    var body = [];
    if (a.file) body.push(h('a', { class: 'link', href: fileUrl(a.file.id) }, icon('down', 14), ' ', a.file.name + ' · ' + size(a.file.size)));
    if (a.comment) body.push(h('p', { class: 'quote', text: '“' + a.comment + '”' }));
    if (isPending && S.changing === a.id) {
      var ta = h('textarea', { id: 'note-' + a.id, placeholder: 'e.g. Try the darker roof photo in the hero', maxlength: '3000' });
      var send = h('button', { class: 'pill small', type: 'button', text: 'Send to Aethera', onclick: function () {
        if (!ta.value.trim()) { ta.focus(); toast('Tell us what should change', true); return; }
        decide(a, 'changes', ta.value.trim(), send);
      } });
      body.push(h('div', { class: 'fld' }, h('label', { for: 'note-' + a.id, text: 'What should change?' }), ta));
      body.push(h('div', { class: 'acts' }, send, h('button', { class: 'pill ghost small', type: 'button', text: 'Cancel', onclick: function () { S.changing = null; route(); } })));
      setTimeout(function () { ta.focus(); }, 30);
    } else if (isPending) {
      var ok = h('button', { class: 'pill small', type: 'button', text: a.kind === 'access' ? 'Mark as done' : 'Approve', onclick: function () { decide(a, 'approve', '', ok); } });
      body.push(h('div', { class: 'acts' }, ok, h('button', { class: 'pill ghost small', type: 'button', text: a.kind === 'access' ? 'I need help' : 'Request changes', onclick: function () { S.changing = a.id; route(); } })));
    }
    return h('div', { class: 'card appr' },
      h('div', { class: 'ah' }, h('div', null, h('p', { class: 'eyebrow', style: 'margin-bottom:6px', text: a.kind === 'decision' ? 'Decision' : a.kind === 'access' ? 'Access request' : 'Approval' }), h('h3', { text: a.title })), badge(a.status)),
      h('p', { class: 'mute', style: 'margin:0;font-size:13px', text: isPending ? (a.requested ? 'Requested ' + day(a.requested) : '') : (a.decided ? 'Decided ' + day(a.decided) : '') }),
      body);
  }
  function files() {
    var d = S.data;
    var pending = d.approvals.filter(function (a) { return a.status === 'pending'; });
    var decided = d.approvals.filter(function (a) { return a.status !== 'pending'; });
    var list = d.files.filter(function (f) { return S.fileFilter === 'all' || f.uploaded_by === S.fileFilter; });
    var input = h('input', { type: 'file', id: 'file-in', multiple: true, class: 'sr', onchange: function (e) { upload(e.target.files); e.target.value = ''; } });
    var drop = h('div', { class: 'drop' }, 'Drag files here or ', h('label', { for: 'file-in', text: 'choose files' }), ' to send them to Aethera (up to ' + d.files_limit + ' each).', input);
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('on'); }); });
    drop.addEventListener('drop', function (e) { upload(e.dataTransfer.files); });
    return h('div', { class: 'view' },
      head('Files & approvals', h('h1', null, 'Your ', h('em', { text: 'files' }), '.'),
        h('label', { class: 'pill small', for: 'file-in-top' }, icon('up'), 'Upload a file', h('input', { type: 'file', id: 'file-in-top', multiple: true, class: 'sr', onchange: function (e) { upload(e.target.files); e.target.value = ''; } }))),
      pending.length ? h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, h('h2', { style: 'font-size:28px' }, 'Waiting on ', h('em', { text: 'you' })), h('div', { class: 'grid g2' }, pending.map(approvalCard))) : null,
      h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
        h('div', { class: 'head', style: 'align-items:center' }, h('h2', { style: 'font-size:28px' }, 'Shared ', h('em', { text: 'files' })),
          h('div', { class: 'chips' }, [['all', 'All files'], ['aethera', 'From Aethera'], ['client', 'Uploaded by you']].map(function (c) {
            return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.fileFilter === c[0]), text: c[1], onclick: function () { S.fileFilter = c[0]; route(); } });
          }))),
        list.length ? h('div', { class: 'grid gfiles' }, list.map(function (f) {
          var e = ext(f.name);
          return h('div', { class: 'card hov fcard' },
            h('div', { class: 'fh' }, h('span', { class: 'ftile', style: 'background:' + tileColor(e), text: e.slice(0, 4) }),
              h('div', null, h('b', { text: f.name }), h('small', { text: size(f.size) + ' · ' + day(f.created_at) + ' · ' + (f.uploaded_by === 'client' ? 'Uploaded by you' : 'From Aethera') }))),
            h('div', { class: 'acts' }, h('a', { class: 'pill ghost small', href: fileUrl(f.id) }, icon('down'), 'Download')));
        })) : h('div', { class: 'card emptycard' }, h('p', { class: 'empty', text: S.fileFilter === 'client' ? 'You haven’t uploaded anything yet.' : 'Files Aethera shares with you will appear here.' })),
        drop),
      decided.length ? h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, h('h2', { style: 'font-size:28px' }, 'Past ', h('em', { text: 'decisions' })), h('div', { class: 'grid g2' }, decided.slice(0, 12).map(approvalCard))) : null,
      h('p', { class: 'note', style: 'justify-content:flex-start' }, icon('lock', 14), 'Files are stored privately. Download links are created for you and expire after 10 minutes.'));
  }

  // ---------- quotes ----------
  function awaitingQuote(q) { return q.state === 'sent' || q.state === 'viewed'; }
  function quotes() {
    var list = S.data.quotes || [];
    return h('div', { class: 'view' },
      head('Proposals', h('h1', null, 'Your ', h('em', { text: 'quotes' }), '.'),
        h('p', { text: 'Review the scope, choose any add-ons, read the terms and sign online. Signed copies are saved under Files.' })),
      list.length ? h('div', { class: 'grid g2' }, list.map(function (q) {
        var waiting = awaitingQuote(q);
        var amount = [q.total_text, q.monthly_text].filter(Boolean).join(' + ');
        var meta = q.state === 'accepted' ? 'Signed ' + day(q.signed_at) + (q.signed_by ? ' by ' + q.signed_by : '')
          : q.state === 'declined' ? 'Declined ' + day(q.declined_at)
          : q.state === 'expired' ? 'Expired ' + day(q.valid_until)
          : (q.sent_at ? 'Sent ' + day(q.sent_at) : '') + (q.valid_until ? ' · valid through ' + day(q.valid_until) : '');
        return h('div', { class: 'card hov', style: 'display:flex;flex-direction:column;gap:16px' },
          h('div', { class: 'ptitle', style: 'align-items:flex-start' }, h('div', null, h('p', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'Quote ' + q.number }), h('h2', { style: 'font-size:28px', text: q.title })),
            h('span', { style: 'flex:none' }, badge(q.state === 'viewed' ? 'sent' : q.state))),
          amount ? h('p', { style: 'margin:0;font-family:Raleway,sans-serif;font-weight:300;font-size:40px;line-height:1', text: amount }) : null,
          h('p', { class: 'mute', style: 'margin:0;font-size:14px', text: meta }),
          h('div', { class: 'acts' }, h('a', { class: 'pill small' + (waiting ? '' : ' ghost'), href: '/api/portal/quotes/' + encodeURIComponent(q.id), target: '_blank', rel: 'noopener',
            onclick: function () { setTimeout(refreshData, 4000); } }, waiting ? 'Review & sign' : q.state === 'accepted' ? 'View signed quote' : 'View quote', icon('arrow')),
            q.state === 'accepted' ? h('a', { class: 'pill small ghost', href: '/api/portal/quotes/' + encodeURIComponent(q.id) + '/pdf', download: '' }, 'Download PDF') : null));
      })) : h('div', { class: 'card emptycard' }, h('p', { class: 'empty', text: 'Quotes we send you will appear here.' })));
  }

  // ---------- billing ----------
  var stripeP = null;
  function stripeReady() {
    if (!stripeP) stripeP = window.AetheraPay.config().then(function (cfg) {
      if (!cfg.enabled || !cfg.publishableKey) throw new Error('Online payments aren’t available right now.');
      return new Promise(function (resolve, reject) {
        var tries = 0; (function wait() { if (window.Stripe) return resolve(window.Stripe(cfg.publishableKey)); if (++tries > 100) return reject(new Error('Couldn’t load the secure payment form. Check your connection and try again.')); setTimeout(wait, 100); })();
      });
    }).catch(function (e) { stripeP = null; throw e; });
    return stripeP;
  }
  function billing() {
    var b = S.billing;
    var heading = head('Billing', h('h1', null, 'Invoices & ', h('em', { text: 'payments' }), '.'));
    if (!b) return h('div', { class: 'view' }, heading, S.billingErr ? h('div', { class: 'card' }, h('p', { class: 'err', text: S.billingErr }), h('p', null, h('button', { class: 'pill small', type: 'button', text: 'Try again', onclick: function () { S.billingErr = null; route(); loadBilling(); } })))
      : h('div', { class: 'dots', style: 'justify-content:center;padding:60px' }, h('span'), h('span'), h('span')));
    var m = b.method;
    return h('div', { class: 'view' }, heading,
      h('div', { class: 'grid g4' },
        h('div', { class: 'card stat' }, h('p', { class: 'eyebrow', text: 'Balance due' }), h('p', { class: 'big', text: b.balance_text }),
          h('p', { class: 'sub', text: b.open_count ? b.open_count + (b.open_count === 1 ? ' open invoice' : ' open invoices') : 'You’re all paid up' })),
        h('div', { class: 'card stat' }, h('p', { class: 'eyebrow', text: 'Payment method' }),
          m ? h('div', { class: 'method' }, h('span', { class: 'cardchip', text: m.type === 'bank' ? 'Bank' : m.brand }), h('b', { text: (m.type === 'bank' ? m.brand + ' ' : '') + (m.last4 ? '•••• ' + m.last4 : '') })) : h('p', { class: 'sub', text: 'No payment method saved yet.' }),
          m && m.exp ? h('p', { class: 'sub', text: 'Expires ' + m.exp }) : null,
          b.enabled ? h('div', { class: 'act' }, h('button', { class: 'link', type: 'button', text: m ? 'Update payment method' : 'Add a payment method', onclick: openSetup })) : null)),
      h('div', { class: 'card flush' }, b.invoices.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Invoice', 'Description', 'Issued', 'Due', 'Amount', 'Status', ''].map(function (t, i) { return h('th', { class: i === 4 ? 'num' : null }, t ? t : h('span', { class: 'sr', text: 'Actions' })); }))),
        h('tbody', null, b.invoices.map(function (inv) {
          return h('tr', null,
            h('td', { class: 'nw', style: 'font-weight:700', text: inv.number || '—' }), h('td', { text: inv.description }),
            h('td', { class: 'nw mute sm', text: inv.issued }), h('td', { class: 'nw mute sm', text: inv.status === 'paid' && inv.paid_on ? 'Paid ' + inv.paid_on : inv.due || '—' }),
            h('td', { class: 'num', style: 'font-weight:600', text: inv.payable && inv.remaining !== inv.total ? inv.remaining_text + ' left' : inv.total_text }), h('td', null, badge(inv.status)),
            h('td', { class: 'num' }, h('div', { style: 'display:flex;gap:14px;justify-content:flex-end;align-items:center' },
              inv.pdf ? h('a', { class: 'link', href: '/api/portal/invoices/' + inv.id + '/pdf', target: '_blank', rel: 'noopener', text: inv.status === 'paid' ? 'Receipt' : 'PDF' }) : null,
              inv.payable && b.enabled ? h('button', { class: 'pill small', type: 'button', text: 'Pay now', onclick: function () { openPay(inv); } }) : null)));
        })))) : h('p', { class: 'empty', style: 'padding:24px 16px', text: 'No invoices yet.' })),
      h('div', { class: 'stripe-note' }, h('span', { style: 'color:#C8B6FF;display:flex' }, icon('shield', 18)),
        h('p', null, 'Payments are processed securely by our partner ', h('strong', { style: 'color:#fff', text: 'Stripe' }), '. Aethera never sees or stores your full card or bank details.'),
        h('span', { class: 'by', text: 'Powered by Stripe' })));
  }
  function modal(content) {
    var box = h('div', { class: 'scrim', onclick: function (e) { if (e.target === box) close(); } }, content);
    function close() { box.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    document.body.appendChild(box);
    return close;
  }
  function paymentDialog(o) {
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var mount = h('div', { class: 'pe' }, h('div', { class: 'dots', style: 'justify-content:center;padding:40px 0' }, h('span'), h('span'), h('span')));
    var submit = h('button', { class: 'pill block', type: 'submit', disabled: true, text: o.button });
    var body = h('form', { class: 'card dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('div', { class: 'dh' }, h('div', null, h('p', { class: 'eyebrow', text: o.eyebrow }), o.amount ? h('p', { class: 'amt', text: o.amount }) : h('h2', { style: 'font-size:34px;margin-top:8px', text: o.title }),
        o.sub ? h('p', { class: 'mute', style: 'margin:8px 0 0;font-size:14px', text: o.sub }) : null),
        h('button', { class: 'xbtn', type: 'button', 'aria-label': 'Close', onclick: function () { close(); } }, icon('x'))),
      mount, err, submit, h('p', { class: 'note' }, icon('lock', 14), 'Secure checkout · Powered by Stripe'));
    var close = modal(body);
    return { form: body, mount: mount, err: err, submit: submit, close: close, done: function (title, text) {
      body.innerHTML = '';
      add(body, [h('div', { class: 'ok-mark' }, icon('check', 30)), h('h2', { style: 'font-size:38px;text-align:center' }, title), h('p', { class: 'mute', style: 'margin:0;text-align:center', text: text }),
        h('button', { class: 'pill block', type: 'button', text: 'Done', onclick: function () { close(); } })]);
    } };
  }
  function openPay(inv) {
    var dlg = paymentDialog({ title: 'Pay invoice ' + inv.number, eyebrow: 'Pay ' + (inv.number || 'invoice'), amount: inv.remaining_text, sub: inv.description + (inv.due ? ' · due ' + inv.due : ''), button: 'Pay ' + inv.remaining_text });
    var stripe, elements;
    Promise.all([stripeReady(), api('POST', '/invoices/' + inv.id + '/pay', {})]).then(function (r) {
      stripe = r[0]; dlg.mount.innerHTML = '';
      elements = window.AetheraPay.mountPayment(stripe, { mount: dlg.mount, clientSecret: r[1].clientSecret }).elements;
      dlg.submit.disabled = false;
    }).catch(function (x) { dlg.mount.innerHTML = ''; dlg.err.textContent = x.message; dlg.err.hidden = false; });
    dlg.form.addEventListener('submit', function (e) {
      e.preventDefault(); if (!elements) return;
      dlg.err.hidden = true; busy(dlg.submit, true, 'Processing…');
      stripe.confirmPayment({ elements: elements, redirect: 'if_required', confirmParams: { return_url: location.origin + location.pathname + '?paid=' + encodeURIComponent(inv.id) } }).then(function (res) {
        if (res.error) { busy(dlg.submit, false); dlg.err.textContent = res.error.message || 'The payment didn’t go through.'; dlg.err.hidden = false; return; }
        var processing = res.paymentIntent && res.paymentIntent.status === 'processing';
        api('POST', '/invoices/' + inv.id + '/paid', {}).catch(function () {}).then(function () {
          dlg.done(processing ? h('span', null, 'Payment ', h('em', { text: 'submitted' }), '.') : h('span', null, 'Payment ', h('em', { text: 'received' }), '.'),
            processing ? 'Bank payments take a few business days to clear. We’ll mark ' + inv.number + ' paid as soon as it does.' : inv.number + ' is paid. A receipt is on its way and saved here under Billing.');
          loadBilling(); refreshData();
        });
      });
    });
  }
  function openSetup() {
    var dlg = paymentDialog({ title: 'Payment method', eyebrow: 'Billing', button: 'Save payment method', sub: 'Saved securely with Stripe for future invoices.' });
    var stripe, elements;
    Promise.all([stripeReady(), api('POST', '/payment-method/setup', {})]).then(function (r) {
      stripe = r[0]; dlg.mount.innerHTML = '';
      elements = window.AetheraPay.mountPayment(stripe, { mount: dlg.mount, clientSecret: r[1].clientSecret }).elements;
      dlg.submit.disabled = false;
    }).catch(function (x) { dlg.mount.innerHTML = ''; dlg.err.textContent = x.message; dlg.err.hidden = false; });
    dlg.form.addEventListener('submit', function (e) {
      e.preventDefault(); if (!elements) return;
      dlg.err.hidden = true; busy(dlg.submit, true, 'Saving…');
      stripe.confirmSetup({ elements: elements, redirect: 'if_required', confirmParams: { return_url: location.origin + location.pathname + '?setup=1' } }).then(function (res) {
        if (res.error) { busy(dlg.submit, false); dlg.err.textContent = res.error.message || 'That didn’t work. Please try again.'; dlg.err.hidden = false; return; }
        api('POST', '/payment-method/confirm', { setup_intent: res.setupIntent.id }).then(function () {
          dlg.done(h('span', null, 'Payment method ', h('em', { text: 'saved' }), '.'), 'We’ll use it for future invoices.'); loadBilling();
        }).catch(function (x) { busy(dlg.submit, false); dlg.err.textContent = x.message; dlg.err.hidden = false; });
      });
    });
  }

  // ---------- activity ----------
  function activity() {
    var d = S.data;
    var groups = { signin: ['signin', 'security'], file: ['file', 'approval'], quote: ['quote'], billing: ['billing'], report: ['report'] };
    var rows = d.activity.filter(function (e) { return S.logFilter === 'all' || (groups[S.logFilter] || []).indexOf(e.category) >= 0; });
    return h('div', { class: 'view' },
      head('Activity log', h('h1', null, 'Every action, ', h('em', { text: 'recorded' }), '.'),
        h('p', null, 'Sign-ins, downloads, approvals and payments on your account. If something looks unfamiliar, email ', h('a', { href: 'mailto:hello@aetheradigital.com', text: 'hello@aetheradigital.com' }), '.')),
      h('div', { class: 'chips' }, [['all', 'All'], ['signin', 'Sign-ins & security'], ['file', 'Files & approvals'], ['quote', 'Quotes'], ['billing', 'Billing'], ['report', 'Reports']].map(function (c) {
        return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.logFilter === c[0]), text: c[1], onclick: function () { S.logFilter = c[0]; route(); } });
      })),
      h('div', { class: 'card flush' }, rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['When', 'Event', 'Details', 'By', 'Device'].map(function (t) { return h('th', { text: t }); }))),
        h('tbody', null, rows.map(function (e) {
          return h('tr', null, h('td', { class: 'nw mute sm', text: when(e.at) }),
            h('td', null, h('span', { class: 'evt' }, h('i', { style: 'background:' + (CAT_COLOR[e.category] || '#fff') }), e.event)),
            h('td', { class: 'sm', style: 'color:#D6D6DC', text: e.detail }), h('td', { class: 'nw sm', text: e.by }), h('td', { class: 'nw mute sm', text: e.device || '—' }));
        })))) : h('p', { class: 'empty', style: 'padding:24px 16px', text: 'Nothing here yet.' })));
  }

  // ---------- start ----------
  var qs = new URLSearchParams(location.search);
  if (qs.get('t')) { showContinue(qs.get('t')); return; }
  api('GET', '/session').then(function (s) {
    if (!s.signed_in) { history.replaceState(null, '', location.pathname); return showLogin(); }
    var paid = qs.get('paid'); var setup = qs.get('setup_intent');
    var after = Promise.resolve();
    // Returning from a bank or card step that needed a redirect (3-D Secure, bank verification).
    if (paid && /^in_/.test(paid)) after = api('POST', '/invoices/' + paid + '/paid', {}).then(function () { location.hash = '#billing'; toast(qs.get('redirect_status') === 'failed' ? 'The payment didn’t go through.' : 'Thanks! Your payment was submitted.', qs.get('redirect_status') === 'failed'); }).catch(function () {});
    else if (setup) after = api('POST', '/payment-method/confirm', { setup_intent: setup }).then(function () { location.hash = '#billing'; toast('Payment method saved'); }).catch(function (x) { location.hash = '#billing'; toast(x.message, true); });
    if (paid || setup) history.replaceState(null, '', location.pathname + location.hash);
    after.then(loadApp);
  }).catch(function () { showLogin('We couldn’t reach the portal. Check your connection and try again.'); });
})();
