/* Aethera Desk: clients, projects & checklists, files & approvals, reports, invoices. */
(function () {
  'use strict';
  var main = document.getElementById('main');
  var META = null;
  var CHART = '#9478F0'; // validated against the dark surface (lightness band + contrast)

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function svg(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function render() { main.innerHTML = ''; var v = h('div', { class: 'view' }); for (var i = 0; i < arguments.length; i++) add(v, arguments[i]); main.appendChild(v); }
  function money(c) { return (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }); }
  function usd(d) { return Number(d || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }); }
  function num(n, dec) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: dec || 0 }); }
  function day(s) { if (!s) return '—'; var d = new Date(s.length === 10 ? s + 'T12:00:00' : s); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function sdate(sec) { return sec ? new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
  function monthName(p) { var a = p.split('-'); return new Date(Number(a[0]), Number(a[1]) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function monthShort(p) { var a = p.split('-'); return new Date(Number(a[0]), Number(a[1]) - 1, 1).toLocaleDateString('en-US', { month: 'short' }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function cap(s) { return String(s || '').replace(/_/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
  var LABEL = {
    lead: 'Lead', prospect: 'Prospect', proposal: 'Proposal', active: 'Active', paused: 'Paused', past: 'Past',
    planned: 'Planned', in_progress: 'In Progress', review: 'In Review', done: 'Done', on_hold: 'On Hold',
    pending: 'Pending', approved: 'Approved', changes: 'Changes Requested', declined: 'Declined',
    approval: 'Approval', decision: 'Decision', access: 'Access Request',
    brand: 'Brand Asset', access_f: 'Access', contract: 'Contract', deliverable: 'Deliverable', report: 'Report', other: 'Other'
  };
  function lab(s) { return LABEL[s] || cap(s); }
  function badge(s, text) { return h('span', { class: 'st ' + s, text: text || lab(s) }); }
  var METRIC = {
    seo_clicks: ['Search Clicks', 'n'], seo_impressions: ['Search Impressions', 'n'], seo_avg_position: ['Avg. Search Position', 'p'],
    sessions: ['Website Sessions', 'n'], leads: ['Leads', 'n'], ad_spend: ['Ad Spend', '$'], ad_clicks: ['Ad Clicks', 'n'],
    ad_conversions: ['Ad Conversions', 'n'], social_followers: ['Social Followers', 'n'], social_engagement: ['Social Engagements', 'n'], revenue: ['Attributed Revenue', '$']
  };
  function mfmt(k, v) { var t = (METRIC[k] || [k, 'n'])[1]; return t === '$' ? usd(v) : t === 'p' ? num(v, 1) : num(v); }

  function toast(msg, bad) { var t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(t._h); t._h = setTimeout(function () { t.className = 'toast'; }, 3200); }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Please sign in.'); }
          if (!r.ok) throw new Error(d.error || 'Request failed');
          return d;
        });
      });
  }
  function desk(method, path, body) { return api(method, '/api/admin/desk' + path, body); }
  function copy(text) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Link copied'); }, function () { window.prompt('Copy this link:', text); }); }
  function loading() { render(h('div', { class: 'dots', style: 'margin:60px auto;justify-content:center', 'aria-label': 'Loading' }, h('span'), h('span'), h('span'))); }
  function failed(e) { render(h('div', { class: 'panel' }, h('h2', { text: 'Something Went Wrong' }), h('p', { class: 'empty', text: e.message }))); }
  function pageHead(eyebrow, title, acts, crumb) {
    return h('div', { class: 'ph' },
      h('div', null, crumb ? h('a', { class: 'crumb', href: crumb[0], text: '← ' + crumb[1] }) : null, h('p', { class: 'eyebrow', style: crumb ? 'margin-top:10px' : '', text: typeof eyebrow === 'string' ? eyebrow : null }, typeof eyebrow === 'string' ? null : eyebrow), h('h1', null, title)),
      h('div', { class: 'acts' }, acts || null));
  }
  function btn(label, on, cls) { return h('button', { class: 'pill small' + (cls ? ' ' + cls : ''), type: 'button', onclick: on, text: label }); }
  function emptyLine(t) { return h('p', { class: 'empty', text: t }); }

  // ---------- modal forms ----------
  function field(f, v) {
    var id = 'f_' + f.name;
    var wrap = h('div', { class: 'fld', style: f.span ? 'grid-column:span ' + f.span : '' }, h('label', { for: id, text: f.label }));
    var input;
    if (f.type === 'select') {
      input = h('select', { id: id, name: f.name }, f.options.map(function (o) { var val = Array.isArray(o) ? o[0] : o; return h('option', { value: val, text: Array.isArray(o) ? o[1] : lab(o), selected: String(v) === String(val) ? 'selected' : null }); }));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id: id, name: f.name, rows: f.rows || 4, maxlength: f.max || 5000, placeholder: f.placeholder || '' }); input.value = v || '';
    } else if (f.type === 'checks') {
      input = h('div', { class: 'checks', id: id }, f.options.map(function (o) { return h('label', null, h('input', { type: 'checkbox', name: f.name, value: o, checked: (v || []).indexOf(o) >= 0 }), o); }));
    } else {
      input = h('input', { id: id, name: f.name, type: f.type || 'text', value: v === undefined || v === null ? '' : v, placeholder: f.placeholder || '', inputmode: f.inputmode || null, required: f.required || null, autocomplete: 'off' });
    }
    wrap.appendChild(input);
    if (f.help) wrap.appendChild(h('small', { class: 'was', text: f.help }));
    return wrap;
  }
  function modal(opts) {
    var values = opts.values || {};
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var rows = []; var row = null;
    opts.fields.forEach(function (f) {
      if (f.half) { if (!row) { row = h('div', { class: 'row' }); rows.push(row); } row.appendChild(field(f, values[f.name])); if (row.children.length === 2) row = null; }
      else { row = null; rows.push(field(f, values[f.name])); }
    });
    var submit = h('button', { class: 'pill', type: 'submit', text: opts.submit || 'Save' });
    var form = h('form', { novalidate: true }, rows, err, h('div', { class: 'btns' }, opts.danger || null, h('button', { class: 'pill ghost', type: 'button', text: 'Cancel', onclick: close }), submit));
    var box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, onclick: function (e) { if (e.target === box) close(); } },
      h('div', { class: 'card' }, h('h2', null, opts.title), form));
    function close() { box.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', esc);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.hidden = true;
      var data = {};
      opts.fields.forEach(function (f) {
        if (f.type === 'checks') data[f.name] = Array.prototype.filter.call(form.querySelectorAll('input[name="' + f.name + '"]'), function (x) { return x.checked; }).map(function (x) { return x.value; });
        else data[f.name] = form.elements[f.name].value.trim();
      });
      submit.disabled = true;
      Promise.resolve(opts.onSubmit(data)).then(function () { close(); }).catch(function (er) { err.textContent = er.message; err.hidden = false; submit.disabled = false; });
    });
    document.body.appendChild(box);
    var first = form.querySelector('input,select,textarea'); if (first) first.focus();
    return { close: close };
  }
  function confirmDelete(what) { return window.confirm('Delete ' + what + '? This can’t be undone.'); }

  // ---------- record forms ----------
  var clientFields = function () {
    return [
      { name: 'name', label: 'Contact Name', half: true, required: true }, { name: 'company', label: 'Business', half: true },
      { name: 'email', label: 'Billing Email', type: 'email', half: true }, { name: 'phone', label: 'Phone', type: 'tel', half: true },
      { name: 'website', label: 'Website', half: true, placeholder: 'https://' }, { name: 'status', label: 'Status', type: 'select', options: META.client_status, half: true },
      { name: 'monthly_value', label: 'Monthly Value ($)', inputmode: 'decimal', half: true, placeholder: 'e.g. 2250' }, { name: 'source', label: 'Lead Source', half: true, placeholder: 'Referral, website, event…' },
      { name: 'services', label: 'Services', type: 'checks', options: META.services },
      { name: 'next_step', label: 'Next Step', half: true, placeholder: 'e.g. Send proposal' }, { name: 'next_date', label: 'Next Step Date', type: 'date', half: true },
      { name: 'aliases', label: 'Also Match Emails & Meetings By', placeholder: 'Other emails, domains or short names, e.g. pat.lee@gmail.com, baconroofing.net, Bacon' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 4, max: 10000 }
    ];
  };
  function editClient(c, then) {
    modal({ title: c ? 'Edit Client' : 'New Client', fields: clientFields(), values: c || { status: 'lead' }, submit: c ? 'Save Changes' : 'Create Client',
      onSubmit: function (d) {
        if (!d.name) throw new Error('Enter a contact name.');
        return (c ? desk('PATCH', '/clients/' + c.id, d) : desk('POST', '/clients', d)).then(function (r) { toast(c ? 'Client saved' : 'Client created'); then(r.item); });
      } });
  }
  // ---------- reporting connections ----------
  var SRC = { gsc: 'Search Console', ga4: 'Google Analytics' };
  function editConnections(c, then) {
    modal({ title: 'Reporting Connections', submit: 'Save Connections', values: c, fields: [
      { name: 'gsc_site', label: 'Search Console Site', placeholder: 'e.g. aetheradigital.com',
        help: 'The property exactly as Search Console lists it. A plain domain like baconroofing.com is saved as a Domain property (sc-domain:).' },
      { name: 'ga4_property', label: 'GA4 Property ID', inputmode: 'numeric', placeholder: 'e.g. 412345678',
        help: 'The number in GA4 under Admin › Property details (not the G- measurement ID).' }
    ], onSubmit: function (d) {
      return desk('PATCH', '/clients/' + c.id, d).then(function (r) { toast('Connections saved'); then(r.item); });
    } });
  }
  function connectionsPanel(c, reload) {
    var sync = c.report_sync || {};
    function row(key, value) {
      var st = sync[key];
      var line = !value ? 'Not connected' : !st ? 'Waiting for the first pull (the reporting script checks daily)'
        : (st.ok ? 'Last pulled ' : 'Problem on ') + day(new Date(st.at).toLocaleDateString('en-CA')) + ' for ' + monthName(st.period) + ' · ' + st.message;
      return [h('dt', { text: SRC[key] }), h('dd', null, h('div', { text: value || '—' }),
        h('small', { class: 'was' + (st && !st.ok ? ' bad' : ''), text: line }))];
    }
    return h('div', { class: 'panel', style: 'margin-top:18px' },
      h('div', { class: 'hrow' }, h('h2', null, 'Reporting Connections'),
        btn(c.gsc_site || c.ga4_property ? 'Edit Connections' : 'Connect Google', function () { editConnections(c, reload); }, 'ghost')),
      h('p', { class: 'was', style: 'margin:-4px 0 14px', text: 'Numbers from these accounts fill in this client’s monthly report automatically. Anything typed by hand is never overwritten.' }),
      h('dl', { class: 'dl' }, row('gsc', c.gsc_site), row('ga4', c.ga4_property)),
      !META.collector ? h('p', { class: 'was bad', style: 'margin-top:12px', text: 'The reporting script isn’t set up yet: DESK_COLLECTOR_TOKEN is missing on the server.' }) : null);
  }
  function editProject(p, clientId, then) {
    var fields = [
      { name: 'name', label: 'Project Name', required: true },
      { name: 'status', label: 'Status', type: 'select', options: META.project_status, half: true }, { name: 'owner', label: 'Owner', half: true, placeholder: 'e.g. Joseph' },
      { name: 'start', label: 'Start', type: 'date', half: true }, { name: 'due', label: 'Due', type: 'date', half: true },
      { name: 'description', label: 'Scope & Notes', type: 'textarea', rows: 4 }
    ];
    if (!p) fields.splice(1, 0, { name: 'template', label: 'Start From a Checklist', type: 'select', options: [['', 'None']].concat(Object.keys(META.templates).map(function (k) { return [k, META.templates[k].label + ' (' + META.templates[k].count + ' tasks)']; })) });
    modal({ title: p ? 'Edit Project' : 'New Project', fields: fields, values: p || { status: 'planned' }, submit: p ? 'Save Changes' : 'Create Project',
      onSubmit: function (d) {
        if (!d.name) throw new Error('Enter a project name.');
        var tpl = d.template; delete d.template;
        if (p) return desk('PATCH', '/projects/' + p.id, d).then(function (r) { toast('Project saved'); then(r.item); });
        d.client_id = clientId;
        return desk('POST', '/projects', d).then(function (r) {
          return (tpl ? desk('POST', '/projects/' + r.item.id + '/checklist', { template: tpl }) : Promise.resolve()).then(function () { toast('Project created'); then(r.item); });
        });
      } });
  }
  function editApproval(a, clientId, then) {
    modal({ title: a ? 'Update Item' : 'New Approval or Decision', submit: a ? 'Save' : 'Add',
      fields: [
        { name: 'title', label: 'What needs a decision?', required: true, placeholder: 'e.g. Homepage design v2' },
        { name: 'kind', label: 'Type', type: 'select', options: META.approval_kind, half: true }, { name: 'status', label: 'Status', type: 'select', options: META.approval_status, half: true },
        { name: 'decided_by', label: 'Decided By', half: true }, { name: 'decided', label: 'Decision Date', type: 'date', half: true },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 3 }
      ],
      values: a || { kind: 'approval', status: 'pending' },
      onSubmit: function (d) {
        if (!d.title) throw new Error('Describe what needs a decision.');
        if (d.status !== 'pending' && !d.decided) d.decided = today();
        if (a) return desk('PATCH', '/approvals/' + a.id, d).then(function (r) { toast('Saved'); then(r.item); });
        d.client_id = clientId; return desk('POST', '/approvals', d).then(function (r) { toast('Added'); then(r.item); });
      } });
  }

  // ---------- auth & routing ----------
  function showLogin(msg) {
    document.getElementById('app').hidden = true; document.getElementById('login').hidden = false;
    var e = document.getElementById('login-err'); if (msg) { e.textContent = msg; e.hidden = false; }
    setTimeout(function () { document.getElementById('pw').focus(); }, 50);
  }
  function showApp() {
    document.getElementById('login').hidden = true; document.getElementById('app').hidden = false;
    desk('GET', '/meta').then(function (m) { META = m; route(); }).catch(failed);
  }
  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault(); var er = document.getElementById('login-err'); er.hidden = true;
    api('POST', '/api/admin/login', { password: document.getElementById('pw').value }).then(function () { document.getElementById('pw').value = ''; showApp(); })
      .catch(function (x) { er.textContent = x.message; er.hidden = false; });
  });
  document.getElementById('logout').addEventListener('click', function () { api('POST', '/api/admin/logout').then(function () { showLogin(); }); });
  api('GET', '/api/admin/me').then(function (me) {
    if (!me.configured) return showLogin('Admin isn’t set up yet. Add ADMIN_PASSWORD to the aethera-site service in Render.');
    me.admin ? showApp() : showLogin();
  }).catch(function () { showLogin('Couldn’t reach the server.'); });

  function setNav(key) { document.querySelectorAll('.nav a').forEach(function (a) { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); }
  function route() {
    if (!META) return;
    var hash = location.hash.replace(/^#/, '') || '/';
    var q = {}; var qi = hash.indexOf('?');
    if (qi >= 0) { new URLSearchParams(hash.slice(qi + 1)).forEach(function (v, k) { q[k] = v; }); hash = hash.slice(0, qi); }
    var p = hash.split('/').filter(Boolean);
    window.scrollTo(0, 0);
    if (!p.length) { setNav('overview'); return overview(); }
    setNav(p[0]);
    if (p[0] === 'clients' && p[1]) return clientView(p[1], p[2] || 'overview');
    if (p[0] === 'clients') return clientsView(q.status || '');
    if (p[0] === 'projects' && p[1]) return projectView(p[1]);
    if (p[0] === 'projects') return projectsView();
    if (p[0] === 'approvals') return approvalsView();
    if (p[0] === 'reports' && p[1]) return reportView(p[1], q.edit === '1');
    if (p[0] === 'reports') return reportsView(q.month);
    if (p[0] === 'invoices') return invoicesView(q);
    if (p[0] === 'quotes' && window.DeskQuotes) return window.DeskQuotes.route(p, q);
    overview();
  }
  window.addEventListener('hashchange', route);

  // ---------- suggested to-dos ----------
  function suggestionList(items, showClient, onChange) {
    var ul = h('ul', { class: 'list' });
    items.forEach(function (s) {
      var li = h('li', null,
        h('span', { class: 'src ' + (s.source || 'email'), title: s.source === 'meeting' ? 'From Meeting Notes' : 'From Email', 'aria-hidden': 'true', text: s.source === 'meeting' ? '◉' : '✉' }),
        h('span', { class: 'grow' },
          h('span', { class: 't', text: s.title }),
          h('span', { class: 'm' }, [showClient ? s.client : null, s.source_title ? '“' + s.source_title + '”' : null, s.due ? 'Due ' + day(s.due) : null].filter(Boolean).join(' · ') + ' ',
            s.source_url ? h('a', { href: s.source_url, target: '_blank', rel: 'noopener', text: 'View Source ↗' }) : null),
          s.evidence ? h('span', { class: 'm ev', text: s.evidence }) : null),
        h('div', { class: 'sugacts' },
          h('button', { class: 'pill small', type: 'button', text: 'Add', title: 'Add to General To-Dos', onclick: function (e) { accept(s, null, e.target); } }),
          h('button', { class: 'pill small ghost', type: 'button', text: 'Add to…', onclick: function () { acceptTo(s); } }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss Suggestion', title: 'Dismiss', text: '×', onclick: function () {
            desk('PATCH', '/suggestions/' + s.id, { status: 'dismissed' }).then(function () { li.remove(); toast('Dismissed'); if (onChange) onChange(); }).catch(function (x) { toast(x.message, true); });
          } })));
      ul.appendChild(li);
      function accept(sg, body, b) {
        if (b) b.disabled = true;
        desk('POST', '/suggestions/' + sg.id + '/accept', body || {}).then(function (r) { li.remove(); toast('Added to ' + r.project.name); if (onChange) onChange(); })
          .catch(function (x) { if (b) b.disabled = false; toast(x.message, true); });
      }
      function acceptTo(sg) {
        desk('GET', '/projects?client_id=' + sg.client_id).then(function (r) {
          var opts = [['', 'General To-Dos']].concat(r.items.filter(function (p) { return p.status !== 'done' && p.name.toLowerCase() !== 'general to-dos'; }).map(function (p) { return [p.id, p.name]; }));
          modal({ title: 'Add To-Do', submit: 'Add Task', values: { title: sg.title, project_id: '' }, fields: [{ name: 'title', label: 'Task' }, { name: 'project_id', label: 'Project', type: 'select', options: opts }],
            onSubmit: function (v) { if (!v.title) throw new Error('Enter a task.'); return desk('POST', '/suggestions/' + sg.id + '/accept', { title: v.title, project_id: v.project_id || null }).then(function (x) { li.remove(); toast('Added to ' + x.project.name); if (onChange) onChange(); }); } });
        });
      }
    });
    return ul;
  }
  function leadList(items, onChange) {
    var ul = h('ul', { class: 'list' });
    items.forEach(function (l) {
      var li = h('li', null,
        h('span', { class: 'src lead', 'aria-hidden': 'true', text: '★' }),
        h('span', { class: 'grow' },
          h('span', { class: 't', text: (l.company ? l.company + ' · ' : '') + l.name }),
          h('span', { class: 'm' }, [l.email, l.phone, l.source_title ? '“' + l.source_title + '”' : null, l.source_date ? day(l.source_date) : null].filter(Boolean).join(' · ') + ' ',
            l.source_url ? h('a', { href: l.source_url, target: '_blank', rel: 'noopener', text: 'View Email ↗' }) : null),
          l.summary ? h('span', { class: 'm ev', style: 'font-style:normal;color:#D6D6DC', text: l.summary }) : null,
          (l.services || []).length ? h('div', { class: 'tags', style: 'margin-top:6px' }, l.services.map(function (x) { return h('span', { class: 'tag', text: x }); })) : null),
        h('div', { class: 'sugacts' },
          h('button', { class: 'pill small', type: 'button', text: 'Add to Pipeline', onclick: function (e) {
            e.target.disabled = true;
            desk('POST', '/leads/' + l.id + '/accept', {}).then(function (r) { toast('Added ' + (r.client.company || r.client.name) + ' as a lead'); location.hash = '#/clients/' + r.client.id; })
              .catch(function (x) { e.target.disabled = false; toast(x.message, true); });
          } }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss Lead', title: 'Not a lead', text: '×', onclick: function () {
            desk('PATCH', '/leads/' + l.id, { status: 'dismissed' }).then(function () { li.remove(); toast('Dismissed'); if (onChange) onChange(); }).catch(function (x) { toast(x.message, true); });
          } })));
      ul.appendChild(li);
    });
    return ul;
  }
  function syncLine(st) {
    if (!st) return null;
    if (!st.token || !st.ai) return h('small', { text: 'Inbox sync not set up' });
    if (!st.runs.length) return h('small', { text: 'Waiting for the first inbox check' });
    var last = st.runs.slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; })[0];
    return h('small', { title: st.runs.map(function (r) { return r.by + ' · ' + new Date(r.at).toLocaleString(); }).join('\n'), text: 'Checked ' + new Date(last.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + (st.queue ? ' · reading ' + st.queue : '') });
  }

  // ---------- overview ----------
  function overview() {
    loading();
    Promise.all([desk('GET', '/overview'), desk('GET', '/collector').catch(function () { return null; })]).then(function (both) {
      var o = both[0]; var sync = both[1];
      var hour = new Date().getHours();
      var hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      var b = o.billing;
      setMode(b && b.test_mode);
      render(
        o.store === 'memory' ? h('p', { class: 'banner', text: 'The Desk database isn’t connected, so changes are kept only until the server restarts. Add DATABASE_URL in Render to save them.' }) : null,
        pageHead('Aethera Desk', [hello + '.'], [btn('New Client', function () { editClient(null, function (c) { location.hash = '#/clients/' + c.id; }); }), btn('New Invoice', function () { location.hash = '#/invoices?new=1'; }, 'ghost')]),
        h('div', { class: 'grid g4' },
          tile('Active Clients', String(o.active_clients), o.pipeline.prospect + o.pipeline.proposal + ' in the pipeline'),
          tile('Monthly Recurring', usd(o.monthly_recurring), 'From active clients'),
          tile('Open Invoices', b ? money(b.open_total) : '—', b ? b.open_count + ' open' + (b.overdue_count ? ' · ' + b.overdue_count + ' overdue' : '') : 'Stripe not connected', b && b.overdue_count),
          tile('Paid, Last 30 Days', b ? money(b.paid_30d) : '—', 'Through Stripe')),
        o.leads && o.leads.length ? h('div', { class: 'panel sug', style: 'margin-top:18px' }, h('h2', null, 'New Leads', h('small', null, o.leads.length + ' from hello@')), leadList(o.leads)) : null,
        h('div', { class: 'panel sug', style: 'margin-top:18px' }, h('h2', null, 'Suggested To-Dos', syncLine(sync)),
          o.suggestions.length ? suggestionList(o.suggestions, true) : emptyLine(sync && sync.token && sync.ai ? 'Nothing new from email or meetings. New suggestions appear here after each daily check.' : 'Once inbox sync is set up, action items from client emails and Meet notes show up here for you to add or dismiss.')),
        h('div', { class: 'panel', style: 'margin-top:18px' }, h('h2', null, 'Pipeline'),
          h('div', { class: 'pipe' }, META.client_status.map(function (s) { return h('a', { href: '#/clients?status=' + s }, h('b', { text: String(o.pipeline[s] || 0) }), h('span', { text: lab(s) })); }))),
        h('div', { class: 'grid g3', style: 'margin-top:18px' },
          h('div', { class: 'panel' }, h('h2', null, 'Due This Week', h('small', null, String(o.tasks_due.length))),
            o.tasks_due.length ? h('ul', { class: 'list' }, o.tasks_due.map(function (t) {
              var li = h('li', null,
                h('input', { type: 'checkbox', class: 'chk', 'aria-label': 'Mark “' + t.title + '” done', onchange: function (e) {
                  desk('PATCH', '/tasks/' + t.id, { done: e.target.checked }).then(function () { li.classList.toggle('done', e.target.checked); toast(e.target.checked ? 'Task done' : 'Task reopened'); }).catch(function (x) { toast(x.message, true); });
                } }),
                h('span', { class: 'grow' }, h('a', { class: 't', href: '#/projects/' + t.project_id, text: t.title }), h('span', { class: 'm', text: [t.client, t.project, t.owner].filter(Boolean).join(' · ') })),
                h('span', { class: 'when' + (t.overdue ? ' bad' : ''), text: t.overdue ? 'Overdue' : day(t.due) }));
              return li;
            })) : emptyLine('Nothing due in the next 7 days.')),
          h('div', { class: 'panel' }, h('h2', null, 'Waiting on Approval', h('small', null, String(o.approvals_pending.length))),
            o.approvals_pending.length ? h('ul', { class: 'list' }, o.approvals_pending.slice(0, 10).map(function (a) {
              return h('li', null, h('span', { class: 'grow' }, h('a', { class: 't', href: '#/clients/' + a.client_id + '/approvals', text: a.title }), h('span', { class: 'm', text: a.client + ' · ' + lab(a.kind) })), h('span', { class: 'when', text: day(a.requested) }));
            })) : emptyLine('No open approvals.')),
          h('div', { class: 'panel' }, h('h2', null, 'Follow-ups'),
            o.follow_ups.length ? h('ul', { class: 'list' }, o.follow_ups.map(function (f) {
              return h('li', null, h('span', { class: 'grow' }, h('a', { class: 't', href: '#/clients/' + f.id, text: f.client }), h('span', { class: 'm', text: f.next_step || lab(f.status) })), h('span', { class: 'when' + (f.overdue ? ' bad' : ''), text: day(f.next_date) }));
            })) : emptyLine('Add a next step to a client to see it here.')))
      );
    }).catch(failed);
  }
  function tile(k, v, s, bad) { return h('div', { class: 'tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), h('div', { class: 's' + (bad ? ' bad' : ''), text: s })); }
  function setMode(test) { var m = document.getElementById('mode'); if (test === undefined || test === null) return; m.hidden = false; m.textContent = test ? 'Stripe Test Mode' : 'Live Payments'; m.className = 'mode' + (test ? '' : ' live'); }

  // ---------- clients ----------
  function clientsView(status) {
    loading();
    Promise.all([desk('GET', '/clients'), desk('GET', '/leads').catch(function () { return { items: [] }; })]).then(function (both) {
      var r = both[0]; var leadsRes = both[1];
      var all = r.items; var filter = status; var term = '';
      var tbody = h('tbody');
      function draw() {
        tbody.innerHTML = '';
        var list = all.filter(function (c) {
          if (filter && c.status !== filter) return false;
          if (!term) return true;
          return [c.name, c.company, c.email].join(' ').toLowerCase().indexOf(term) >= 0;
        }).sort(function (a, b) { return (a.company || a.name).localeCompare(b.company || b.name); });
        list.forEach(function (c) {
          tbody.appendChild(h('tr', { class: 'link', onclick: function () { location.hash = '#/clients/' + c.id; } },
            h('td', { class: 'who' }, h('b', { text: c.company || c.name }), h('small', { text: c.company ? c.name + (c.email ? ' · ' + c.email : '') : (c.email || '') })),
            h('td', null, badge(c.status || 'lead')),
            h('td', null, (c.services || []).length ? (c.services.length + ' service' + (c.services.length > 1 ? 's' : '')) : '—'),
            h('td', { class: 'num' }, c.monthly_value ? usd(c.monthly_value) + '/mo' : '—'),
            h('td', null, c.next_step ? h('span', null, c.next_step, h('small', { style: 'display:block;color:var(--mute)', text: c.next_date ? day(c.next_date) : '' })) : '—')));
        });
        if (!list.length) tbody.appendChild(h('tr', null, h('td', { colspan: 5, class: 'empty', text: all.length ? 'No clients match.' : 'No clients yet. Add your first one.' })));
      }
      var chips = [['', 'All']].concat(META.client_status.map(function (s) { return [s, lab(s)]; })).map(function (s) {
        return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === s[0]), text: s[1], onclick: function (e) {
          filter = s[0]; e.target.parentNode.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === e.target)); }); draw();
        } });
      });
      var pendingLeads = (leadsRes.items || []).filter(function (l) { return l.status === 'new'; }).reverse();
      render(pageHead('Relationships', 'Clients & Prospects', [btn('New Client', function () { editClient(null, function (c) { location.hash = '#/clients/' + c.id; }); })]),
        pendingLeads.length ? h('div', { class: 'panel sug', style: 'margin-bottom:18px' }, h('h2', null, 'New Leads', h('small', null, String(pendingLeads.length))), leadList(pendingLeads)) : null,
        h('div', { class: 'toolbar' }, h('input', { class: 'search', type: 'search', placeholder: 'Search name, business or email', 'aria-label': 'Search clients', oninput: function (e) { term = e.target.value.trim().toLowerCase(); draw(); } }), chips),
        h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'Client' }), h('th', { text: 'Status' }), h('th', { text: 'Services' }), h('th', { class: 'num', text: 'Value' }), h('th', { text: 'Next Step' }))), tbody)));
      draw();
    }).catch(failed);
  }

  function clientView(id, tab) {
    loading();
    desk('GET', '/clients/' + id + '/full').then(function (d) {
      var c = d.client; var base = '#/clients/' + c.id;
      var counts = { projects: d.projects.length, files: d.files.length, approvals: d.approvals.filter(function (a) { return a.status === 'pending'; }).length, reports: d.reports.length, quotes: (d.quotes || []).length, invoices: d.invoices.length };
      var tabs = h('nav', { class: 'tabs', 'aria-label': 'Client sections' }, [['overview', 'Overview'], ['projects', 'Projects'], ['files', 'Files'], ['approvals', 'Approvals'], ['reports', 'Reports'], ['quotes', 'Quotes'], ['invoices', 'Invoices']].map(function (t) {
        return h('a', { href: base + (t[0] === 'overview' ? '' : '/' + t[0]), 'aria-current': tab === t[0] ? 'page' : null }, t[1], counts[t[0]] ? h('small', { text: String(counts[t[0]]) }) : null);
      }));
      var statusSel = h('select', { class: 'st ' + (c.status || 'lead'), 'aria-label': 'Client status', onchange: function (e) {
        desk('PATCH', '/clients/' + c.id, { status: e.target.value }).then(function () { e.target.className = 'st ' + e.target.value; toast('Status updated'); }).catch(function (x) { toast(x.message, true); });
      } }, META.client_status.map(function (s) { return h('option', { value: s, text: lab(s), selected: s === c.status ? 'selected' : null }); }));
      var reload = function () { clientView(c.id, tab); };
      var body;
      if (tab === 'projects') body = clientProjects(c, d, reload);
      else if (tab === 'files') body = clientFiles(c, d, reload);
      else if (tab === 'approvals') body = clientApprovals(c, d, reload);
      else if (tab === 'reports') body = clientReports(c, d);
      else if (tab === 'invoices') body = clientInvoices(c, d);
      else if (tab === 'quotes' && window.DeskQuotes) body = window.DeskQuotes.clientTab(c, d);
      else body = clientOverview(c, d, reload);
      render(pageHead(c.company ? c.name : 'Client', [c.company || c.name, ' ', statusSel],
        [btn('New Quote', function () { window.DeskQuotes.newQuote(c.id); }, 'ghost'), btn('New Invoice', function () { location.hash = '#/invoices?new=1&client=' + c.id; }), btn('Edit', function () { editClient(c, reload); }, 'ghost')], ['#/clients', 'Clients']), tabs, body);
    }).catch(failed);
  }
  function clientOverview(c, d, reload) {
    var open = d.invoices.filter(function (i) { return i.status === 'open'; });
    var paid = d.invoices.filter(function (i) { return i.status === 'paid'; });
    var tasksOpen = d.tasks.filter(function (t) { return !t.done; }).length;
    return h('div', null,
      d.suggestions && d.suggestions.length ? h('div', { class: 'panel sug', style: 'margin-bottom:18px' }, h('h2', null, 'Suggested To-Dos', h('small', null, String(d.suggestions.length))), suggestionList(d.suggestions, false)) : null,
      h('div', { class: 'grid g4' },
        tile('Monthly Value', c.monthly_value ? usd(c.monthly_value) : '—', c.status === 'active' ? 'Active Retainer' : lab(c.status)),
        tile('Open Balance', money(open.reduce(function (s, i) { return s + i.amount_remaining; }, 0)), open.length + ' open invoice' + (open.length === 1 ? '' : 's')),
        tile('Paid to Date', money(paid.reduce(function (s, i) { return s + i.total; }, 0)), paid.length + ' paid invoice' + (paid.length === 1 ? '' : 's')),
        tile('Open Tasks', String(tasksOpen), d.projects.filter(function (p) { return p.status !== 'done'; }).length + ' active project(s)')),
      h('div', { class: 'grid g2', style: 'margin-top:18px' },
        h('div', { class: 'panel' }, h('h2', null, 'Details'),
          h('dl', { class: 'dl' },
            h('dt', { text: 'Contact' }), h('dd', { text: c.name }),
            h('dt', { text: 'Email' }), h('dd', null, c.email ? h('a', { href: 'mailto:' + c.email, text: c.email }) : '—'),
            h('dt', { text: 'Phone' }), h('dd', { text: c.phone || '—' }),
            h('dt', { text: 'Website' }), h('dd', null, c.website ? h('a', { href: /^https?:/.test(c.website) ? c.website : 'https://' + c.website, target: '_blank', rel: 'noopener', text: c.website }) : '—'),
            h('dt', { text: 'Source' }), h('dd', { text: c.source || '—' }),
            h('dt', { text: 'Also Matches' }), h('dd', { text: c.aliases || '—' }),
            h('dt', { text: 'Services' }), h('dd', null, (c.services || []).length ? h('div', { class: 'tags' }, c.services.map(function (s) { return h('span', { class: 'tag', text: s }); })) : '—'),
            h('dt', { text: 'Client Since' }), h('dd', { text: day(c.created_at) }))),
        h('div', { class: 'panel' }, h('h2', null, 'Next Step'),
          c.next_step ? h('p', { style: 'margin:0 0 6px;font-size:18px', text: c.next_step }) : emptyLine('No next step set.'),
          c.next_date ? h('p', { class: (c.next_date < today() ? 'st overdue' : 'st open'), style: 'margin:0 0 18px', text: (c.next_date < today() ? 'Overdue · ' : '') + day(c.next_date) }) : null,
          h('h2', { style: 'margin-top:18px' }, 'Notes'),
          c.notes ? h('p', { class: 'notes', text: c.notes }) : emptyLine('No notes yet.'))),
      connectionsPanel(c, reload),
      h('div', { class: 'no-print', style: 'margin-top:24px' }, h('button', { class: 'pill small ghost', type: 'button', text: 'Delete Client', onclick: function () {
        if (!confirmDelete((c.company || c.name) + ' and all of its projects, files, approvals and reports (Stripe invoices are not affected)')) return;
        desk('DELETE', '/clients/' + c.id).then(function () { toast('Client deleted'); location.hash = '#/clients'; }).catch(function (x) { toast(x.message, true); });
      } })));
  }
  function progress(tasks) { var t = tasks.length; var dn = tasks.filter(function (x) { return x.done; }).length; return { t: t, d: dn, pct: t ? Math.round(dn / t * 100) : 0 }; }
  function clientProjects(c, d, reload) {
    return h('div', null,
      h('div', { class: 'toolbar' }, btn('New Project', function () { editProject(null, c.id, function (p) { location.hash = '#/projects/' + p.id; }); })),
      d.projects.length ? h('div', { class: 'grid g3' }, d.projects.map(function (p) {
        var pr = progress(d.tasks.filter(function (t) { return t.project_id === p.id; }));
        return h('a', { class: 'pc', href: '#/projects/' + p.id },
          h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:flex-start' }, h('b', { text: p.name }), badge(p.status)),
          h('small', { text: [p.owner, p.due ? 'Due ' + day(p.due) : ''].filter(Boolean).join(' · ') || ' ' }),
          h('div', { class: 'bar' }, h('i', { style: 'width:' + pr.pct + '%' })), h('small', { style: 'margin-top:6px', text: pr.d + ' of ' + pr.t + ' tasks done' }));
      })) : h('div', { class: 'panel' }, emptyLine('No projects yet. Create one and start it from a checklist (website, SEO, ads, branding, social or onboarding).')));
  }
  function clientFiles(c, d, reload) {
    var cat = h('select', { class: 'search', style: 'max-width:200px;border-radius:12px', 'aria-label': 'File category' }, META.file_category.map(function (s) { return h('option', { value: s, text: s === 'access' ? 'Access' : lab(s) }); }));
    var input = h('input', { type: 'file', id: 'file-in', multiple: true, hidden: true, onchange: function (e) { upload(e.target.files); } });
    var drop = h('div', { class: 'drop' }, 'Drag files here or ', h('label', { for: 'file-in', text: 'choose files' }), ' (up to 15 MB each)', input);
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('on'); }); });
    drop.addEventListener('drop', function (e) { upload(e.dataTransfer.files); });
    function upload(files) {
      var list = Array.prototype.slice.call(files || []); if (!list.length) return;
      var big = list.filter(function (f) { return f.size > 15 * 1024 * 1024; });
      if (big.length) { toast(big[0].name + ' is over 15 MB', true); return; }
      toast('Uploading ' + list.length + ' file' + (list.length > 1 ? 's' : '') + '…');
      list.reduce(function (p, f) {
        return p.then(function () {
          return fetch('/api/admin/desk/files?client_id=' + encodeURIComponent(c.id) + '&category=' + encodeURIComponent(cat.value) + '&name=' + encodeURIComponent(f.name), { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' }, credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) return r.json().then(function (x) { throw new Error(x.error || 'Upload failed'); }); });
        });
      }, Promise.resolve()).then(function () { toast('Uploaded'); reload(); }).catch(function (x) { toast(x.message, true); });
    }
    var size = function (b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };
    return h('div', null,
      h('div', { class: 'panel', style: 'margin-bottom:18px' }, h('div', { class: 'toolbar', style: 'margin-bottom:12px' }, h('span', { class: 'eyebrow', text: 'Upload As' }), cat), drop),
      d.files.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'File' }), h('th', { text: 'Category' }), h('th', { text: 'Size' }), h('th', { text: 'Added' }), h('th', { class: 'num' }))),
        h('tbody', null, d.files.map(function (f) {
          return h('tr', null, h('td', null, h('a', { href: '/api/admin/desk/files/' + f.id, text: f.name })), h('td', null, h('span', { class: 'tag', text: f.category === 'access' ? 'Access' : lab(f.category) })),
            h('td', { text: size(f.size) }), h('td', { text: day(f.created_at) }),
            h('td', { class: 'num' }, h('div', { class: 'rowacts' }, h('a', { href: '/api/admin/desk/files/' + f.id, text: 'Download' }), h('button', { class: 'danger', type: 'button', text: 'Delete', onclick: function () {
              if (!confirmDelete(f.name)) return; desk('DELETE', '/files/' + f.id).then(function () { toast('File deleted'); reload(); }).catch(function (x) { toast(x.message, true); });
            } }))));
        })))) : h('div', { class: 'panel' }, emptyLine('No files yet. Upload brand assets, access details, contracts and deliverables here.')));
  }
  function approvalRow(a, showClient, reload) {
    var sel = h('select', { class: 'st ' + a.status, 'aria-label': 'Status for ' + a.title, onchange: function (e) {
      var body = { status: e.target.value }; if (e.target.value !== 'pending' && !a.decided) body.decided = today();
      desk('PATCH', '/approvals/' + a.id, body).then(function () { e.target.className = 'st ' + e.target.value; toast('Updated'); if (reload) reload(); }).catch(function (x) { toast(x.message, true); });
    } }, META.approval_status.map(function (s) { return h('option', { value: s, text: lab(s), selected: s === a.status ? 'selected' : null }); }));
    return h('tr', null,
      h('td', { class: 'who' }, h('b', { text: a.title }), h('small', { text: [showClient ? a.client : null, lab(a.kind), a.notes].filter(Boolean).join(' · ') })),
      h('td', null, sel),
      h('td', { text: a.status === 'pending' ? 'Requested ' + day(a.requested) : (a.decided ? day(a.decided) : '—') + (a.decided_by ? ' · ' + a.decided_by : '') }),
      h('td', { class: 'num' }, h('div', { class: 'rowacts' },
        h('button', { type: 'button', text: 'Edit', onclick: function () { editApproval(a, a.client_id, function () { if (reload) reload(); }); } }),
        h('button', { class: 'danger', type: 'button', text: 'Delete', onclick: function () { if (!confirmDelete('“' + a.title + '”')) return; desk('DELETE', '/approvals/' + a.id).then(function () { toast('Deleted'); if (reload) reload(); }); } }))));
  }
  function clientApprovals(c, d, reload) {
    var list = d.approvals.slice().sort(function (a, b) { return (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.created_at < a.created_at ? -1 : 1); });
    return h('div', null,
      h('div', { class: 'toolbar' }, btn('New Approval or Decision', function () { editApproval(null, c.id, reload); })),
      list.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'Item' }), h('th', { text: 'Status' }), h('th', { text: 'Date' }), h('th', { class: 'num' }))),
        h('tbody', null, list.map(function (a) { return approvalRow(a, false, reload); })))) : h('div', { class: 'panel' }, emptyLine('Track design approvals, key decisions and access requests here.')));
  }
  function clientReports(c, d) {
    return h('div', null,
      h('div', { class: 'toolbar' }, btn('New Monthly Report', function () { newReport(c.id); })),
      d.reports.length ? h('div', { class: 'grid g3' }, d.reports.map(function (r) {
        var m = r.metrics || {}; var keys = Object.keys(m).slice(0, 3);
        return h('a', { class: 'pc', href: '#/reports/' + r.id }, h('b', null, monthName(r.period) + ' ', repBadge(r)), h('small', { text: keys.map(function (k) { return METRIC[k][0] + ' ' + mfmt(k, m[k]); }).join(' · ') || 'No metrics yet' }));
      })) : h('div', { class: 'panel' }, emptyLine('No reports yet. Create a monthly report to track SEO, ads, social and leads over time.')));
  }
  function newReport(clientId, clients) {
    var d = new Date(); d.setMonth(d.getMonth() - 1);
    var period = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    var fields = [{ name: 'period', label: 'Month', type: 'month' }];
    if (!clientId) fields.unshift({ name: 'client_id', label: 'Client', type: 'select', options: clients.map(function (c) { return [c.id, c.company || c.name]; }) });
    modal({ title: 'New Monthly Report', fields: fields, values: { period: period }, submit: 'Create Report', onSubmit: function (v) {
      return desk('POST', '/reports', { client_id: clientId || v.client_id, period: v.period }).then(function (r) { location.hash = '#/reports/' + r.item.id + '?edit=1'; });
    } });
  }
  function invoiceTable(invoices, reload) {
    return h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'Invoice' }), h('th', { text: 'Client' }), h('th', { class: 'num', text: 'Amount' }), h('th', { text: 'Status' }), h('th', { text: 'Due' }), h('th', { class: 'num' }))),
      h('tbody', null, invoices.length ? invoices.map(function (inv) { return invoiceRow(inv, reload); }) : h('tr', null, h('td', { colspan: 6, class: 'empty', text: 'No invoices yet.' })))));
  }
  function clientInvoices(c, d) {
    if (!c.email) return h('div', { class: 'panel' }, emptyLine('Add a billing email to this client to see their Stripe invoices here.'));
    return h('div', null,
      h('div', { class: 'toolbar' }, btn('New Invoice', function () { location.hash = '#/invoices?new=1&client=' + c.id; })),
      d.invoice_error ? h('p', { class: 'banner', text: d.invoice_error }) : null,
      invoiceTable(d.invoices, function () { clientView(c.id, 'invoices'); }));
  }

  // ---------- projects ----------
  function projectsView() {
    loading();
    Promise.all([desk('GET', '/projects'), desk('GET', '/tasks'), desk('GET', '/clients')]).then(function (r) {
      var clients = {}; r[2].items.forEach(function (c) { clients[c.id] = c; });
      var cols = ['planned', 'in_progress', 'review', 'on_hold', 'done'];
      var board = h('div', { class: 'board' });
      render(pageHead('Work', 'Projects', [btn('New Project', function () {
        if (!r[2].items.length) { toast('Add a client first', true); return; }
        modal({ title: 'New Project', submit: 'Next', fields: [{ name: 'client_id', label: 'Client', type: 'select', options: r[2].items.map(function (c) { return [c.id, c.company || c.name]; }) }], onSubmit: function (v) {
          setTimeout(function () { editProject(null, v.client_id, function (p) { location.hash = '#/projects/' + p.id; }); }, 0);
        } });
      })]),
      board);
      paint();
      function paint() {
        board.innerHTML = '';
        cols.forEach(function (s) {
          var ps = r[0].items.filter(function (p) { return (p.status || 'planned') === s; }).sort(function (a, b) { return (a.due || '9') < (b.due || '9') ? -1 : 1; });
          board.appendChild(h('section', { class: 'col', 'data-status': s, 'aria-label': lab(s) }, h('h3', null, lab(s), h('span', { text: String(ps.length) })),
            ps.length ? ps.map(function (p) {
              var pr = progress(r[1].items.filter(function (t) { return t.project_id === p.id; }));
              var cl = clients[p.client_id] || {};
              var overdue = p.due && p.due < today() && s !== 'done';
              var card = h('a', { class: 'pc', href: '#/projects/' + p.id, title: 'Drag to move · Click to open' }, h('b', { text: p.name }), h('small', { text: cl.company || cl.name || '' }),
                h('small', { style: overdue ? 'color:var(--err)' : '', text: [p.owner, p.due ? (overdue ? 'Overdue · ' : 'Due ') + day(p.due) : ''].filter(Boolean).join(' · ') }),
                pr.t ? h('div', { class: 'bar' }, h('i', { style: 'width:' + pr.pct + '%' })) : null);
              draggable(card, p);
              return card;
            }) : h('p', { class: 'hint', text: 'Drop a project here' })));
        });
      }
      function moveTo(p, status) {
        var prev = p.status || 'planned';
        if (status === prev) return;
        p.status = status; paint();
        desk('PATCH', '/projects/' + p.id, { status: status }).then(function () { toast(p.name + ' → ' + lab(status)); })
          .catch(function (x) { p.status = prev; paint(); toast(x.message, true); });
      }
      // Pointer-based drag so it works with a mouse, a trackpad or touch (long-press on touch).
      function draggable(card, p) {
        card.addEventListener('dragstart', function (e) { e.preventDefault(); });
        card.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          var sx = e.clientX, sy = e.clientY, rect = card.getBoundingClientRect(), ox = sx - rect.left, oy = sy - rect.top;
          var touch = e.pointerType !== 'mouse', started = false, ghost = null, over = null, timer = null;
          function begin(x, y) {
            started = true;
            ghost = card.cloneNode(true); ghost.classList.add('ghost'); ghost.removeAttribute('href'); ghost.style.width = rect.width + 'px';
            document.body.appendChild(ghost); card.classList.add('lift'); document.body.classList.add('dragging');
            place(x, y);
          }
          function place(x, y) {
            ghost.style.left = (x - ox) + 'px'; ghost.style.top = (y - oy) + 'px';
            var el = document.elementFromPoint(x, y); var col = el && el.closest ? el.closest('.board .col') : null;
            if (col !== over) { if (over) over.classList.remove('over'); over = col; if (over) over.classList.add('over'); }
            var br = board.getBoundingClientRect();
            if (x > br.right - 40) board.scrollLeft += 12; else if (x < br.left + 40) board.scrollLeft -= 12;
          }
          function onMove(ev) {
            if (ev.pointerId !== e.pointerId) return;
            var dist = Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy);
            if (!started) {
              if (touch) { if (dist > 10) finish(); return; }
              if (dist < 6) return;
              begin(ev.clientX, ev.clientY);
            }
            ev.preventDefault(); place(ev.clientX, ev.clientY);
          }
          function onTouchMove(ev) { if (started) ev.preventDefault(); }
          function finish(ev) {
            clearTimeout(timer);
            document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish);
            document.removeEventListener('touchmove', onTouchMove);
            if (!started) return;
            if (ghost) ghost.remove(); card.classList.remove('lift'); document.body.classList.remove('dragging');
            if (over) over.classList.remove('over');
            // swallow the click that follows a drag so the card doesn't open
            var stop = function (c) { c.preventDefault(); c.stopPropagation(); };
            card.addEventListener('click', stop, true);
            setTimeout(function () { card.removeEventListener('click', stop, true); }, 0);
            if (ev && ev.type === 'pointerup' && over) moveTo(p, over.getAttribute('data-status'));
          }
          if (touch) timer = setTimeout(function () { begin(sx, sy); if (navigator.vibrate) navigator.vibrate(10); }, 280);
          document.addEventListener('pointermove', onMove, { passive: false });
          document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
          document.addEventListener('touchmove', onTouchMove, { passive: false });
        });
      }
    }).catch(failed);
  }
  function projectView(id) {
    loading();
    desk('GET', '/projects/' + id).then(function (pr) {
      var p = pr.item;
      return Promise.all([desk('GET', '/tasks?project_id=' + p.id), desk('GET', '/clients/' + p.client_id)]).then(function (r) {
        var tasks = r[0].items.sort(function (a, b) { return (a.position || 0) - (b.position || 0) || (a.created_at < b.created_at ? -1 : 1); });
        var c = r[1].item;
        var reload = function () { projectView(p.id); };
        var ul = h('ul', { class: 'list' });
        var bar = h('i'); var count = h('small');
        function updateProgress() { var g = progress(tasks); bar.style.width = g.pct + '%'; count.textContent = g.d + ' of ' + g.t + ' done'; }
        tasks.forEach(function (t) {
          var li = h('li', { class: t.done ? 'done' : '' },
            h('input', { type: 'checkbox', class: 'chk', checked: t.done, 'aria-label': 'Mark “' + t.title + '” done', onchange: function (e) {
              t.done = e.target.checked; li.classList.toggle('done', t.done); updateProgress();
              desk('PATCH', '/tasks/' + t.id, { done: t.done }).catch(function (x) { toast(x.message, true); });
            } }),
            h('span', { class: 'grow' }, h('span', { class: 't', text: t.title }), (t.owner || t.due) ? h('span', { class: 'm', text: [t.owner, t.due ? 'Due ' + day(t.due) : ''].filter(Boolean).join(' · ') }) : null),
            h('div', { class: 'rowacts' },
              h('button', { type: 'button', text: 'Edit', onclick: function () {
                modal({ title: 'Edit Task', fields: [{ name: 'title', label: 'Task' }, { name: 'owner', label: 'Owner', half: true }, { name: 'due', label: 'Due', type: 'date', half: true }], values: t, onSubmit: function (v) {
                  if (!v.title) throw new Error('Enter a task.'); return desk('PATCH', '/tasks/' + t.id, v).then(reload);
                } });
              } }),
              h('button', { class: 'danger', type: 'button', text: 'Delete', 'aria-label': 'Delete Task', onclick: function () { desk('DELETE', '/tasks/' + t.id).then(reload); } })));
          ul.appendChild(li);
        });
        var addIn = h('input', { class: 'search', style: 'max-width:none', placeholder: 'Add a task and press Enter', 'aria-label': 'New task' });
        var addForm = h('form', { class: 'toolbar', style: 'margin:14px 0 0', onsubmit: function (e) {
          e.preventDefault(); var v = addIn.value.trim(); if (!v) return;
          desk('POST', '/tasks', { project_id: p.id, title: v, position: tasks.length }).then(reload).catch(function (x) { toast(x.message, true); });
        } }, addIn, h('button', { class: 'pill small', type: 'submit', text: 'Add' }));
        var tplSel = h('select', { class: 'search', style: 'max-width:260px;border-radius:12px', 'aria-label': 'Checklist' }, [h('option', { value: '', text: 'Add a Checklist…' })].concat(Object.keys(META.templates).map(function (k) { return h('option', { value: k, text: META.templates[k].label }); })));
        tplSel.addEventListener('change', function () { if (!tplSel.value) return; desk('POST', '/projects/' + p.id + '/checklist', { template: tplSel.value }).then(function (x) { toast(x.tasks.length + ' tasks added'); reload(); }); });
        var statusSel = h('select', { class: 'st ' + p.status, 'aria-label': 'Project status', onchange: function (e) { desk('PATCH', '/projects/' + p.id, { status: e.target.value }).then(function () { e.target.className = 'st ' + e.target.value; toast('Status updated'); }); } },
          META.project_status.map(function (s) { return h('option', { value: s, text: lab(s), selected: s === p.status ? 'selected' : null }); }));
        render(pageHead(c.company || c.name, [p.name, ' ', statusSel], [btn('Edit', function () { editProject(p, p.client_id, reload); }, 'ghost'), btn('Delete', function () {
          if (!confirmDelete('this project and its tasks')) return; desk('DELETE', '/projects/' + p.id).then(function () { toast('Project deleted'); location.hash = '#/clients/' + p.client_id + '/projects'; });
        }, 'ghost')], ['#/clients/' + p.client_id + '/projects', c.company || c.name]),
          h('div', { class: 'grid g2', style: 'grid-template-columns:minmax(0,2fr) minmax(0,1fr)' },
            h('div', { class: 'panel' }, h('h2', null, 'Checklist', count), h('div', { class: 'bar', style: 'margin:0 0 10px' }, bar), tasks.length ? ul : emptyLine('No tasks yet. Add one below or start from a checklist.'), addForm, h('div', { style: 'margin-top:12px' }, tplSel)),
            h('div', { class: 'panel' }, h('h2', null, 'Details'), h('dl', { class: 'dl', style: 'grid-template-columns:90px 1fr' },
              h('dt', { text: 'Owner' }), h('dd', { text: p.owner || '—' }), h('dt', { text: 'Start' }), h('dd', { text: day(p.start) }), h('dt', { text: 'Due' }), h('dd', { text: day(p.due) })),
              p.description ? h('p', { class: 'notes', style: 'margin-top:16px', text: p.description }) : null)));
        updateProgress();
      });
    }).catch(failed);
  }

  // ---------- approvals ----------
  function approvalsView() {
    loading();
    Promise.all([desk('GET', '/approvals'), desk('GET', '/clients')]).then(function (r) {
      var names = {}; r[1].items.forEach(function (c) { names[c.id] = c.company || c.name; });
      var items = r[0].items.map(function (a) { a.client = names[a.client_id] || ''; return a; });
      var pending = items.filter(function (a) { return a.status === 'pending'; });
      var recent = items.filter(function (a) { return a.status !== 'pending'; }).sort(function (a, b) { return (b.decided || '') < (a.decided || '') ? -1 : 1; }).slice(0, 20);
      var head = function () { return h('thead', null, h('tr', null, h('th', { text: 'Item' }), h('th', { text: 'Status' }), h('th', { text: 'Date' }), h('th', { class: 'num' }))); };
      render(pageHead('Decisions', 'Approvals', [btn('New Approval', function () {
        if (!r[1].items.length) { toast('Add a client first', true); return; }
        modal({ title: 'Which client?', submit: 'Next', fields: [{ name: 'client_id', label: 'Client', type: 'select', options: r[1].items.map(function (c) { return [c.id, c.company || c.name]; }) }], onSubmit: function (v) {
          setTimeout(function () { editApproval(null, v.client_id, approvalsView); }, 0);
        } });
      })]),
        h('div', { class: 'panel', style: 'padding:6px 0' }, h('h2', { style: 'padding:16px 22px 0' }, 'Waiting', h('small', null, String(pending.length))),
          pending.length ? h('table', { class: 'tbl' }, head(), h('tbody', null, pending.map(function (a) { return approvalRow(a, true, approvalsView); }))) : h('p', { class: 'empty', style: 'padding:0 22px 14px', text: 'Nothing is waiting on a decision.' })),
        recent.length ? h('div', { class: 'panel', style: 'padding:6px 0;margin-top:18px' }, h('h2', { style: 'padding:16px 22px 0' }, 'Recently Decided'),
          h('table', { class: 'tbl' }, head(), h('tbody', null, recent.map(function (a) { return approvalRow(a, true, approvalsView); })))) : null);
    }).catch(failed);
  }

  // ---------- reports ----------
  // Where a report stands: none (no report yet), needs (draft, no numbers), review (draft with content), ready, sent.
  // Reports from before statuses existed are treated as drafts, the same way the Google pull treats them.
  function repState(r) {
    if (!r) return 'none';
    var s = r.status || 'draft';
    if (s === 'draft') return Object.keys(r.metrics || {}).length || r.summary ? 'review' : 'needs';
    return s;
  }
  var REP_LABEL = { none: 'Not Started', needs: 'Needs Data', review: 'Draft', ready: 'Ready to Send', sent: 'Sent' };
  function repBadge(r) { var s = repState(r); return h('span', { class: 'st rp-' + s, text: REP_LABEL[s] }); }
  function highlights(m, n) { return Object.keys(m || {}).slice(0, n || 3).map(function (k) { return METRIC[k][0] + ' ' + mfmt(k, m[k]); }).join(' · '); }
  function shiftMonth(p, by) { var a = p.split('-').map(Number); var n = a[0] * 12 + a[1] - 1 + by; return Math.floor(n / 12) + '-' + String(n % 12 + 1).padStart(2, '0'); }
  // Same rule as the server: Reporting & Strategy (or no services) shows everything; "Website & Leads" always shows.
  function groupsFor(c, m) {
    var s = c.services || [];
    return META.metric_groups.filter(function (g) {
      if (!s.length || s.indexOf('Reporting & Strategy') >= 0 || !g.services) return true;
      if (g.services.some(function (x) { return s.indexOf(x) >= 0; })) return true;
      return g.metrics.some(function (k) { return m && m[k] !== undefined; }); // never hide numbers already entered
    });
  }

  function reportsView(month) {
    loading();
    var period = /^\d{4}-\d{2}$/.test(month || '') ? month : META.report_month;
    Promise.all([desk('GET', '/reports'), desk('GET', '/clients')]).then(function (r) {
      var clients = r[1].items; var names = {}; clients.forEach(function (c) { names[c.id] = c.company || c.name; });
      var all = r[0].items.sort(function (a, b) { return a.period < b.period ? 1 : a.period > b.period ? -1 : (names[a.client_id] || '').localeCompare(names[b.client_id] || ''); });
      var thisMonth = {}; all.forEach(function (x) { if (x.period === period) thisMonth[x.client_id] = x; });
      var rows = clients.filter(function (c) { return c.status === 'active' || thisMonth[c.id]; })
        .sort(function (a, b) { return (names[a.id] || '').localeCompare(names[b.id] || ''); })
        .map(function (c) { return { c: c, r: thisMonth[c.id] || null }; });
      var order = ['none', 'needs', 'review', 'ready', 'sent'];
      rows.sort(function (a, b) { return order.indexOf(repState(a.r)) - order.indexOf(repState(b.r)); });
      var count = {}; order.forEach(function (k) { count[k] = 0; }); rows.forEach(function (x) { count[repState(x.r)]++; });
      var missing = count.none;
      var go = function (p) { location.hash = '#/reports?month=' + p; };

      var nav = h('div', { class: 'monthnav' },
        h('button', { class: 'chip', type: 'button', 'aria-label': 'Previous month', text: '‹', onclick: function () { go(shiftMonth(period, -1)); } }),
        h('b', { text: monthName(period) }),
        h('button', { class: 'chip', type: 'button', 'aria-label': 'Next month', text: '›', onclick: function () { go(shiftMonth(period, 1)); } }),
        period !== META.report_month ? h('button', { class: 'chip', type: 'button', text: 'Latest', onclick: function () { go(META.report_month); } }) : null);

      var cards = rows.map(function (x) {
        var st = repState(x.r); var c = x.c;
        var sub = x.r ? (highlights(x.r.metrics) || (x.r.summary ? 'Commentary written, no numbers yet' : 'No numbers yet')) : 'No report for this month yet';
        var note = x.r && x.r.status === 'sent' && x.r.sent_at ? 'Sent ' + day(x.r.sent_at) : x.r && x.r.created_by === 'auto' && st === 'needs' ? 'Drafted automatically' : '';
        var action = st === 'none'
          ? btn('Start Report', function () { desk('POST', '/reports', { client_id: c.id, period: period }).then(function (y) { location.hash = '#/reports/' + y.item.id + '?edit=1'; }).catch(function (e) { toast(e.message, true); }); })
          : h('a', { class: 'pill small' + (st === 'ready' || st === 'sent' ? ' ghost' : ''), href: '#/reports/' + x.r.id + (st === 'needs' ? '?edit=1' : ''), text: st === 'needs' ? 'Fill In' : st === 'review' ? 'Review' : 'Open' });
        return h('div', { class: 'repcard' },
          h('div', { class: 'top' }, h('a', { class: 'nm', href: '#/clients/' + c.id + '/reports', text: names[c.id] }), repBadge(x.r)),
          h('small', { text: sub }), note ? h('small', { class: 'note', text: note }) : null,
          h('div', { class: 'act' }, action));
      });

      render(pageHead('Results', 'Client Reports', [
          missing ? btn('Create ' + missing + ' Draft' + (missing > 1 ? 's' : ''), function (e) {
            e.target.disabled = true;
            desk('POST', '/reports/drafts', { period: period }).then(function (y) { toast(y.created + ' draft' + (y.created === 1 ? '' : 's') + ' created'); reportsView(period); }).catch(function (er) { e.target.disabled = false; toast(er.message, true); });
          }) : null,
          btn('New Report', function () { if (!clients.length) { toast('Add a client first', true); return; } newReport(null, clients); }, 'ghost')]),
        nav,
        rows.length ? h('div', { class: 'grid g4', style: 'margin-bottom:18px' },
          tile('Needs Data', String(count.needs + count.none), count.none ? count.none + ' not started' : 'Numbers to enter'),
          tile('To Review', String(count.review), 'Drafts with content'),
          tile('Ready to Send', String(count.ready), 'Reviewed'),
          tile('Sent', String(count.sent), 'Shared with the client')) : null,
        rows.length ? h('div', { class: 'grid g3' }, cards)
          : h('div', { class: 'panel' }, emptyLine('No active clients for ' + monthName(period) + '. Set a client to Active and a draft report is created for them automatically at the start of each month.')),
        h('h2', { class: 'sect', text: 'All Reports' }),
        h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: 'Month' }), h('th', { text: 'Client' }), h('th', { text: 'Status' }), h('th', { text: 'Highlights' }))),
          h('tbody', null, all.length ? all.map(function (rp) {
            return h('tr', { class: 'link', onclick: function () { location.hash = '#/reports/' + rp.id; } }, h('td', { text: monthName(rp.period) }), h('td', { text: names[rp.client_id] || '' }),
              h('td', null, repBadge(rp)), h('td', { text: highlights(rp.metrics) || '—' }));
          }) : h('tr', null, h('td', { colspan: 4, class: 'empty', text: 'No reports yet.' }))))));
    }).catch(failed);
  }
  function setReportStatus(rp, status) {
    return desk('PATCH', '/reports/' + rp.id, { status: status }).then(function () { toast(status === 'sent' ? 'Marked as sent' : status === 'ready' ? 'Marked ready to send' : 'Moved back to draft'); route(); }).catch(function (e) { toast(e.message, true); });
  }
  function reportView(id, editing) {
    loading();
    desk('GET', '/reports/' + id).then(function (x) {
      var rp = x.item;
      return Promise.all([desk('GET', '/clients/' + rp.client_id), desk('GET', '/reports?client_id=' + rp.client_id)]).then(function (r) {
        var c = r[0].item; var cname = c.company || c.name;
        var history = r[1].items.filter(function (h2) { return h2.period <= rp.period; }).sort(function (a, b) { return a.period < b.period ? -1 : 1; }).slice(-12);
        var prev = history.length > 1 ? history[history.length - 2] : null;
        if (editing) return reportEditor(rp, c, prev);
        var m = rp.metrics || {}; var keys = META.metrics.filter(function (k) { return m[k] !== undefined; });
        var cpl = m.ad_spend && m.leads ? m.ad_spend / m.leads : null;
        var st = repState(rp);
        var next = st === 'needs' || st === 'review' ? btn('Mark Ready', function () { setReportStatus(rp, 'ready'); })
          : st === 'ready' ? btn('Mark as Sent', function () { setReportStatus(rp, 'sent'); })
          : btn('Reopen', function () { setReportStatus(rp, 'draft'); }, 'ghost');
        render(pageHead(h('span', null, cname + ' ', repBadge(rp)), [monthName(rp.period), h('em', { text: ' report' })], [next, btn('Edit', function () { location.hash = '#/reports/' + rp.id + '?edit=1'; }, 'ghost'), btn('Download PDF', function () { exportReport(rp, c, history, prev); }, 'ghost'),
          btn('Delete', function () { if (!confirmDelete('this report')) return; desk('DELETE', '/reports/' + rp.id).then(function () { toast('Report deleted'); location.hash = '#/clients/' + c.id + '/reports'; }); }, 'ghost')], ['#/reports?month=' + rp.period, 'All Reports']),
          keys.length ? h('div', { class: 'kpis' }, keys.map(function (k) { return kpi(k, history, prev); }), cpl !== null ? h('div', { class: 'kpi' }, h('div', { class: 'k', text: 'Cost per Lead' }), h('div', { class: 'v', text: usd(cpl) }), h('div', { class: 'd', text: 'Ad spend ÷ leads' })) : null)
            : h('div', { class: 'panel' }, emptyLine('No numbers yet. Click Edit to add this month’s metrics.')),
          (function () { var used = {}; Object.keys(rp.sources || {}).forEach(function (k) { if (m[k] !== undefined) used[SRC[rp.sources[k]]] = 1; }); var u = Object.keys(used);
            return u.length ? h('p', { class: 'was no-print', style: 'margin:10px 0 0', text: 'Pulled automatically from ' + u.join(' and ') + '.' }) : null; })(),
          h('div', { class: 'grid g3 prose', style: 'margin-top:18px' },
            h('div', { class: 'panel' }, h('h3', { text: 'What Happened' }), h('p', { text: rp.summary || '—' })),
            h('div', { class: 'panel' }, h('h3', { text: 'Wins' }), h('p', { text: rp.wins || '—' })),
            h('div', { class: 'panel' }, h('h3', { text: 'Next Actions' }), h('p', { text: rp.next_actions || '—' }))));
      });
    }).catch(failed);
  }
  // One metric: value, change vs previous month, and a 12-month bar chart (single series, so no legend; the title names it).
  function kpi(k, history, prev) {
    var cur = history[history.length - 1].metrics[k];
    var pv = prev && prev.metrics ? prev.metrics[k] : undefined;
    var lowerBetter = k === 'seo_avg_position';
    var neutral = k === 'ad_spend'; // spending more isn't good or bad on its own
    var delta = null;
    if (pv !== undefined && pv !== 0) {
      var pct = (cur - pv) / Math.abs(pv) * 100;
      var good = lowerBetter ? pct < 0 : pct > 0;
      delta = h('div', { class: 'd ' + (Math.abs(pct) < 0.5 || neutral ? '' : good ? 'up' : 'down'), text: (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '') + Math.abs(pct).toFixed(0) + '% vs ' + monthShort(prev.period) });
    } else delta = h('div', { class: 'd', text: prev ? 'No Prior Value' : 'First Month' });
    var pts = history.filter(function (x) { return x.metrics && x.metrics[k] !== undefined; });
    var W = 240, H = 74, pad = 14, n = pts.length;
    var max = Math.max.apply(null, pts.map(function (x) { return x.metrics[k]; }).concat([0])) || 1;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + (H + pad), role: 'img', 'aria-label': METRIC[k][0] + ' by month: ' + pts.map(function (x) { return monthShort(x.period) + ' ' + mfmt(k, x.metrics[k]); }).join(', ') });
    s.appendChild(svg('line', { x1: 0, x2: W, y1: H, y2: H, stroke: 'rgba(255,255,255,.14)', 'stroke-width': 1 }));
    var slot = W / Math.max(n, 6); var bw = Math.min(22, slot - 6);
    pts.forEach(function (x, i) {
      var v = x.metrics[k]; var bh = Math.max(2, v / max * (H - 8));
      var bx = i * slot + (slot - bw) / 2; var by = H - bh;
      var r = Math.min(4, bw / 2, bh);
      var d = 'M' + bx + ',' + H + 'V' + (by + r) + 'Q' + bx + ',' + by + ' ' + (bx + r) + ',' + by + 'H' + (bx + bw - r) + 'Q' + (bx + bw) + ',' + by + ' ' + (bx + bw) + ',' + (by + r) + 'V' + H + 'Z';
      var last = i === n - 1;
      s.appendChild(svg('path', { d: d, fill: CHART, opacity: last ? 1 : 0.5 }));
      var hit = svg('rect', { x: i * slot, y: 0, width: slot, height: H + pad, fill: 'transparent' });
      hit.addEventListener('mousemove', function (e) { showTip(e, monthName(x.period) + ': ' + mfmt(k, v)); });
      hit.addEventListener('mouseleave', hideTip);
      s.appendChild(hit);
      if (last || i === 0) { var t = svg('text', { x: bx + bw / 2, y: H + 11, 'text-anchor': 'middle', class: 'ax' }); t.textContent = monthShort(x.period); s.appendChild(t); }
    });
    return h('div', { class: 'kpi' }, h('div', { class: 'k', text: METRIC[k][0] }), h('div', { class: 'v', text: mfmt(k, cur) }), delta, n > 1 ? s : null);
  }
  var tip = document.getElementById('tip');
  function showTip(e, text) { tip.textContent = text; tip.classList.add('on'); tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY - 40) + 'px'; }
  function hideTip() { tip.classList.remove('on'); }
  // ---------- report PDF ----------
  // A designed, paginated version of the report (Letter, dark brand look, no browser headers), saved through the
  // browser's own "Save as PDF". The on-screen page is hidden while printing; only this document prints.
  function exportReport(rp, c, history, prev) {
    var old = document.getElementById('print-report'); if (old) old.remove();
    var m = rp.metrics || {}; var cname = c.company || c.name;
    var groups = META.metric_groups.map(function (g) {
      var keys = g.metrics.filter(function (k) { return m[k] !== undefined; });
      return keys.length ? { label: g.label, keys: keys } : null;
    }).filter(Boolean);
    var cpl = m.ad_spend && m.leads ? m.ad_spend / m.leads : null;
    var sources = {}; Object.keys(rp.sources || {}).forEach(function (k) { if (m[k] !== undefined) sources[SRC[rp.sources[k]]] = 1; });
    function lines(t) {
      var items = String(t || '').split(/\n+/).map(function (x) { return x.replace(/^\s*(•|-|\*)\s*/, '').trim(); }).filter(Boolean);
      return items.length > 1 || /^\s*(•|-|\*)/.test(String(t || '')) ? h('ul', null, items.map(function (x) { return h('li', { text: x }); })) : h('p', { text: items[0] || '—' });
    }
    var doc = h('div', { id: 'print-report', class: 'pr', 'aria-hidden': 'true' },
      h('div', { class: 'pr-bg' }),
      h('div', { class: 'pr-foot' }, h('span', { text: 'Aethera Digital · aetheradigital.com' }), h('span', { text: cname + ' · ' + monthName(rp.period) })),
      h('header', { class: 'pr-head' },
        h('img', { src: '/assets/wordmark.png', alt: 'Aethera Digital' }),
        h('div', { class: 'pr-meta' }, h('span', { text: 'Monthly Performance Report' }), h('b', { text: monthName(rp.period) }))),
      h('section', { class: 'pr-title' },
        h('p', { class: 'pr-eyebrow', text: 'Prepared for' }),
        h('h1', { text: cname }),
        h('p', { class: 'pr-sub', text: [c.company && c.name ? c.name : '', 'Issued ' + day(new Date().toLocaleDateString('en-CA'))].filter(Boolean).join(' · ') })),
      rp.summary ? h('section', { class: 'pr-summary' }, h('h2', { text: 'What Happened This Month' }), lines(rp.summary)) : null,
      groups.map(function (g) {
        return h('section', { class: 'pr-group' }, h('h2', { text: g.label }),
          h('div', { class: 'pr-kpis' }, g.keys.map(function (k) { return kpi(k, history, prev); }),
            g.label === 'Advertising' && cpl !== null ? h('div', { class: 'kpi' }, h('div', { class: 'k', text: 'Cost per Lead' }), h('div', { class: 'v', text: usd(cpl) }), h('div', { class: 'd', text: 'Ad spend ÷ leads' })) : null));
      }),
      !groups.length ? h('section', { class: 'pr-group' }, h('p', { class: 'pr-note', text: 'No numbers were recorded for this month.' })) : null,
      rp.wins || rp.next_actions ? h('section', { class: 'pr-two' },
        h('div', { class: 'pr-card' }, h('h2', { text: 'Wins' }), lines(rp.wins)),
        h('div', { class: 'pr-card' }, h('h2', { text: 'Next Actions' }), lines(rp.next_actions))) : null,
      h('p', { class: 'pr-note', text: [
        Object.keys(sources).length ? 'Figures from ' + Object.keys(sources).join(' and ') + ' for ' + monthName(rp.period) + '.' : '',
        prev ? 'Changes compare with ' + monthName(prev.period) + '.' : ''].filter(Boolean).join(' ') }));
    document.body.appendChild(doc);
    var title = document.title;
    document.title = cname + ' – ' + monthName(rp.period) + ' Report'; // becomes the PDF's file name
    var done = function () { document.title = title; doc.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    // let the logo and fonts load before the print dialog opens
    var img = doc.querySelector('img');
    var go = function () { (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { setTimeout(function () { window.print(); }, 50); }); };
    if (img.complete) go(); else { img.onload = go; img.onerror = go; }
  }

  function reportEditor(rp, c, prev) {
    var m = rp.metrics || {}; var pm = (prev && prev.metrics) || {};
    var shown = groupsFor(c, m); var showAll = shown.length === META.metric_groups.length;
    var sections = h('div');
    function drawSections() {
      // keep anything typed when switching between "relevant" and "all" sections
      Array.prototype.forEach.call(sections.querySelectorAll('input'), function (i) { m[i.name] = i.value.trim() === '' ? undefined : i.value.trim(); });
      sections.innerHTML = '';
      (showAll ? META.metric_groups : shown).forEach(function (g) {
        sections.appendChild(h('div', { class: 'panel', style: 'margin-bottom:16px' }, h('h2', null, g.label), h('div', { class: 'metrics-form' }, g.metrics.map(function (k) {
          return h('div', { class: 'fld' }, h('label', { for: 'm_' + k, text: METRIC[k][0] + (METRIC[k][1] === '$' ? ' ($)' : '') }),
            h('input', { id: 'm_' + k, name: k, inputmode: 'decimal', value: m[k] !== undefined ? m[k] : '', placeholder: '—' }),
            h('small', { class: 'was', text: ((rp.sources || {})[k] && m[k] !== undefined ? 'From ' + SRC[rp.sources[k]] + ' · ' : '') + (pm[k] !== undefined ? 'Last month: ' + mfmt(k, pm[k]) : prev ? 'Not tracked last month' : 'First report') }));
        }))));
      });
    }
    drawSections();
    var toggle = shown.length < META.metric_groups.length ? h('button', { class: 'chip', type: 'button', text: 'Show All Sections', onclick: function (e) {
      showAll = !showAll; e.target.textContent = showAll ? 'Only This Client’s Services' : 'Show All Sections'; drawSections();
    } }) : null;
    function metricsNow() { var o = {}; Array.prototype.forEach.call(sections.querySelectorAll('input'), function (i) { if (i.value.trim() !== '') o[i.name] = i.value.trim(); }); Object.keys(m).forEach(function (k) { if (o[k] === undefined && m[k] !== undefined && !sections.querySelector('input[name="' + k + '"]')) o[k] = m[k]; }); return o; }

    var aiNote = h('small', { class: 'was', style: 'display:block;margin-top:-6px;margin-bottom:12px' });
    var aiBtn = btn('Draft with Claude', function () {
      var ta = ['summary', 'wins', 'next_actions'].map(function (n) { return form.elements[n]; });
      if (ta.some(function (t) { return t.value.trim(); }) && !window.confirm('Replace what’s written below with a new draft?')) return;
      aiBtn.disabled = true; aiBtn.textContent = 'Drafting…';
      desk('POST', '/reports/' + rp.id + '/commentary', { metrics: metricsNow() }).then(function (y) {
        ta[0].value = y.draft.summary; ta[1].value = y.draft.wins; ta[2].value = y.draft.next_actions;
        var u = y.used; var bits = [u.metrics + ' metric' + (u.metrics === 1 ? '' : 's'), u.work + ' finished task' + (u.work === 1 ? '' : 's'), u.decisions + ' decision' + (u.decisions === 1 ? '' : 's'), u.follow_ups + ' email/meeting follow-up' + (u.follow_ups === 1 ? '' : 's')];
        aiNote.textContent = 'Drafted from ' + bits.join(', ') + '. Read it over and edit before saving.';
        toast('Draft ready to review');
      }).catch(function (e) { toast(e.message, true); }).then(function () { aiBtn.disabled = false; aiBtn.textContent = 'Draft with Claude'; });
    }, 'ghost');
    if (!META.ai) { aiBtn.disabled = true; aiBtn.title = 'Set ANTHROPIC_API_KEY on the server to use this'; }

    var err = h('p', { class: 'err', id: 'rep-err', role: 'alert', hidden: true, style: 'margin-top:16px' });
    var form = h('form', { novalidate: true },
      toggle ? h('div', { class: 'toolbar' }, h('small', { class: 'was', text: 'Showing sections for ' + ((c.services || []).length ? (c.services || []).join(', ') : 'all services') + '.' }), toggle) : null,
      sections,
      h('div', { class: 'panel' }, h('div', { class: 'hrow' }, h('h2', null, 'Interpretation'), aiBtn), aiNote,
        h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
          field({ name: 'summary', label: 'What Happened This Month', type: 'textarea', rows: 4 }, rp.summary),
          field({ name: 'wins', label: 'Wins', type: 'textarea', rows: 4 }, rp.wins),
          field({ name: 'next_actions', label: 'Next Actions', type: 'textarea', rows: 4 }, rp.next_actions))),
      err,
      h('div', { class: 'toolbar', style: 'margin-top:18px;justify-content:flex-end' }, h('a', { class: 'pill ghost', href: '#/reports/' + rp.id, text: 'Cancel' }),
        h('button', { class: 'pill ghost', type: 'button', text: 'Save Draft', onclick: function () { save(rp.status === 'sent' ? 'sent' : rp.status === 'ready' ? 'ready' : 'draft'); } }),
        h('button', { class: 'pill', type: 'submit', text: rp.status === 'sent' ? 'Save' : 'Save & Mark Ready' })));
    function save(status) {
      err.hidden = true;
      desk('PATCH', '/reports/' + rp.id, { metrics: metricsNow(), summary: form.elements.summary.value.trim(), wins: form.elements.wins.value.trim(), next_actions: form.elements.next_actions.value.trim(), status: status })
        .then(function () { toast(status === 'ready' ? 'Saved and ready to send' : 'Report saved'); location.hash = '#/reports/' + rp.id; })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); save(rp.status === 'sent' ? 'sent' : 'ready'); });
    render(pageHead(h('span', null, (c.company || c.name) + ' ', repBadge(rp)), ['Edit ', h('em', { text: monthName(rp.period) })], null, ['#/reports/' + rp.id, 'Back to Report']), form);
  }

  // ---------- invoices ----------
  function invoiceRow(inv, reload) {
    var overdue = inv.status === 'open' && inv.due_date && inv.due_date * 1000 < Date.now();
    var a = h('div', { class: 'rowacts' });
    if (inv.pay_url) a.appendChild(h('button', { type: 'button', text: 'Copy Link', onclick: function () { copy(inv.pay_url); } }));
    if (inv.status === 'open') {
      a.appendChild(h('button', { type: 'button', text: inv.emailed_at ? 'Resend' : 'Email', title: inv.emailed_at ? 'Last emailed ' + new Date(inv.emailed_at).toLocaleString() : 'Not emailed yet', onclick: function (e) { invAct(inv, 'send', e.target, reload); } }));
      a.appendChild(h('button', { type: 'button', text: 'Mark Paid', title: 'Paid by check or another way outside Stripe', onclick: function (e) { if (confirm('Mark ' + inv.number + ' as paid outside Stripe (check, cash, transfer)?')) invAct(inv, 'mark-paid', e.target, reload); } }));
      a.appendChild(h('button', { class: 'danger', type: 'button', text: 'Void', onclick: function (e) { if (confirm('Void ' + inv.number + '? The client will no longer be able to pay it. This can’t be undone.')) invAct(inv, 'void', e.target, reload); } }));
    }
    a.appendChild(h('a', { href: inv.stripe_url, target: '_blank', rel: 'noopener', text: 'Stripe ↗' }));
    return h('tr', null,
      h('td', { class: 'who' }, h('b', { text: inv.number || 'Draft' }), h('small', { text: sdate(inv.created) + (inv.subscription ? ' · Partnership' : '') })),
      h('td', { class: 'who' }, h('b', { text: inv.customer_name || inv.customer_email || '—' }), inv.customer_name ? h('small', { text: inv.customer_email }) : null),
      h('td', { class: 'num', text: money(inv.total) }),
      h('td', null, overdue ? badge('overdue', 'Overdue') : badge(inv.status, lab(inv.status))),
      h('td', { text: inv.status === 'paid' ? 'Paid' : sdate(inv.due_date) }),
      h('td', { class: 'num' }, a));
  }
  function invAct(inv, action, b, reload) {
    b.disabled = true;
    api('POST', '/api/admin/invoices/' + inv.id + '/' + action).then(function (d) {
      toast({ send: d.emailed_via === 'stripe' ? 'Sent with Stripe’s email' : 'Invoice emailed to ' + inv.customer_email, void: 'Invoice voided', 'mark-paid': 'Marked as paid' }[action]); reload();
    }).catch(function (x) { b.disabled = false; toast(x.message, true); });
  }
  function invoicesView(q) {
    var filter = '';
    var listWrap = h('div');
    function load() {
      listWrap.innerHTML = ''; listWrap.appendChild(h('div', { class: 'dots', style: 'margin:30px auto;justify-content:center' }, h('span'), h('span'), h('span')));
      api('GET', '/api/admin/invoices' + (filter ? '?status=' + filter : '')).then(function (d) { setMode(d.testMode); listWrap.innerHTML = ''; listWrap.appendChild(invoiceTable(d.invoices, load)); })
        .catch(function (x) { listWrap.innerHTML = ''; listWrap.appendChild(h('p', { class: 'banner', text: x.message })); });
    }
    var chips = [['', 'All'], ['open', 'Open'], ['paid', 'Paid'], ['void', 'Void']].map(function (s) {
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === s[0]), text: s[1], onclick: function (e) {
        filter = s[0]; e.target.parentNode.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === e.target)); }); load();
      } });
    });
    var formPanel = h('div');
    render(pageHead('Billing', 'Invoices', [btn('New Invoice', function () { openNew(null); })]), formPanel, h('div', { class: 'toolbar' }, chips), listWrap);
    load();
    function openNew(clientId) {
      desk('GET', '/clients').then(function (r) { formPanel.innerHTML = ''; formPanel.appendChild(invoiceForm(r.items, clientId, load, function () { formPanel.innerHTML = ''; })); formPanel.querySelector('select,input').focus(); });
    }
    if (q.new) openNew(q.client || null);
  }
  function invoiceForm(clients, clientId, onDone, onClose) {
    var tbody = h('tbody'); var totalEl = h('span', { text: '$0.00' });
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var created = h('div', { hidden: true, style: 'display:flex;flex-direction:column;gap:12px' });
    var pick = h('select', { 'aria-label': 'Desk client', onchange: function () { fill(pick.value); } }, [h('option', { value: '', text: 'Someone Not in the Desk' })].concat(clients.slice().sort(function (a, b) { return (a.company || a.name).localeCompare(b.company || b.name); }).map(function (c) { return h('option', { value: c.id, text: (c.company || c.name) + (c.email ? ' · ' + c.email : ' (no email)'), selected: c.id === clientId ? 'selected' : null }); })));
    var email = h('input', { type: 'email', name: 'email', placeholder: 'client@company.com', autocomplete: 'off' });
    var name = h('input', { name: 'name', placeholder: 'Jordan Lee', autocomplete: 'off' });
    var company = h('input', { name: 'company', placeholder: 'Bacon Roofing', autocomplete: 'off' });
    var due = h('select', { name: 'days' }, [['7', 'In 7 Days'], ['14', 'In 14 Days'], ['30', 'In 30 Days'], ['45', 'In 45 Days'], ['60', 'In 60 Days']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: o[0] === '14' ? 'selected' : null }); }));
    var memo = h('input', { name: 'memo', maxlength: 500, placeholder: 'e.g. November website refinements, per our proposal' });
    function fill(id) { var c = clients.filter(function (x) { return x.id === id; })[0]; if (!c) return; email.value = c.email || ''; name.value = c.name || ''; company.value = c.company || ''; }
    function lines() { return Array.prototype.map.call(tbody.children, function (tr) { return { description: tr.querySelector('.d').value.trim(), quantity: Number(tr.querySelector('.qv').value), unit_amount: tr.querySelector('.uv').value.replace(/[$,\s]/g, ''), tr: tr }; }); }
    function recalc() { var t = 0; lines().forEach(function (l) { var c = Math.round(Number(l.unit_amount) * 100) * (Number.isInteger(l.quantity) ? l.quantity : 0); c = isFinite(c) ? c : 0; t += c; l.tr.querySelector('.lt').textContent = money(c); }); totalEl.textContent = money(t); }
    function addLine() {
      var tr = h('tr', null, h('td', null, h('input', { class: 'd', maxlength: 250, placeholder: 'Website refinements', 'aria-label': 'Description' })),
        h('td', { class: 'q' }, h('input', { class: 'qv', type: 'number', min: 1, max: 999, step: 1, value: 1, inputmode: 'numeric', 'aria-label': 'Quantity' })),
        h('td', { class: 'u' }, h('input', { class: 'uv', inputmode: 'decimal', placeholder: 'e.g. 750', 'aria-label': 'Unit price in dollars' })),
        h('td', { class: 'lt', text: '$0.00' }),
        h('td', { class: 'x' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove line', text: '×', onclick: function () { if (tbody.children.length > 1) { tr.remove(); recalc(); } } })));
      tbody.appendChild(tr); recalc(); return tr;
    }
    tbody.addEventListener('input', recalc);
    addLine(); if (clientId) fill(clientId);
    var lbl = function (t, el) { return h('div', { class: 'fld' }, h('label', { text: t }), el); };
    var form = h('form', { novalidate: true, style: 'display:flex;flex-direction:column;gap:18px' },
      lbl('Bill a Desk Client', pick),
      h('div', { class: 'grid g3' }, lbl('Client Email', email), lbl('Contact Name', name), lbl('Business', company)),
      h('div', null, h('table', { class: 'items' }, h('thead', null, h('tr', null, h('th', { text: 'Description' }), h('th', { class: 'q', text: 'Qty' }), h('th', { class: 'u', text: 'Unit Price ($)' }), h('th', { class: 'lt', text: 'Amount' }), h('th', { class: 'x' }))), tbody),
        h('button', { class: 'add', type: 'button', text: '+ Add line', onclick: function () { addLine().querySelector('.d').focus(); } })),
      h('div', { class: 'grid', style: 'grid-template-columns:minmax(0,1fr) minmax(0,2fr)' }, lbl('Due', due), lbl('Note to Client (Optional)', memo)),
      err,
      h('div', { class: 'ifoot' }, h('div', { class: 'total' }, h('small', { text: 'Total' }), totalEl),
        h('div', { class: 'toolbar', style: 'margin:0' }, h('button', { class: 'pill ghost', type: 'submit', 'data-send': 'false', text: 'Create, Don’t Email' }), h('button', { class: 'pill', type: 'submit', 'data-send': 'true', text: 'Create & Email Invoice' }))));
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.hidden = true;
      var send = e.submitter ? e.submitter.dataset.send !== 'false' : true;
      var items = lines().filter(function (l) { return l.description || l.unit_amount; });
      var problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim()) ? 'Enter the client’s email address.'
        : !name.value.trim() && !company.value.trim() ? 'Enter a contact name or business.'
        : !items.length ? 'Add at least one line.'
        : items.some(function (l) { return !l.description || !(Number(l.unit_amount) > 0) || !Number.isInteger(l.quantity) || l.quantity < 1; }) ? 'Each line needs a description, a quantity and a price.' : '';
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      var cents = items.reduce(function (t, l) { return t + Math.round(Number(l.unit_amount) * 100) * l.quantity; }, 0);
      var tiny = items.filter(function (l) { return Number(l.unit_amount) < 5; });
      if (tiny.length && !confirm('Heads up: ' + tiny.map(function (l) { return '“' + l.description + '” is ' + money(Math.round(Number(l.unit_amount) * 100)); }).join(', ') + '. Prices are in dollars, so 50 means $50.00 and 0.50 means 50 cents.\n\nThe invoice total is ' + money(cents) + '. Is that right?')) return;
      if (send && !confirm('Create invoice for ' + money(cents) + ' and email it to ' + email.value.trim() + '?')) return;
      var btns = form.querySelectorAll('button[type=submit]'); btns.forEach(function (b) { b.disabled = true; });
      api('POST', '/api/admin/invoices', { email: email.value.trim(), name: name.value.trim(), company: company.value.trim(), memo: memo.value.trim(), days_until_due: Number(due.value), send: send,
        items: items.map(function (l) { return { description: l.description, quantity: l.quantity, unit_amount: l.unit_amount }; }) })
        .then(function (d) {
          var inv = d.invoice;
          var msg = 'Invoice ' + inv.number + ' for ' + money(inv.total) + ' created. ' + (d.email_error ? d.email_error : d.emailed_via === 'aethera' ? 'Emailed to ' + inv.customer_email + '.' : d.emailed_via === 'stripe' ? 'Emailed with Stripe’s invoice email.' : 'Not emailed. Copy the link below to send it yourself.');
          // Add them to the Desk if they aren't there yet.
          var known = clients.some(function (c) { return (c.email || '').toLowerCase() === inv.customer_email; });
          if (!known) desk('POST', '/clients', { name: name.value.trim() || company.value.trim(), company: company.value.trim(), email: email.value.trim(), status: 'active' }).catch(function () {});
          form.hidden = true; created.hidden = false; created.innerHTML = '';
          var link = h('input', { readonly: true, value: inv.pay_url || '', 'aria-label': 'Payment Link' });
          add(created, [h('p', { class: 'ok', text: msg + (known ? '' : ' Added to your Desk clients.') }), h('div', { class: 'linkbox' }, link, btn('Copy Link', function () { copy(link.value); })), h('div', { class: 'toolbar', style: 'margin:0' }, btn('Create Another', function () { onClose(); invoicesView({ new: 1 }); }, 'ghost'), btn('Done', onClose, 'ghost'))]);
          onDone();
        }).catch(function (x) { err.textContent = x.message; err.hidden = false; }).then(function () { btns.forEach(function (b) { b.disabled = false; }); });
    });
    return h('div', { class: 'panel', style: 'margin-bottom:22px' }, h('h2', null, 'New Invoice', h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', text: '×', onclick: onClose })), form, created);
  }

  // Shared with the quotes screens (desk-quotes.js).
  window.Desk = { h: h, add: add, render: render, btn: btn, desk: desk, api: api, toast: toast, copy: copy, loading: loading, failed: failed, pageHead: pageHead,
    field: field, modal: modal, money: money, usd: usd, day: day, today: today, lab: lab, emptyLine: emptyLine, confirmDelete: confirmDelete, tile: tile,
    meta: function () { return META; }, route: function () { route(); } };
})();
