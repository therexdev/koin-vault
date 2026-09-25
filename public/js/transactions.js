'use strict';

const Transactions = (() => {
  const short = value => value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '';
  const amount = m => {
    const [whole, fraction] = String(m.amount ?? m.units).split('.');
    const number = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
    return `${number} ${m.amount == null ? 'raw units' : m.symbol}`;
  };

  function tokenItems(items, token) {
    if (!token?.address) return [];
    return items.filter(item => item.status !== 'failed').map(item => ({ ...item,
      movements: (item.movements || []).filter(m => m.contract === token.address),
    })).filter(item => item.movements.length);
  }

  function movementRows(items, token) {
    return tokenItems(items, token).flatMap(item => item.movements.map((m, index) => {
      const received = m.direction === 'received';
      const node = item.kind === 'block' && ['koin', 'vhp'].includes(token.id);
      const note = m.direction === 'self' ? 'Self transfer'
        : m.type === 'mint' ? (node ? 'Node reward' : 'Mint')
          : m.type === 'burn' ? (node ? 'Node burn' : 'Burn') : '';
      return { key: `${item.key}:${index}`, direction: received ? 'received' : 'sent',
        label: received ? 'Received' : 'Sent', amount: amount(m),
        peer: received ? m.from : m.to, prefix: received ? 'from' : 'to', note,
        timestamp: item.timestamp, explorer: item.explorer };
    }));
  }

  function createController({ api, onChange = () => {}, network, now = Date.now }) {
    let generation = 0, queued = false, state;
    const emit = () => onChange({ ...state });
    function reset(address = null, token = null) {
      generation++; queued = false;
      state = { address, token, items: [], cursor: null, loading: false, loaded: false,
        error: '', retryMore: false, expanded: false, demo: false, updated: 0 };
      emit();
    }
    reset();
    async function refresh({ more = false, automatic = false } = {}) {
      if (!state.address || !state.token?.address || (more && state.cursor == null)) return;
      // Keep an expanded list and its reading position until the token is reopened.
      if (automatic && (state.expanded || now() - state.updated < 25000)) return;
      if (state.loading) { if (!automatic && !more) queued = true; return; }
      const gen = generation, address = state.address, token = state.token;
      let cursor = more ? state.cursor : null;
      let items = more ? state.items : [];
      const startingCount = items.reduce((n, item) => n + item.movements.length, 0);
      state.loading = true; state.error = ''; emit();
      try {
        let data;
        // Account pages contain other tokens too. Scan a bounded batch until
        // we have 20 more movements, then leave the remaining cursor to Load more.
        // Commit the batch together so a failed read preserves the last good list.
        for (let page = 0; page < 3; page++) {
          data = await api('/api/transactions?address=' + encodeURIComponent(address)
            + (cursor == null ? '' : '&cursor=' + encodeURIComponent(cursor)));
          if (gen !== generation) return;
          if (data.ok !== true || data.address !== address || (network && data.network !== network)
              || !Array.isArray(data.items) || (data.nextCursor != null && !/^\d{1,20}$/.test(data.nextCursor))
              || (cursor != null && data.nextCursor != null && BigInt(data.nextCursor) >= BigInt(cursor))) {
            throw new Error('Invalid transaction history response');
          }
          items = [...new Map(items.concat(tokenItems(data.items, token)).map(item => [item.key, item])).values()];
          cursor = data.nextCursor ?? null;
          if (cursor == null || items.reduce((n, item) => n + item.movements.length, 0) >= startingCount + 20) break;
        }
        state.items = items; state.cursor = cursor;
        state.loaded = true; state.expanded = more; state.demo = !!data.demo; state.updated = now();
      } catch (error) {
        if (gen === generation) {
          state.error = error.status === 503 && /^Wallet startup failed\b/.test(error.message || '')
            ? 'The wallet service could not start. Activity will be available once the service is restored.'
            : error.status === 503 && /^Wallet is starting\b/.test(error.message || '')
              ? 'The wallet service is starting. Please try again shortly.'
              : error.status === 429
                ? 'Too many requests. Please wait a moment and try again.'
                : 'Could not load activity. Please try again.';
          state.retryMore = more;
        }
      } finally {
        if (gen === generation) {
          state.loading = false; emit();
          if (queued) { queued = false; void refresh(); }
        }
      }
    }
    return { reset, refresh,
      setAddress(address) { if (state.address !== address) reset(address); },
      setToken(token) { if (state.token?.address !== token?.address) reset(state.address, token || null); },
      getState: () => ({ ...state }),
    };
  }

  function mount({ root, api, cfg }) {
    if (!root) return { reset() {}, setAddress() {}, setToken() {}, refresh() {} };
    const list = root.querySelector('#transaction-list'), note = root.querySelector('#transaction-note');
    const moreButton = root.querySelector('#btn-more-transactions');
    let snapshot, lastSignature = '';
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };
    function render(state) {
      snapshot = state;
      moreButton.hidden = state.cursor == null && !state.error;
      moreButton.disabled = state.loading;
      moreButton.textContent = state.loading ? 'Loading…' : state.error ? 'Try again' : 'Load more';
      list.setAttribute('aria-busy', String(state.loading));
      const rows = movementRows(state.items, state.token);
      note.textContent = state.error ? state.error + (rows.length ? ' Showing previously loaded activity.' : '')
        : state.demo ? 'Activity is available when the wallet is connected to the live network.'
          : state.loading && !state.loaded ? 'Loading activity…'
            : !state.loaded ? ''
              : !rows.length ? (state.cursor == null ? 'No activity for this token yet.' : 'No activity found yet. Load more to look further back.') : '';
      note.hidden = !note.textContent;
      note.classList.toggle('transaction-error', !!state.error);
      const signature = JSON.stringify([state.address, state.token?.address, rows]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      list.replaceChildren();
      for (const row of rows) {
        const entry = el('div', 'transaction'); entry.setAttribute('role', 'listitem');
        let href;
        try {
          const url = new URL(row.explorer);
          if (url.protocol === 'https:' && url.origin === new URL(cfg.explorer).origin) href = url.href;
        } catch (_) {}
        const body = el(href ? 'a' : 'div', 'transaction-row');
        if (href) { body.href = href; body.target = '_blank'; body.rel = 'noopener noreferrer'; }
        body.append(el('span', 'transaction-title', row.label));
        body.append(el('span', `transaction-amount ${row.direction}`, row.amount));
        const peer = el('span', 'transaction-peer', row.peer ? `${row.prefix} ${short(row.peer)}` : row.note);
        if (row.peer) peer.title = `${row.prefix} ${row.peer}`;
        body.append(peer);
        const date = row.timestamp ? new Date(row.timestamp) : null;
        const dateText = date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric',
          ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }) : '';
        const when = el('span', 'transaction-date', dateText);
        if (date) when.title = date.toLocaleString();
        body.append(when);
        if (row.peer && row.note) body.append(el('span', 'transaction-note', row.note));
        body.setAttribute('aria-label', `${row.label} ${row.amount}${row.peer ? ` ${row.prefix} ${row.peer}` : ''}${row.note ? ', ' + row.note : ''}${date ? ', ' + date.toLocaleString() : ''}${href ? '. View on explorer' : ''}`);
        entry.append(body); list.append(entry);
      }
      list.hidden = !rows.length;
    }
    const controller = createController({ api, onChange: render, network: cfg.network });
    moreButton.addEventListener('click', () => {
      void controller.refresh({ more: snapshot.error ? snapshot.retryMore : true });
    });
    return controller;
  }
  return { createController, mount, amount, movementRows };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Transactions;
