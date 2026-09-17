'use strict';
const assert = require('node:assert/strict');
const { Serializer, Signer, utils } = require('koilib');
const { createHistoryService, PAGE_SIZE } = require('../tools/transaction-history');
const { NETWORKS } = require('../tools/rpc');
const { createController, amount } = require('../public/js/transactions');
const A = Signer.fromSeed('history-owner').getAddress(), B = Signer.fromSeed('history-recipient').getAddress();
const CUSTOM = Signer.fromSeed('history-custom-token').getAddress();
const { koinContract: KOIN, vhpContract: VHP } = NETWORKS.mainnet;
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
  assert.equal(amount(unknown.movements[0]), '+9007199254740993 raw units');
  const zero = createHistoryService({ network: 'mainnet', urls: ['up'], call: async (_, method) => method === 'account_history.get_account_history'
    ? { values: [{ ...tx(0, []), seq_num: undefined }] } : {} });
  assert.equal((await zero.get(A)).items[0].sequence, '0'); assert.equal((await zero.get(A)).nextCursor, null);
  console.log('✓ Outages stay errors; missing metadata and timestamps are never invented; sequence zero works');

  let resolveOld;
  const controller = createController({ network: 'mainnet', api: () => new Promise(resolve => { resolveOld = resolve; }) });
  controller.setAddress(A);
  const oldRequest = controller.refresh(); controller.reset(); controller.setAddress(B);
  resolveOld(page); await oldRequest;
  assert.equal(controller.getState().address, B); assert.deepEqual(controller.getState().items, []);
  let apiCalls = 0, fail = false;
  const feed = createController({ network: 'mainnet', now: () => 100000, api: async path => {
    apiCalls++; if (fail) throw new Error('offline');
    return { ...page, items: path.includes('cursor=') ? [page.items[0], { ...page.items[1], key: 'older' }] : [page.items[0]] };
  } });
  feed.setAddress(A); await feed.refresh(); await feed.refresh({ more: true });
  assert.equal(feed.getState().items.length, 2, 'Overlapping pages are deduplicated');
  await feed.refresh({ automatic: true }); assert.equal(apiCalls, 2, 'Automatic updates leave expanded history in place');
  fail = true; await feed.refresh();
  assert.equal(feed.getState().items.length, 2); assert.match(feed.getState().error, /Could not refresh/);
  fail = false; await feed.refresh(); assert.equal(feed.getState().items.length, 1);
  console.log('✓ Account-switch race, pagination deduplication, stable expanded history and stale/error recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
