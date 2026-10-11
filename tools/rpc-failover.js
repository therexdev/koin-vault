'use strict';

const { Provider } = require('koilib');
const TRANSIENT = /timeout|timed? ?out|unexpected token|invalid json|fetch|network|econn|socket|hang up|abort|bad gateway|gateway time|service unavailable|too many request|(^|[^0-9])(429|500|502|503|504)([^0-9]|$)/i;
// Public nodes can answer HTTP 200 with a JSON-RPC error when their AMQP
// broker is disconnected. This is an endpoint outage, not a contract failure.
const BROKER_UNAVAILABLE = /\bamqp\s+(?:connection|channel)\s+(?:is\s+)?(?:not open|closed)\b/i;

// Only known read methods may be retried. A submission can succeed even
// when its response is lost, so writes must retain their single attempt.
const READ = /^(chain\.(get_|read_contract$)|block_store\.get_|account_history\.get_)/;

function installFailover(provider, { timeoutMs = 25000 } = {}) {
  provider.call = async (method, params) => {
    const urls = provider.rpcNodes.slice();
    const start = provider.currentNodeId;
    const attempts = READ.test(method) ? urls.length : 1;
    for (let i = 0; i < attempts; i++) {
      const index = (start + i) % urls.length;
      // Isolate calls so concurrent reads and late timeout responses cannot
      // change another call's endpoint selection.
      const node = new Provider(urls[index]);
      let timer;
      try {
        const result = await Promise.race([
          node.call(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`koinos rpc timeout (${method})`)), timeoutMs);
          }),
        ]);
        provider.currentNodeId = index;
        return result;
      } catch (e) {
        provider.currentNodeId = (index + 1) % urls.length;
        const message = String(e.message || e);
        if (i + 1 === attempts || !(TRANSIENT.test(message) || BROKER_UNAVAILABLE.test(message))) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  return provider;
}

module.exports = { installFailover };

