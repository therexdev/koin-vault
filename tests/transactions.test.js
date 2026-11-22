'use strict';
const assert = require('node:assert/strict');
const { Serializer, Signer, utils } = require('koilib');
const { createHistoryService, PAGE_SIZE } = require('../tools/transaction-history');
const { NETWORKS } = require('../tools/rpc');
const { createController, amount, movementRows } = require('../public/js/transactions');
const A = Signer.fromSeed('history-owner').getAddress(), B = Signer.fromSeed('history-recipient').getAddress();
const CUSTOM = Signer.fromSeed('history-custom-token').getAddress();
const { koinContract: KOIN, vhpContract: VHP } = NETWORKS.mainnet;
const koinToken = { id: 'koin', address: KOIN }, vhpToken = { id: 'vhp', address: VHP };
const id = n => '0x1220' + n.toString(16).padStart(64, '0');
const head = (height = '1000', time = Date.now()) => ({ head_topology: { height }, head_block_time: String(time) });
const abi = structuredClone(require('../abi/token-abi.json'));
delete abi.koilib_types.nested.koinos.nested.btype;
delete abi.koilib_types.nested.koinos.nested._btype;
const ser = new Serializer(abi.koilib_types);
const event = async (source, type, data) => ({ source, name: 'token.' + type + '_event',
  data: utils.encodeBase64url(await ser.serialize(data, 'token.' + type + '_event')) });
const tx = (n, events, extra = {}) => ({ seq_num: String(n), trx: { transaction: { id: id(n), operations: [{ call_contract: {} }] }, receipt: { events, ...extra } } });

