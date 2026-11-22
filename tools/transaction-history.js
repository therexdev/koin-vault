'use strict';

// Account history includes receipt events for recipients as well as senders.
// Never infer successful transfers from operation arguments: reverted calls
// can contain exactly the same arguments as successful calls.
const { Serializer, utils } = require('koilib');
const { NETWORKS, rpcCandidates, rpc } = require('./rpc');
const Amounts = require('../public/js/token-amounts');
const abi = structuredClone(require('../abi/token-abi.json'));
if (abi.koilib_types.nested?.koinos?.nested) {
  delete abi.koilib_types.nested.koinos.nested.btype;
  delete abi.koilib_types.nested.koinos.nested._btype;
}
const serializer = new Serializer(abi.koilib_types);
const PAGE_SIZE = 20;
const HEAD_CACHE_MS = 15000;
const MAX_HEAD_AGE_MS = 5 * 60 * 1000;
const MAX_HEAD_LAG = 120n;
const hash = value => typeof value === 'string' && /^0x1220[0-9a-f]{64}$/i.test(value);
const sequence = value => /^\d{1,20}$/.test(String(value)) && BigInt(value) <= 18446744073709551615n;
const timestamp = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 8640000000000000 ? Number(value) : null;
const failure = (message, status = 503) => Object.assign(new Error(message), { status });

