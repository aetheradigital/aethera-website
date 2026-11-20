/* Aethera Desk: client portal controls (access, invites, sign-out) and the portal audit log. */
(function () {
  'use strict';
  var D = window.Desk;
  var h = D.h, btn = D.btn, desk = D.desk, toast = D.toast, day = D.day;
  var CAT = { signin: ['Sign-in', '#C8B6FF'], security: ['Security', '#FFB3B3'], file: ['File', '#FFC4A8'], approval: ['Approval', '#FFB3D1'], report: ['Report', '#AFCBFF'], quote: ['Quote', '#F6E7A1'], billing: ['Billing', '#CFE8B4'], account: ['Account', '#C9C9D1'] };
  function stamp(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }

  // Panel on a client's Overview tab.
  function clientPanel(c) {
    var box = h('div', { class: 'panel', style: 'margin-top:18px' }, h('h2', null, 'Client Portal'), h('p', { class: 'empty', text: 'Loading…' }));
    function paint(st) {
      box.innerHTML = '';
      var toggle = h('input', { type: 'checkbox', checked: st.enabled ? 'checked' : null, 'aria-label': 'Portal access', onchange: function (e) {
        var on = e.target.checked; e.target.disabled = true;
        desk('POST', '/portal/' + c.id + '/access', { enabled: on }).then(function (n) { toast(on ? 'Portal access on' : 'Portal access off. Signed out everywhere.'); paint(n); })
          .catch(function (x) { e.target.checked = !on; e.target.disabled = false; toast(x.message, true); });
      } });
      var acts = [];
      if (st.open) {
        acts.push(btn(st.last_sign_in ? 'Email a Sign-In Link' : 'Send Portal Invite', function (e) {
          e.target.disabled = true;
          desk('POST', '/portal/' + c.id + '/invite', {}).then(function (n) { toast('Sent to ' + n.email); paint(n); }).catch(function (x) { e.target.disabled = false; toast(x.message, true); });
        }));
      }
      if (st.sessions.length) acts.push(btn('Sign Out Everywhere', function (e) {
        if (!window.confirm('Sign ' + (c.company || c.name) + ' out of every device?')) return;
        e.target.disabled = true;
        desk('POST', '/portal/' + c.id + '/signout', {}).then(function (n) { toast('Signed out everywhere'); paint(n); }).catch(function (x) { e.target.disabled = false; toast(x.message, true); });
      }, 'ghost'));
      acts.push(h('a', { class: 'pill small ghost', href: '#/portal?client=' + c.id, text: 'Activity Log' }));
      D.add(box, [
        h('h2', null, 'Client Portal ', h('small', { text: st.enabled ? 'On' : 'Off' })),
        h('label', { style: 'display:flex;gap:12px;align-items:center;font-weight:600;margin:4px 0 14px;cursor:pointer' }, toggle, 'Let this client sign in at ' + st.host),
        h('dl', { class: 'dl' },
          h('dt', { text: 'Login Email' }), h('dd', { text: st.email || 'Add an email to this client first' }),
          h('dt', { text: 'Last Sign-In' }), h('dd', { text: st.last_sign_in ? stamp(st.last_sign_in.at) + (st.last_sign_in.device ? ' · ' + st.last_sign_in.device : '') : 'Never' }),
          h('dt', { text: 'Signed In On' }), h('dd', { text: st.sessions.length ? st.sessions.map(function (s) { return s.device; }).join(', ') : 'No devices' }),
          h('dt', { text: 'They Can See' }), h('dd', { text: 'Sent reports, projects and tasks, files you share, approvals, their Stripe invoices and their activity log' })),
        !st.email_ready ? h('p', { class: 'err', style: 'margin-top:12px', text: 'Email isn’t set up on the server (PAYMENTS_NOTIFY_URL), so sign-in links can’t be sent.' }) : null,
        h('div', { class: 'toolbar', style: 'margin:16px 0 0' }, acts)]);
    }
    desk('GET', '/portal/' + c.id).then(paint).catch(function (x) { box.innerHTML = ''; D.add(box, [h('h2', null, 'Client Portal'), h('p', { class: 'empty', text: x.message })]); });
    return box;
  }

  // Share toggle for a file row.
  function shareToggle(f, onChange) {
    return h('label', { style: 'display:inline-flex;gap:8px;align-items:center;cursor:pointer;white-space:nowrap' },
      h('input', { type: 'checkbox', checked: f.shared ? 'checked' : null, 'aria-label': 'Share ' + f.name + ' with the client', onchange: function (e) {
        var on = e.target.checked; e.target.disabled = true;
        desk('PATCH', '/files/' + f.id, { shared: on }).then(function () { f.shared = on; e.target.disabled = false; toast(on ? 'Shared in the client portal' : 'Hidden from the client'); if (onChange) onChange(); })
          .catch(function (x) { e.target.checked = !on; e.target.disabled = false; toast(x.message, true); });
      } }), f.uploaded_by === 'client' ? 'From client' : 'Shared');
  }

  // #/portal: the audit log across every client.
  function auditView(q) {
    D.loading();
    var state = { client: q.client || '', category: '', flagged: false, q: '' };
    var tbody = h('tbody'); var count = h('p', { class: 'empty', style: 'margin-top:12px' });
    var clients = [];
    function params(csv) {
      var p = new URLSearchParams();
      if (state.client) p.set('client_id', state.client); if (state.category) p.set('category', state.category);
      if (state.flagged) p.set('flagged', '1'); if (state.q) p.set('q', state.q); if (csv) p.set('format', 'csv');
      return p.toString();
    }
    var timer = null;
    function load() {
      desk('GET', '/audit?' + params()).then(function (r) {
        clients = r.clients;
        tbody.innerHTML = '';
        r.items.forEach(function (e) {
          var cat = CAT[e.category] || [e.category, '#fff'];
          tbody.appendChild(h('tr', null,
            h('td', { style: 'white-space:nowrap', text: stamp(e.at) }),
            h('td', { style: 'white-space:nowrap;font-weight:600' }, e.client_id ? h('a', { href: '#/clients/' + e.client_id, text: e.client }) : '—'),
            h('td', { style: 'white-space:nowrap' }, h('span', { style: 'display:inline-flex;gap:8px;align-items:center;font-weight:600' }, h('span', { style: 'width:8px;height:8px;border-radius:50%;background:' + cat[1], 'aria-hidden': 'true' }), e.event),
              e.flagged ? h('span', { class: 'st overdue', style: 'margin-left:8px', text: 'Review' }) : null),
            h('td', { text: e.detail }),
            h('td', { style: 'white-space:nowrap', text: e.actor }),
            h('td', { style: 'white-space:nowrap;color:var(--mute);font-size:13px', text: [e.ip, e.device].filter(Boolean).join(' · ') || '—' })));
        });
        if (!r.items.length) tbody.appendChild(h('tr', null, h('td', { colspan: 6, class: 'empty', text: 'No activity matches these filters.' })));
        count.textContent = 'Showing ' + r.items.length + ' event' + (r.items.length === 1 ? '' : 's') + '. Entries can’t be edited or deleted.';
        paintClients();
      }).catch(function (x) { toast(x.message, true); });
    }
    var clientSel = h('select', { class: 'search', style: 'max-width:260px;border-radius:12px', 'aria-label': 'Client', onchange: function (e) { state.client = e.target.value; load(); } });
    function paintClients() {
      var cur = state.client; clientSel.innerHTML = '';
      clientSel.appendChild(h('option', { value: '', text: 'All clients' }));
      clients.forEach(function (c) { clientSel.appendChild(h('option', { value: c.id, text: c.name, selected: c.id === cur ? 'selected' : null })); });
      if (cur && !clients.some(function (c) { return c.id === cur; })) clientSel.appendChild(h('option', { value: cur, text: 'This client', selected: 'selected' }));
    }
    var chips = [['', 'All Events']].concat(Object.keys(CAT).map(function (k) { return [k, CAT[k][0] + (k === 'security' || k === 'billing' ? '' : 's')]; })).map(function (c) {
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.category === c[0]), text: c[1], onclick: function (e) {
        state.category = c[0]; e.target.parentNode.querySelectorAll('.chip[data-cat]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === e.target)); }); load();
      }, 'data-cat': c[0] || 'all' });
    });
    chips.push(h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', text: 'Needs Review', onclick: function (e) { state.flagged = !state.flagged; e.target.setAttribute('aria-pressed', String(state.flagged)); load(); } }));
    var search = h('input', { class: 'search', type: 'search', placeholder: 'Search events, files, invoices', 'aria-label': 'Search the activity log', oninput: function (e) {
      clearTimeout(timer); timer = setTimeout(function () { state.q = e.target.value.trim(); load(); }, 250);
    } });
    D.render(D.pageHead('Client Portal', 'Activity Log', [btn('Export CSV', function () { location.href = '/api/admin/desk/audit?' + params(true); }, 'ghost')]),
      h('p', { class: 'empty', style: 'margin:-6px 0 18px;max-width:720px', text: 'Every sign-in, view, download, approval and payment in client portals, plus portal changes made here. Turn portal access on from a client’s Overview tab.' }),
      h('div', { class: 'toolbar' }, clientSel, search),
      h('div', { class: 'toolbar' }, chips),
      h('div', { class: 'card flush' }, h('div', { style: 'overflow-x:auto' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['When', 'Client', 'Event', 'Details', 'By', 'IP · Device'].map(function (t) { return h('th', { text: t }); }))), tbody))),
      count);
    paintClients();
    load();
  }

  window.DeskPortal = { clientPanel: clientPanel, shareToggle: shareToggle, route: function (p, q) { return auditView(q); } };
})();
