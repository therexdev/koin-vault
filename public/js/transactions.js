'use strict';

const Transactions = (() => {
  const short = value => value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '';
  const label = m => m.direction === 'self' ? 'Self transfer' : m.type === 'burn' ? 'Burned'
    : m.type === 'mint' ? 'Received' : m.direction === 'received' ? 'Received' : 'Sent';
  const amount = m => `${m.direction === 'received' ? '+' : m.direction === 'sent' ? '−' : ''}${m.amount ?? m.units} ${m.amount == null ? 'raw units' : m.symbol}`;

  function createController({ api, onChange = () => {}, network, now = Date.now }) {
    let generation = 0, queued = false;
    let state = { address: null, items: [], cursor: null, loading: false, loaded: false, error: '', expanded: false, demo: false, updated: 0 };
    const emit = () => onChange({ ...state });
    function reset(address = null) {
      generation++; queued = false;
      state = { address, items: [], cursor: null, loading: false, loaded: false, error: '', expanded: false, demo: false, updated: 0 };
      emit();
    }
    async function refresh({ more = false, automatic = false } = {}) {
      if (!state.address || (more && state.cursor == null)) return;
      // Do not collapse older history or move someone's reading position on a timer.
      if (automatic && (state.expanded || now() - state.updated < 25000)) return;
      if (state.loading) { if (!automatic && !more) queued = true; return; }
      const gen = generation, address = state.address;
      const cursor = more ? state.cursor : null;
      state.loading = true; state.error = ''; emit();
      try {
        const data = await api('/api/transactions?address=' + encodeURIComponent(address)
          + (cursor == null ? '' : '&cursor=' + encodeURIComponent(cursor)));
        if (gen !== generation) return;
        if (data.ok !== true || data.address !== address || (network && data.network !== network)
            || !Array.isArray(data.items) || (data.nextCursor != null && !/^\d{1,20}$/.test(data.nextCursor))) throw new Error('Invalid transaction history response');
        const rows = more ? state.items.concat(data.items) : data.items;
        state.items = [...new Map(rows.map(item => [item.key, item])).values()];
        state.cursor = data.nextCursor ?? null;
        state.loaded = true; state.expanded = more; state.demo = !!data.demo; state.updated = now();
      } catch (_) {
        if (gen === generation) state.error = 'Could not refresh transactions. Please try again.';
      } finally {
        if (gen === generation) {
          state.loading = false; emit();
          if (queued) { queued = false; void refresh(); }
        }
      }
    }
    return { reset, refresh, setAddress(address) { if (state.address !== address) reset(address); }, getState: () => ({ ...state }) };
  }

  function mount({ root, api, cfg }) {
    if (!root) return { reset() {}, setAddress() {}, refresh() {} };
    const list = root.querySelector('#transaction-list'), note = root.querySelector('#transaction-note');
    const refreshButton = root.querySelector('#btn-refresh-transactions'), moreButton = root.querySelector('#btn-more-transactions');
    const filter = root.querySelector('#transaction-filter');
    let filterValue = 'all', snapshot, lastSignature = '';
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };
    function render(state) {
      snapshot = state;
      refreshButton.disabled = state.loading;
      refreshButton.textContent = state.loading ? 'Loading…' : 'Refresh';
      moreButton.hidden = state.cursor == null;
      moreButton.disabled = state.loading;
      list.setAttribute('aria-busy', String(state.loading));
      const rows = state.items.filter(item => filterValue === 'all' || item.movements.some(m => m.direction === filterValue));
      note.textContent = state.error ? state.error + (state.items.length ? ' Showing previously loaded activity.' : '')
        : state.demo ? 'Transaction history is available when the wallet is connected to the live network.'
        : state.loading && !state.loaded ? 'Loading transactions…'
        : !state.loaded ? ''
        : !state.items.length ? 'No transactions found for this wallet.'
        : !rows.length ? 'No matching transactions in the loaded history. Load more to check older activity.'
        : state.expanded ? 'Older activity loaded. Refresh to check for new transactions.' : 'Newest first · Updates every 30 seconds';
      note.classList.toggle('transaction-error', !!state.error);
      const signature = JSON.stringify([state.address, filterValue, rows]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      const opened = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.key));
      list.replaceChildren();
      for (const item of rows) {
        const details = el('details', 'transaction');
        details.dataset.key = item.key; details.open = opened.has(item.key);
        const single = item.movements.length === 1 ? item.movements[0] : null;
        const direction = single?.direction || 'activity';
        const title = single ? label(single) : item.movements.length > 1 ? (item.kind === 'block' ? 'Node rewards' : 'Token activity') : item.title;
        const summary = el('summary', 'transaction-summary');
        const icon = el('span', `transaction-icon ${direction}`);
        icon.setAttribute('aria-hidden', 'true');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'ic ic-18');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', direction === 'received' ? '#i-receive' : direction === 'sent' ? '#i-send' : '#i-wallet');
        svg.append(use); icon.append(svg);
        const middle = el('span', 'transaction-main');
        middle.append(el('span', 'transaction-title', title));
        middle.append(el('span', 'transaction-date', item.timestamp
          ? new Date(item.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
          : 'Date unavailable'));
        if (single) middle.append(el('span', 'transaction-peer', single.direction === 'self' ? 'To your own address'
          : single.type === 'mint' ? 'Mint / reward' : single.type === 'burn' ? 'Token burn'
          : `${single.direction === 'received' ? 'From' : 'To'} ${short(single.direction === 'received' ? single.from : single.to)}`));
        const right = el('span', 'transaction-right');
        right.append(el('span', `transaction-amount ${direction}`, single ? amount(single) : item.movements.length ? `${item.movements.length} token movements` : ''));
        right.append(el('span', `transaction-status ${item.status === 'failed' ? 'failed' : ''}`, item.status === 'failed' ? 'Failed' : 'Confirmed'));
        summary.append(icon, middle, right); details.append(summary);
        const body = el('div', 'transaction-detail');
        const field = (name, value) => { if (value) { const line = el('p'); line.append(el('strong', '', name + ': '), document.createTextNode(value)); body.append(line); } };
        for (const m of item.movements) {
          field(label(m), amount(m)); field('From', m.from); field('To', m.to);
          field('Token contract', m.contract);
        }
        field(item.kind === 'block' ? 'Block ID' : 'Transaction ID', item.id);
        field('Block', item.blockHeight);
        try {
          const link = new URL(item.explorer);
          if (link.protocol === 'https:' && link.origin === new URL(cfg.explorer).origin) {
            const anchor = el('a', 'transaction-explorer', 'View on explorer ↗');
            anchor.href = link.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; body.append(anchor);
          }
        } catch (_) {}
        details.append(body); list.append(details);
      }
      list.hidden = !rows.length;
    }
    const controller = createController({ api, onChange: render, network: cfg.network });
    refreshButton.addEventListener('click', () => { void controller.refresh(); });
    moreButton.addEventListener('click', () => { void controller.refresh({ more: true }); });
    filter.addEventListener('change', () => { filterValue = filter.value; if (snapshot) render(snapshot); });
    return controller;
  }
  return { createController, mount, amount };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Transactions;