(async () => {
  const incoming = await event(KOIN, 'transfer', { from: B, to: A, value: '1' });
  const outgoing = await event(VHP, 'transfer', { from: A, to: B, value: '18446744073709551615' });
  const custom = await event(CUSTOM, 'transfer', { from: B, to: A, value: '9007199254740993' });
  const self = await event(KOIN, 'transfer', { from: A, to: A, value: '100000000' });
  const foreign = await event(KOIN, 'transfer', { from: B, to: KOIN, value: '50' });
  const values = [tx(25, [incoming, foreign]), tx(24, [outgoing]), tx(23, [custom]), tx(22, [self]), tx(21, [incoming], { reverted: true }),
    { seq_num: '20', block: { header: { timestamp: '1789524581650', height: '123' }, receipt: { id: id(20), events: [
      await event(KOIN, 'mint', { to: A, value: '250000000' }), await event(VHP, 'burn', { from: A, value: '200000000' })] } } },
    ...Array.from({ length: PAGE_SIZE - 6 }, (_, i) => tx(19 - i, []))];
  const calls = [];
  const call = async (url, method, params) => {
    calls.push({ url, method, params });
    if (url === 'down') throw new Error('unavailable');
    if (method === 'chain.get_head_info') return head();
    if (method === 'account_history.get_account_history') return { values: params.seq_num ? [tx(5, [incoming])] : values };
    if (method === 'transaction_store.get_transactions_by_id') return { transactions: params.transaction_ids.map(transactionId => ({ transaction: { id: transactionId }, containing_blocks: [id(999)] })) };
    if (method === 'block_store.get_blocks_by_id') return { block_items: [{ block_id: id(999), block: { header: { timestamp: '1789524581650', height: '123' } } }] };
    if (method === 'chain.read_contract') {
      assert.equal(params.contract_id, CUSTOM); assert.equal(params.args, '');
      return { result: params.entry_point === abi.methods.symbol.entry_point ? await ser.serialize({ value: '<script>COIN</script>' }, 'token.str') : await ser.serialize({ value: 6 }, 'token.uint32') };
    }
    throw new Error('Unexpected method ' + method);
  };
  const service = createHistoryService({ network: 'mainnet', urls: ['down', 'up'], call });
  const [page, same] = await Promise.all([service.get(A), service.get(A)]);
  assert.equal(page, same, 'Concurrent requests share work');
  assert.equal(page.items.length, 20); assert.equal(page.nextCursor, '5');
  assert.equal(page.items[0].movements.length, 1, 'Unrelated events never affect wallet activity');
  assert.equal(page.items[0].movements[0].amount, '0.00000001');
  assert.equal(page.items[1].movements[0].amount, '184467440737.09551615');
  assert.equal(page.items[1].movements[0].direction, 'sent');
  assert.equal(page.items[2].movements[0].amount, '9007199254.740993');
  assert.equal(page.items[3].movements[0].direction, 'self');
  assert.equal(page.items[4].status, 'failed'); assert.deepEqual(page.items[4].movements, []);
  assert.equal(page.items[5].movements.length, 2); assert.equal(page.items[5].kind, 'block');
  assert.equal(page.items[0].timestamp, 1789524581650);
  assert.equal(page.items[0].explorer, 'https://koinosblocks.com/tx/' + id(25));
  assert.equal((await service.get(A, page.nextCursor)).items[0].id, id(5));
  const count = calls.length; await service.get(A); assert.equal(calls.length, count, 'Short page cache');
  await assert.rejects(service.get(A, '-1'), /Invalid.*cursor/);
  await assert.rejects(service.get(A, '18446744073709551616'), /Invalid.*cursor/);
  console.log('✓ Incoming, outgoing, self, custom precision, reverted calls, rewards, dates, failover and pagination');

  const unavailable = createHistoryService({ network: 'mainnet', urls: ['down'], call });
  await assert.rejects(unavailable.get(A), /temporarily unavailable/);
  const empty = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => method === 'chain.get_head_info' ? head() : {} });
  assert.deepEqual((await empty.get(A)).items, []);
  const missingMeta = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => {
    if (method === 'chain.get_head_info') return head();
    if (method === 'account_history.get_account_history') return { values: [tx(1, [custom])] };
    throw new Error('Unavailable');
  } });
  const unknown = (await missingMeta.get(A)).items[0];
  assert.equal(unknown.timestamp, null); assert.equal(unknown.movements[0].amount, null);
  assert.equal(unknown.movements[0].units, '9007199254740993');
  assert.equal(amount(unknown.movements[0]), '9,007,199,254,740,993 raw units');
  assert.equal(amount(page.items[1].movements[0]), '184,467,440,737.09551615 VHP');
  const zero = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => method === 'chain.get_head_info' ? head()
    : method === 'account_history.get_account_history' ? { values: [{ ...tx(0, []), seq_num: undefined }] } : {} });
  assert.equal((await zero.get(A)).items[0].sequence, '0'); assert.equal((await zero.get(A)).nextCursor, null);
  console.log('✓ Outages stay errors; missing metadata and timestamps are never invented; sequence zero works');

  // Reproduce production: a configured endpoint still answers but its old
  // history hides the new contracts. Current public nodes remain fallbacks.
  {
    const beforeHistory = process.env.KOINOS_HISTORY_RPC, beforeRpc = process.env.KOINOS_RPC;
    process.env.KOINOS_HISTORY_RPC = 'stale'; process.env.KOINOS_RPC = 'stale';
    const reads = [];
    try {
      const fresh = createHistoryService({ network: 'mainnet', call: async (url, method) => {
        reads.push({ url, method });
        if (method === 'chain.get_head_info') return head(url === 'stale' ? '500' : '1000', Date.now() - (url === 'stale' ? 86400000 : 0));
        if (method === 'account_history.get_account_history') return url === 'stale' ? {} : { values: [tx(2, [incoming]), tx(1, [outgoing])] };
        return {};
      } });
      const data = await fresh.get(A);
      assert.equal(movementRows(data.items, koinToken).length, 1);
      assert.equal(movementRows(data.items, vhpToken).length, 1);
      assert.ok(!reads.some(r => r.url === 'stale' && r.method === 'account_history.get_account_history'));
      assert.ok(reads.some(r => NETWORKS.mainnet.rpcs.includes(r.url) && r.method === 'account_history.get_account_history'));
    } finally {
      if (beforeHistory == null) delete process.env.KOINOS_HISTORY_RPC; else process.env.KOINOS_HISTORY_RPC = beforeHistory;
      if (beforeRpc == null) delete process.env.KOINOS_RPC; else process.env.KOINOS_RPC = beforeRpc;
    }
    // A freshly timestamped but far-behind node is also excluded. A healthy
    // chain with an empty/stalled index must not mask the next history node.
    const calls = [];
    const fallback = createHistoryService({ network: 'mainnet', urls: ['behind', 'empty-index', 'current'], call: async (url, method) => {
      calls.push({ url, method });
      if (method === 'chain.get_head_info') return head(url === 'behind' ? '800' : '1000');
      if (method === 'account_history.get_account_history') return url === 'current' ? { values: [tx(1, [incoming])] } : {};
      return {};
    } });
    assert.equal((await fallback.get(A)).items.length, 1);
    assert.ok(!calls.some(r => r.url === 'behind' && r.method === 'account_history.get_account_history'));
    assert.ok(calls.some(r => r.url === 'empty-index' && r.method === 'account_history.get_account_history'));
    const staleOnly = createHistoryService({ network: 'mainnet', urls: ['stale'], call: async () => head('1000', Date.now() - 86400000) });
    await assert.rejects(staleOnly.get(A), /temporarily unavailable/);
    let clock = Date.now(), behind = false;
    const choices = [], probes = [];
    const recovering = createHistoryService({ network: 'mainnet', urls: ['preferred', 'fallback'], now: () => clock,
      call: async (url, method) => {
        if (method === 'chain.get_head_info') {
          probes.push(url);
          return head(behind && url === 'preferred' ? '800' : '1000', clock);
        }
        if (method === 'account_history.get_account_history') {
          choices.push(url); return { values: [tx(1, [incoming])] };
        }
        return {};
      } });
    await Promise.all([recovering.get(A), recovering.get(A)]);
    assert.deepEqual(probes, ['preferred', 'fallback'], 'Concurrent reads share freshness probes');
    assert.deepEqual(choices, ['preferred']);
    clock += 16000; behind = true;
    await recovering.get(A);
    assert.deepEqual(choices, ['preferred', 'fallback'], 'A previous successful source is dropped when it falls behind');
    console.log('✓ Stale hosting overrides, lagging heads and empty indexes cannot hide current history; stale-only sources report an outage');
  }

  {
    const oldKoin = NETWORKS.mainnet.legacyKoinContracts[0], oldVhp = NETWORKS.mainnet.legacyVhpContracts[0];
    const legacy = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => {
      if (method === 'chain.get_head_info') return head();
      if (method === 'account_history.get_account_history') return { values: [
        tx(3, [{ ...await event(oldKoin, 'transfer', { from: B, to: A, value: '125000000' }), name: 'koinos.contracts.token.transfer_event' }]),
        tx(2, [await event(oldVhp, 'transfer', { from: A, to: B, value: '250000000' })]),
        tx(1, [custom]),
      ] };
      if (method === 'chain.read_contract') throw new Error('Legacy native contracts do not need a metadata read');
      return {};
    } });
    const data = await legacy.get(A);
    assert.equal(data.items[0].movements[0].contract, oldKoin, 'Keep the real receipt source');
    assert.equal(data.items[0].movements[0].assetContract, KOIN);
    assert.equal(data.items[1].movements[0].assetContract, VHP);
    assert.equal(data.items[2].movements[0].assetContract, undefined, 'A custom contract cannot impersonate native activity');
    assert.equal(movementRows(data.items, koinToken)[0].amount, '1.25 KOIN');
    assert.equal(movementRows(data.items, vhpToken)[0].amount, '2.5 VHP');
    assert.deepEqual(movementRows(data.items, { id: 'koin', address: NETWORKS.harbinger.koinContract }), []);
    assert.deepEqual(movementRows(data.items, { id: 'custom', address: KOIN }), [], 'Aliases apply only to native token sheets');
    console.log('✓ Known retired KOIN/VHP contracts retain history under the current token, without changing source, balances or custom-token identity');
  }

  const koinRows = movementRows(page.items, koinToken), vhpRows = movementRows(page.items, vhpToken);
  assert.deepEqual(koinRows.map(row => row.label), ['Received', 'Sent', 'Received']);
  assert.equal(koinRows[0].peer, B); assert.equal(koinRows[0].prefix, 'from');
  assert.equal(koinRows[1].peer, A); assert.equal(koinRows[1].note, 'Self transfer');
  assert.equal(koinRows[2].note, 'Node reward'); assert.equal(koinRows[2].peer, null, 'Mint has no invented sender');
  assert.deepEqual(vhpRows.map(row => row.label), ['Sent', 'Sent']);
  assert.equal(vhpRows[0].prefix, 'to'); assert.equal(vhpRows[0].peer, B);
  assert.equal(vhpRows[1].note, 'Node burn'); assert.equal(vhpRows[1].peer, null, 'Burn has no invented recipient');
  assert.equal(movementRows(page.items, { address: CUSTOM }).length, 1);
  assert.deepEqual(movementRows(page.items, null), []);
  const impersonator = { ...page.items[0], movements: [{ ...page.items[0].movements[0], contract: CUSTOM, symbol: 'KOIN' }] };
  assert.deepEqual(movementRows([impersonator], koinToken), [], 'Contract identity, not symbol, selects a token');

  let resolveOld;
  const controller = createController({ network: 'mainnet', api: () => new Promise(resolve => { resolveOld = resolve; }) });
  controller.setAddress(A); await controller.refresh();
  assert.equal(resolveOld, undefined, 'History is not fetched until a token opens');
  controller.setToken(koinToken);
  const oldRequest = controller.refresh(); controller.reset(); controller.setAddress(B);
  resolveOld(page); await oldRequest;
  assert.equal(controller.getState().address, B); assert.deepEqual(controller.getState().items, []);
  controller.setAddress(A); controller.setToken(koinToken);
  const switched = controller.refresh(); controller.setToken(vhpToken);
  resolveOld(page); await switched;
  assert.equal(controller.getState().token.address, VHP); assert.deepEqual(controller.getState().items, [], 'Late responses cannot paint another token');
  const closed = controller.refresh(); controller.setToken(null); resolveOld(page); await closed;
  assert.deepEqual(controller.getState().items, [], 'Closing a token invalidates its pending response');

  let apiCalls = 0, fail = false;
  const firstItems = Array.from({ length: 20 }, (_, i) => ({ ...page.items[0], key: 'first-' + i }));
  const feed = createController({ network: 'mainnet', now: () => 100000, api: async path => {
    apiCalls++; if (fail) throw new Error('offline');
    return { ...page, items: path.includes('cursor=') ? [firstItems[0], { ...page.items[0], key: 'older' }] : firstItems,
      nextCursor: path.includes('cursor=') ? null : '5' };
  } });
  feed.setAddress(A); feed.setToken(koinToken); await feed.refresh();
  fail = true; await feed.refresh({ more: true });
  assert.equal(feed.getState().retryMore, true); assert.equal(feed.getState().cursor, '5');
  fail = false; await feed.refresh({ more: true });
  assert.equal(feed.getState().items.length, 21, 'Overlapping pages are deduplicated');
  await feed.refresh({ automatic: true }); assert.equal(apiCalls, 3, 'Automatic updates leave expanded history in place');
  fail = true; await feed.refresh();
  assert.equal(feed.getState().items.length, 21); assert.match(feed.getState().error, /Could not load/);
  fail = false; await feed.refresh(); assert.equal(feed.getState().items.length, 20);

  for (const [status, message, expected] of [
    [503, 'Wallet startup failed. Check the application runtime log.', /wallet service could not start/i],
    [503, 'Wallet is starting. Please reload in a few seconds.', /wallet service is starting/i],
    [429, 'slow down', /Too many requests/],
    [500, 'private server details', /Could not load activity/],
  ]) {
    let outage = false;
    const failing = createController({ network: 'mainnet', api: async () => {
      if (outage) throw Object.assign(new Error(message), { status });
      return { ...page, nextCursor: null };
    } });
    failing.setAddress(A); failing.setToken(koinToken); await failing.refresh();
    const previous = failing.getState().items;
    outage = true; await failing.refresh();
    assert.match(failing.getState().error, expected);
    assert.equal(failing.getState().items, previous, 'Outages preserve previously loaded activity');
    outage = false; await failing.refresh();
    assert.equal(failing.getState().error, '', 'Retry clears the outage after recovery');
  }

  const scans = [];
  const sparse = createController({ network: 'mainnet', api: async url => {
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor'); scans.push(cursor);
    return { ...page, items: cursor === '20' ? [page.items[0]] : [page.items[1]],
      nextCursor: cursor == null ? '60' : cursor === '60' ? '40' : cursor === '40' ? '20' : null };
  } });
  sparse.setAddress(A); sparse.setToken(koinToken); await sparse.refresh();
  assert.deepEqual(scans, [null, '60', '40'], 'Sparse activity searches a bounded batch of account pages');
  assert.equal(sparse.getState().cursor, '20'); assert.deepEqual(sparse.getState().items, []);
  await sparse.refresh({ more: true }); assert.equal(sparse.getState().items.length, 1);
  assert.equal(sparse.getState().cursor, null);
  const stalled = createController({ network: 'mainnet', api: async () => ({ ...page, items: [], nextCursor: '5' }) });
  stalled.setAddress(A); stalled.setToken(koinToken); await stalled.refresh();
  assert.match(stalled.getState().error, /Could not load/, 'A stuck cursor cannot loop or masquerade as an empty feed');
  console.log('✓ Token isolation, Sent/Received rows, rewards/burns, account/token/close races, bounded sparse pagination, deduplication and retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