function boundedSet(map, key, value, max = 256) {
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

function createHistoryService({ network, urls, call = rpc, now = Date.now } = {}) {
  const net = NETWORKS[network];
  if (!net) throw new Error('Unknown history network');
  const endpoints = urls || (process.env.KOINOS_HISTORY_RPC || '').split(',').map(x => x.trim()).filter(Boolean);
  // A hosting override must not strand history on a retired or stalled node.
  // Explicitly injected URLs remain isolated for private/test deployments.
  const candidates = [...new Set(urls || [...endpoints, ...rpcCandidates(network), ...net.rpcs])].filter(Boolean);
  const pages = new Map(), pending = new Map(), metadata = new Map();
  let preferred = candidates[0];
  let heads = { until: 0, work: null };

  async function sources(deadline) {
    if (!heads.work || heads.until <= now()) {
      const work = Promise.all(candidates.map(async url => {
        try {
          const remaining = deadline - now();
          if (remaining <= 0) return null;
          const head = await call(url, 'chain.get_head_info', {}, Math.min(4000, remaining));
          const height = head?.head_topology?.height;
          const time = timestamp(head?.head_block_time);
          if (!sequence(height) || BigInt(height) === 0n || !time
              || now() - time > MAX_HEAD_AGE_MS || time - now() > 60000) return null;
          return { url, height: BigInt(height) };
        } catch (_) { return null; }
      })).then(results => {
        const healthy = results.filter(Boolean);
        if (!healthy.length) throw failure('Transaction history is temporarily unavailable. Please try again.');
        const latest = healthy.reduce((height, node) => node.height > height ? node.height : height, 0n);
        return healthy.filter(node => latest - node.height <= MAX_HEAD_LAG).map(node => node.url);
      });
      heads = { until: now() + HEAD_CACHE_MS, work };
      work.catch(() => { if (heads.work === work) heads = { until: 0, work: null }; });
    }
    const healthy = await heads.work;
    return [...new Set([preferred, ...healthy])].filter(url => healthy.includes(url));
  }

  async function request(method, params, deadline) {
    let empty;
    for (const url of await sources(deadline)) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      try {
        const result = await call(url, method, params, Math.min(12000, remaining));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid RPC response');
        if (method === 'account_history.get_account_history' && result.values != null && !Array.isArray(result.values)) throw new Error('Invalid history response');
        if (method === 'account_history.get_account_history') {
          const values = result.values || [];
          if (values.length > PAGE_SIZE || values.some(e => !sequence(e.seq_num ?? '0') || (!e.trx && !e.block))
              || (params.seq_num != null && values.some(e => BigInt(e.seq_num ?? '0') > BigInt(params.seq_num)))) {
            throw new Error('Invalid history response');
          }
          // A lagging history index can return {} even while its chain node
          // is healthy. Confirm an empty page with the remaining sources.
          if (!values.length) { empty = result; continue; }
          preferred = url;
        }
        return result;
      } catch (_) { /* Try another configured node; errors must not become an empty feed. */ }
    }
    if (empty) return empty;
    throw failure('Transaction history is temporarily unavailable. Please try again.');
  }

  function nativeToken(address) {
    if (address === net.koinContract || net.legacyKoinContracts?.includes(address)) {
      return { symbol: net.nativeSymbol, decimals: 8, contract: net.koinContract };
    }
    if (address === net.vhpContract || net.legacyVhpContracts?.includes(address)) {
      return { symbol: 'VHP', decimals: 8, contract: net.vhpContract };
    }
    return null;
  }

  async function tokenMeta(address, deadline) {
    const native = nativeToken(address);
    if (native) return { symbol: native.symbol, decimals: native.decimals };
    const cached = metadata.get(address);
    if (cached && cached.until > now()) return cached.value;
    let value = { symbol: 'Token', decimals: null };
    try {
      const read = async name => {
        const method = abi.methods[name];
        const args = method.argument ? utils.encodeBase64url(await serializer.serialize({}, method.argument)) : '';
        const result = await request('chain.read_contract', { contract_id: address, entry_point: method.entry_point, args }, deadline);
        return (await serializer.deserialize(result.result, method.return)).value;
      };
      const [symbol, decimals] = await Promise.all([read('symbol'), read('decimals')]);
      const d = Number(decimals);
      if (!Amounts.validDecimals(d)) throw new Error('Invalid decimals');
      value = { symbol: String(symbol || 'Token').slice(0, 32), decimals: d };
    } catch (_) { /* Retain raw units when metadata is unavailable. Never guess decimals. */ }
    boundedSet(metadata, address, { value, until: now() + (value.decimals == null ? 30000 : 3600000) });
    return value;
  }

  async function movements(events, address) {
    const result = [];
    for (const event of events || []) {
      const match = /^(?:koinos\.contracts\.)?token\.(transfer|mint|burn)_event$/.exec(event.name || '');
      if (!match || !event.source || typeof event.data !== 'string') continue;
      try {
        const type = match[1];
        const data = await serializer.deserialize(event.data, `token.${type}_event`);
        const from = data.from || null, to = data.to || null;
        if (from !== address && to !== address) continue;
        const units = String(data.value ?? '0');
        if (Amounts.fromUnits(units, 0) == null) continue;
        const native = nativeToken(event.source);
        result.push({ contract: event.source, type, from, to, units,
          ...(native && native.contract !== event.source ? { assetContract: native.contract } : {}),
          direction: from === address && to === address ? 'self' : to === address ? 'received' : 'sent' });
      } catch (_) { /* A nonstandard event remains visible as generic contract activity. */ }
    }
    return result;
  }

  // Transaction history records have no timestamp. Resolve their containing
  // blocks in two batched reads. Missing/pruned block data leaves dates unknown.
  async function dates(entries, deadline) {
    const result = new Map();
    const ids = entries.map(e => e.trx?.transaction?.id).filter(hash);
    if (!ids.length) return result;
    try {
      const txs = await request('transaction_store.get_transactions_by_id', { transaction_ids: ids }, deadline);
      const txBlocks = new Map((txs.transactions || []).filter(t => t.containing_blocks?.length === 1)
        .map(t => [t.transaction?.id, t.containing_blocks[0]]));
      const blockIds = [...new Set([...txBlocks.values()].filter(hash))];
      if (!blockIds.length) return result;
      const blocks = await request('block_store.get_blocks_by_id', { block_ids: blockIds, return_block: true, return_receipt: false }, deadline);
      const headers = new Map((blocks.block_items || []).map(b => [b.block_id, b.block?.header]));
      for (const [id, blockId] of txBlocks) {
        const header = headers.get(blockId);
        if (header) result.set(id, { timestamp: timestamp(header.timestamp), blockHeight: String(header.height || '') });
      }
    } catch (_) { /* History still works without the optional date lookup. */ }
    return result;
  }

  async function load(address, cursor) {
    const deadline = now() + 48000;
    const params = { address, limit: String(PAGE_SIZE), ascending: false, irreversible: false };
    if (cursor != null) params.seq_num = cursor;
    const response = await request('account_history.get_account_history', params, deadline);
    // Protobuf JSON omits repeated fields when empty, so {} is a valid empty page.
    const values = response.values || [];
    if (values.length > PAGE_SIZE || values.some(e => !sequence(e.seq_num ?? '0') || (!e.trx && !e.block))) {
      throw failure('Transaction history returned an invalid page. Please try again.');
    }
    const entries = values.map(e => ({ ...e, seq_num: String(e.seq_num ?? '0') }))
      .sort((a, b) => BigInt(a.seq_num) > BigInt(b.seq_num) ? -1 : BigInt(a.seq_num) < BigInt(b.seq_num) ? 1 : 0);
    if (cursor != null && entries.some(e => BigInt(e.seq_num) > BigInt(cursor))) throw failure('Transaction history returned an invalid page. Please try again.');
    const dateLookup = dates(entries, deadline);
    const items = [];
    for (const entry of entries) {
      const tx = entry.trx?.transaction;
      const record = entry.trx || entry.block;
      const receipt = record.receipt || {};
      const id = tx?.id || receipt.id;
      if (!hash(id)) continue;
      const reverted = receipt.reverted === true;
      const changes = reverted ? [] : await movements(receipt.events, address);
      const isBlock = !!entry.block;
      const title = reverted ? 'Transaction failed' : isBlock ? 'Node activity'
        : tx?.operations?.some(o => o.upload_contract) ? 'Account updated' : 'Contract interaction';
      items.push({ id, key: `${isBlock ? 'block' : 'tx'}:${id}`, sequence: entry.seq_num,
        kind: isBlock ? 'block' : 'transaction', title, status: reverted ? 'failed' : 'confirmed',
        timestamp: isBlock ? timestamp(entry.block.header?.timestamp) : null,
        blockHeight: isBlock ? String(entry.block.header?.height || '') : null,
        movements: changes, explorer: `${net.explorer}/${isBlock ? 'block' : 'tx'}/${id}` });
    }
    // Cap and stagger metadata fan-out independently of the number of events.
    const contracts = [...new Set(items.flatMap(item => item.movements.map(m => m.contract)))].slice(0, 14);
    const meta = new Map();
    for (let i = 0; i < contracts.length; i += 4) {
      await Promise.all(contracts.slice(i, i + 4).map(async contract => meta.set(contract, await tokenMeta(contract, deadline))));
    }
    const dateMap = await dateLookup;
    for (const item of items) {
      if (dateMap.has(item.id)) Object.assign(item, dateMap.get(item.id));
      for (const m of item.movements) {
        const info = meta.get(m.contract) || { symbol: 'Token', decimals: null };
        Object.assign(m, info, { amount: info.decimals == null ? null : Amounts.fromUnits(m.units, info.decimals) });
      }
    }
    const last = entries.at(-1)?.seq_num;
    const nextCursor = entries.length === PAGE_SIZE && BigInt(last) > 0n ? String(BigInt(last) - 1n) : null;
    return { ok: true, address, network, items, nextCursor, fetchedAt: now() };
  }

  return {
    async get(address, cursor = null) {
      if (cursor != null && !sequence(cursor)) throw failure('Invalid transaction history cursor', 400);
      const key = `${address}:${cursor ?? 'latest'}`;
      const cached = pages.get(key);
      if (cached && cached.until > now()) return cached.value;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 24) throw failure('Transaction history is busy. Please try again.');
      const work = load(address, cursor).then(value => {
        boundedSet(pages, key, { value, until: now() + 8000 });
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
      return work;
    },
  };
}

module.exports = { createHistoryService, PAGE_SIZE };
