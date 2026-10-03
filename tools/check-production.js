'use strict';
// Read-only deployment verification; never signs or submits a transaction.
const target = new URL(process.argv[2] || process.env.PUBLIC_URL || 'https://koinvault.app');
const expectedRpId = process.env.PASSKEY_RPID || target.hostname;
async function read(path) {
  try {
    const res = await fetch(new URL(path, target), { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    return { status: res.status, data: await res.json() };
  } catch (e) { return { status: 0, data: { error: e.name === 'TimeoutError' ? 'Request timed out' : 'Endpoint unavailable or returned non-JSON' } }; }
}
(async () => {
  const [health, runtime, config] = await Promise.all(['/api/health', '/api/runtime', '/api/config'].map(read));
  const checks = {
    health: health.status === 200 && health.data.ok === true,
    liveMainnet: health.data.demo === false && health.data.network === 'mainnet',
    workerRepair: runtime.status === 200 && runtime.data.workerRecovery === 2 && runtime.data.worker?.ready === true,
    passkeyDomain: config.status === 200 && config.data.rpId === expectedRpId,
  };
  console.log(JSON.stringify({ origin: target.origin, ok: Object.values(checks).every(Boolean), checks,
    healthStatus: health.status, healthCode: health.data.code,
    version: runtime.data.version, commit: runtime.data.commit,
    worker: runtime.data.worker }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
})().catch(e => { console.error(e.message); process.exitCode = 1; });
