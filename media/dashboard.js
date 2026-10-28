// ccshift dashboard. Renders state sent by the extension.
// All text is set with textContent; no HTML from data is ever parsed.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const accountsEl = document.getElementById('accounts');
  const noticesEl = document.getElementById('notices');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function send(action, id) {
    vscode.postMessage({ type: 'action', action: action, id: id });
  }

  function button(label, action, id, opts) {
    const b = el('button', 'btn' + (opts && opts.primary ? ' primary' : ''), label);
    b.type = 'button';
    if (opts && opts.title) b.title = opts.title;
    if (opts && opts.disabled) b.disabled = true;
    b.addEventListener('click', function () {
      send(action, id);
    });
    return b;
  }

  function usageBlock(title, w) {
    const block = el('div', 'usage');
    const head = el('div', 'usage-head');
    head.appendChild(el('span', 'usage-title', title));
    const pct = el('span', 'usage-pct sev-' + w.severity + (w.percent === undefined ? ' unknown' : ''), w.percentLabel);
    head.appendChild(pct);
    block.appendChild(head);

    const bar = el('div', 'bar' + (w.percent === undefined ? ' bar-unknown' : ''));
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', title);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    if (w.percent !== undefined) {
      bar.setAttribute('aria-valuenow', String(Math.round(w.percent)));
      const fill = el('div', 'fill sev-' + w.severity);
      fill.style.width = Math.max(0, Math.min(100, w.percent)) + '%';
      bar.appendChild(fill);
    } else {
      bar.setAttribute('aria-valuetext', 'unknown');
    }
    block.appendChild(bar);
    const reset = el('div', 'reset', w.resetLabel);
    if (w.resetTooltip) reset.title = w.resetTooltip;
    block.appendChild(reset);
    return block;
  }

  function card(a) {
    const c = el('section', 'card' + (a.isActive ? ' active' : ''));
    c.setAttribute('aria-label', a.name + (a.isActive ? ' (active)' : ''));
    c.style.setProperty('--account-color', 'var(--vscode-charts-' + a.color + ')');

    const header = el('div', 'card-head');
    const name = el('div', 'name', a.name);
    name.title = a.configDir;
    header.appendChild(name);
    if (a.isActive) {
      header.appendChild(el('span', 'badge active-badge', 'ACTIVE'));
    } else {
      header.appendChild(button('Switch', 'switch', a.id, { primary: true, title: 'Make this the active Claude account' }));
    }
    c.appendChild(header);

    const meta = el('div', 'meta');
    const parts = [];
    if (a.plan) parts.push(a.plan);
    if (a.email) parts.push(a.email);
    meta.textContent = parts.length ? parts.join(' · ') : a.authState === 'unauthenticated' ? 'Not signed in' : 'Plan unknown';
    c.appendChild(meta);

    const tags = el('div', 'tags');
    if (a.isDefault) tags.appendChild(el('span', 'tag', 'Default'));
    if (a.isWorkspace) tags.appendChild(el('span', 'tag', 'This workspace'));
    if (a.authState === 'unauthenticated') tags.appendChild(el('span', 'tag warn', 'Sign-in required'));
    if (a.authState === 'error') tags.appendChild(el('span', 'tag warn', 'Sign-in check failed'));
    if (tags.childNodes.length) c.appendChild(tags);

    c.appendChild(usageBlock('5-HOUR USAGE', a.fiveHour));
    c.appendChild(usageBlock('WEEKLY USAGE', a.sevenDay));

    const foot = el('div', 'foot');
    const status = el('span', 'state state-' + a.usageState, a.refreshing ? 'Updating…' : a.usageStateLabel);
    foot.appendChild(status);
    if (a.updatedLabel) {
      const upd = el('span', 'updated', a.updatedLabel);
      if (a.updatedTooltip) upd.title = a.updatedTooltip;
      foot.appendChild(upd);
    }
    c.appendChild(foot);
    if (a.errorMessage) c.appendChild(el('div', 'error', a.errorMessage));

    const actions = el('div', 'actions');
    actions.appendChild(button('Refresh', 'refresh', a.id, { disabled: a.refreshing, title: 'Ask Claude Code for current usage' }));
    if (a.authState !== 'authenticated') {
      actions.appendChild(button('Sign in', 'reauth', a.id));
    }
    const more = el('select', 'more');
    more.setAttribute('aria-label', 'More actions for ' + a.name);
    const options = [
      ['', 'More…'],
      ['rename', 'Rename'],
      ['reauth', 'Reauthenticate'],
      ['setWorkspace', 'Use for this workspace'],
      ['setDefault', 'Set as default'],
      ['collector', 'Status-line collector…'],
    ];
    if (a.kind !== 'default') options.push(['remove', 'Remove…']);
    options.forEach(function (o) {
      const opt = el('option', null, o[1]);
      opt.value = o[0];
      more.appendChild(opt);
    });
    more.addEventListener('change', function () {
      const v = more.value;
      more.value = '';
      if (v) send(v, a.id);
    });
    actions.appendChild(more);
    c.appendChild(actions);
    return c;
  }

  function render(state) {
    noticesEl.replaceChildren();
    (state.notices || []).forEach(function (n) {
      noticesEl.appendChild(el('div', 'notice ' + n.level, n.text));
    });
    accountsEl.replaceChildren();
    (state.accounts || []).forEach(function (a) {
      accountsEl.appendChild(card(a));
    });
    const add = el('div', 'add-row');
    add.appendChild(button('Add account', 'add'));
    add.appendChild(button('Refresh all', 'refreshAll'));
    add.appendChild(button('Diagnose', 'diagnose'));
    accountsEl.appendChild(add);
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.type === 'state' && msg.state) render(msg.state);
  });
  vscode.postMessage({ type: 'ready' });
})();
