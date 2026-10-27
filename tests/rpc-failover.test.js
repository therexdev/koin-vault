'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { Provider } = require('koilib');
const { installFailover } = require('../tools/rpc-failover');

(async () => {
  let mode = 'html', backupMode = 'ok', primary = 0, backup = 0, last = 0;
  const servers = [];
  const errors = {
    amqp: { code: -32603, message: 'AMQP connection is not open' },
    wrappedAmqp: { code: -32603, message: 'Internal error', data: JSON.stringify({ message: 'AMQP connection is not open' }) },
    channel: { code: -32603, message: 'AMQP channel is closed' },
    rejection: { message: 'contract rejected' },
    invalidBytes: { message: 'Invalid encoded bytes' },
    rejectionData: { message: 'RPC failure', data: JSON.stringify({ error: 'contract rejected', code: 1, logs: ['transaction reverted'] }) },
    gatewayData: { message: 'Unable to translate request', data: 'parameters could not be parsed' },
  };
  function reply(res, kind) {
    if (kind === 'timeout') return;
    if (kind === 'html') return res.end('<html>Bad Gateway</html>');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(kind === 'ok' ? { result: { value: '42' } } : { error: errors[kind] }));
  }
  async function serve(handler) {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${s.address().port}`;
  }
  try {
    const a = await serve((req, res) => {
      primary++;
      reply(res, mode);
    });
    const b = await serve((req, res) => { backup++; reply(res, backupMode); });
    const c = await serve((req, res) => { last++; reply(res, 'ok'); });
    const jsonOnly = await serve((req, res) => {
      if (req.headers['content-type'] !== 'application/json') {
        res.statusCode = 415;
        res.end(JSON.stringify({ error: { message: 'Unsupported Media Type' } }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: JSON.parse(body) }));
      });
    });
    const jsonProvider = installFailover(new Provider([jsonOnly, b]), { timeoutMs: 100 });
    const jsonParams = { contract_id: 'token', entry_point: 1550980247, args: 'CgEA' };
    const beforeJson = backup;
    const jsonResult = await jsonProvider.call('chain.read_contract', jsonParams);
    assert.equal(jsonResult.jsonrpc, '2.0');
    assert.equal(jsonResult.method, 'chain.read_contract');
    assert.deepEqual(jsonResult.params, jsonParams, 'JSON content type preserves the original RPC request');
    assert.equal(backup, beforeJson, 'a healthy JSON-only primary must not need a backup');
    const submitParams = { transaction: { id: 'fixture', operations: [] }, broadcast: false };
    const submitted = await jsonProvider.call('chain.submit_transaction', submitParams);
    assert.equal(submitted.method, 'chain.submit_transaction');
    assert.deepEqual(submitted.params, submitParams, 'JSON transport leaves the submitted transaction unchanged');
    assert.equal(backup, beforeJson);
    const make = () => installFailover(new Provider([a, b]), { timeoutMs: 100 });
    assert.deepEqual(await make().call('chain.get_account_rc', {}), { value: '42' });
    assert.equal(backup, 1);
    mode = 'timeout';
    assert.deepEqual(await make().call('chain.read_contract', {}), { value: '42' });

    // These JSON-RPC errors arrive with HTTP 200, including a nested data
    // payload. A broken node's broker must not leave a balance unavailable.
    for (const failure of ['amqp', 'wrappedAmqp', 'channel']) {
      mode = failure;
      for (const method of ['chain.read_contract', 'chain.get_account_rc', 'chain.get_head_info', 'account_history.get_account_history', 'transaction_store.get_transactions_by_id']) {
        const before = backup;
        assert.deepEqual(await make().call(method, {}), { value: '42' }, `${failure}: ${method}`);
        assert.equal(backup - before, 1, 'read retries the backup exactly once');
      }
    }

    // Confirmation polling is a read too: an unavailable transaction store
    // must fall through immediately, without replaying the submission.
    for (const failure of ['timeout', 'html']) {
      mode = failure;
      const before = [primary, backup];
      assert.deepEqual(await make().getTransactionsById(['fixture']), { value: '42' });
      assert.deepEqual([primary - before[0], backup - before[1]], [1, 1], `confirmation read recovers after ${failure}`);
    }

    mode = 'invalidBytes';
    for (const method of ['chain.submit_transaction', 'transaction_store.get_transactions_by_id']) {
      const before = [primary, backup];
      await assert.rejects(make().call(method, {}), /Invalid encoded bytes/);
      assert.deepEqual([primary - before[0], backup - before[1]], [1, 0], `${method} preserves deterministic rejection`);
    }

    mode = 'amqp';
    backupMode = 'wrappedAmqp';
    const third = installFailover(new Provider([a, b, c]), { timeoutMs: 100 });
    const beforeThird = [primary, backup, last];
    assert.deepEqual(await third.readContract({ contract_id: 'token', entry_point: 1550980247, args: '' }), { value: '42' });
    assert.deepEqual([primary - beforeThird[0], backup - beforeThird[1], last - beforeThird[2]], [1, 1, 1], 'both failed nodes fall through to the third endpoint');
    assert.equal(third.currentNodeId, 2, 'later reads can reuse the working endpoint');
    await third.getHeadInfo();
    assert.deepEqual([primary - beforeThird[0], backup - beforeThird[1], last - beforeThird[2]], [1, 1, 2]);

    backupMode = 'ok';
    const concurrent = make();
    const beforeConcurrent = backup;
    const reads = await Promise.all(['chain.read_contract', 'chain.read_contract', 'chain.get_account_rc'].map(method => concurrent.call(method, {})));
    assert.deepEqual(reads, [{ value: '42' }, { value: '42' }, { value: '42' }], 'concurrent token and mana reads all recover');
    assert.equal(backup - beforeConcurrent, 3);

    for (const failure of ['amqp', 'wrappedAmqp', 'timeout', 'html']) {
      mode = failure;
      for (const method of ['chain.submit_transaction', 'chain.submit_block', 'unknown.write']) {
        const before = [primary, backup];
        await assert.rejects(make().call(method, {}));
        assert.deepEqual([primary - before[0], backup - before[1]], [1, 0], `${method} must never be replayed after ${failure}`);
      }
    }
    mode = 'html';
    const before = backup;
    await assert.rejects(make().call('chain.submit_transaction', {}));
    assert.equal(backup, before, 'never retry a submission');
    mode = 'rejection';
    await assert.rejects(make().call('chain.read_contract', {}), /contract rejected/);
    assert.equal(backup, before, 'do not retry contract rejections');
    for (const failure of ['rejectionData', 'gatewayData']) {
      mode = failure;
      const expected = failure === 'rejectionData'
        ? { error: 'contract rejected', code: 1, logs: ['transaction reverted'] }
        : { error: 'Unable to translate request', data: 'parameters could not be parsed' };
      await assert.rejects(make().call('chain.read_contract', {}), error => {
        assert.deepEqual(JSON.parse(error.message), expected, 'retain chain errors, receipt logs and gateway details');
        return true;
      });
      assert.equal(backup, before, 'do not retry deterministic chain or request errors');
    }
    mode = 'html';
    const count = primary;
    await assert.rejects(installFailover(new Provider([a, a])).call('chain.get_head_info', {}));
    assert.equal(primary - count, 2, 'stop after one pass through endpoints');
    mode = 'amqp';
    backupMode = 'wrappedAmqp';
    const beforeDown = [primary, backup];
    await assert.rejects(make().call('chain.read_contract', {}), /AMQP connection is not open/);
    assert.deepEqual([primary - beforeDown[0], backup - beforeDown[1]], [1, 1], 'all brokers down: one pass, then report the error');
    console.log('rpc failover tests passed');
  } finally {
    for (const s of servers) { s.closeAllConnections(); s.close(); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
