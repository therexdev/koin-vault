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
  const empty = createHistoryService({ network: 'mainnet', urls: ['up'], call: async () => ({}) });
  assert.deepEqual((await empty.get(A)).items, []);
  const missingMeta = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => {
    if (method === 'account_history.get_account_history') return { values: [tx(1, [custom])] };
    throw new Error('Unavailable');
  } });
  const unknown = (await missingMeta.get(A)).items[0];
  assert.equal(unknown.timestamp, null); assert.equal(unknown.movements[0].amount, null);
  assert.equal(unknown.movements[0].units, '9007199254740993');
  assert.equal(amount(unknown.movements[0]), '9,007,199,254,740,993 raw units');
  assert.equal(amount(page.items[1].movements[0]), '184,467,440,737.09551615 VHP');
  const zero = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => method === 'account_history.get_account_history'
    ? { values: [{ ...tx(0, []), seq_num: undefined }] } : {} });
  assert.equal((await zero.get(A)).items[0].sequence, '0'); assert.equal((await zero.get(A)).nextCursor, null);
  console.log('✓ Outages stay errors; missing metadata and timestamps are never invented; sequence zero works');

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
