/* KOIN Vault — the Veive smart-account app. One button in:
   a new passkey mints a REAL smart account on-chain (server-bootstrapped,
   mana-sponsored); the same scan signs you back in anywhere the passkey
   syncs. Sends are authorized by WebAuthn assertions the CHAIN verifies.
   Backups: extra passkeys and a downloadable recovery kit are simply more
   credentials registered on the account — any of them can sign. */
'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const LS_ADDR = 'bw_smart_addr';

  let ADDRESS = null;      // the smart account (a contract address)
  let ACTIVE = false;      // bootstrap finished — sends unlocked
  let CREDENTIALS = [];    // [{id, label, kind, ts}] — this account's keys
  let RECOVERY = null;     // {credentialId, privateKey} while in recovery mode
  let PENDING_BACKUP = null; // a captured-but-unregistered backup passkey
  let RESUMING = null;      // public account identity being refreshed after reopening
  let BALANCE_SATS = '';   // the chain's own integer balance, for "Send all"
  let VHP_BALANCE_SATS = '';
  let TOKEN_BALANCES = {}; // fresh integers by contract; cleared on failed reads
  let SENDING = false;
  let DAPP = null;         // {sessionId, secret}; bearer secret stays on this device
  let DAPP_POLL = null;
  let DAPP_REQUEST = null;
  let DAPP_RESULT = null;
  let DAPP_BUSY = false, DAPP_POLLING = false;

  /* ---------------- installable ----------------
     The service worker makes the wallet open offline and installable. It
     never touches /api, so nothing about balances or signing changes. */
  if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(WalletClient.serviceWorker, { scope: WalletClient.serviceWorkerScope }).catch(() => {});
    });
  }
  let PENDING_KIT = null;    // a generated-but-unregistered recovery kit
  let GENERATING_KIT = false;
  let RELEASE_KIT_DOWNLOAD = null;
  let POLL = null;

  const storeAddr = (a) => { try { a ? localStorage.setItem(LS_ADDR, a) : localStorage.removeItem(LS_ADDR); } catch (_) {} };
  const storedAddr = () => { try { return localStorage.getItem(LS_ADDR); } catch (_) { return null; } };

  /* ---------------- api ---------------- */
  async function api(path, body) {
    const headers = WalletClient.android ? { 'X-Wallet-Client': 'android' } : {};
    const r = await fetch(WalletClient.apiPath(path), body
      ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers, ...(path === '/api/config' ? { signal: AbortSignal.timeout(12000) }
        : path.startsWith('/api/transactions?') ? { signal: AbortSignal.timeout(60000) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'request failed'); e.status = r.status; e.code = data.code; throw e; }
    return data;
  }

  /* ---------------- boot ---------------- */
  async function waitForConfig() {
    const status = $('#connection-status');
    for (;;) {
      try {
        const value = await api('/api/config');
        if (value.ok !== true || typeof value.demo !== 'boolean') throw new Error('Invalid wallet configuration');
        status.hidden = true;
        return value;
      } catch (e) {
        status.hidden = false;
        status.textContent = e.code === 'WALLET_RESTART_PENDING'
          ? 'Wallet is restarting. Waiting for the previous process to stop…'
          : e.code === 'WALLET_STARTUP_FAILED'
            ? 'Wallet server could not start. Please try again later.'
            : 'Wallet connection unavailable. Retrying automatically…';
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  // A failed request is an unavailable connection, never a demo wallet.
  $('#btn-go').disabled = true;
  const cfg = await waitForConfig();
  if (cfg.rpId) Passkey.setRpId(cfg.rpId);
  /* The network is stamped on <body> for CSS and for anything that wants
     it; there is no app bar, so the badge itself is optional. */
  const NET = cfg.demo ? 'demo' : cfg.testnet ? 'testnet' : 'mainnet';
  document.body.dataset.net = NET;
  const badge = $('#net-badge');
  if (badge) {
    badge.textContent = cfg.demo ? 'demo' : cfg.testnet ? (cfg.networkLabel || '').replace('Koinos ', '') : 'mainnet';
    badge.classList.add(NET);
  }
  /* Demo mode is a CONFIGURATION state, not a mood: the server always knows
     which setting is missing, so say it here instead of making someone read
     a boot log to find out why their real balances are not showing. */
  if (cfg.demo) {
    const REMEDY = {
      'no sponsor wallet configured': 'Set SPONSOR_WIF on the server.',
      'smart-account contracts not deployed yet': 'Set VERIFIER_ADDR, MOD_SIGN_WEBAUTHN_ADDR and MOD_VALIDATION_SIGNATURE_ADDR.',
    };
    const why = cfg.note || 'DEMO_MODE=1 is set';
    const note = $('#demo-note');
    note.textContent = `Demo mode — ${why}. ${REMEDY[why] || ''} Balances and prices on this screen are samples, not your account.`.replace(/\s+/g, ' ').trim();
    note.hidden = false;
  }
  $('#sym').textContent = cfg.nativeSymbol || 'KOIN';
  $('#sym2').textContent = cfg.nativeSymbol || 'KOIN';
  UI.setContext({ cfg });
  // Optional guard also tolerates an older offline shell during an update.
  const transactionFeed = typeof Transactions !== 'undefined'
    ? Transactions.mount({ root: $('#transactions'), api, cfg }) : null;
  UI.setContext({
    onTokenOpen: token => {
      transactionFeed?.setAddress(ADDRESS);
      transactionFeed?.setToken(token);
      void transactionFeed?.refresh();
    },
    onTokenClose: () => transactionFeed?.setToken(null),
  });

  /* Deep links from the home-screen shortcuts (?open=send, ?tab=convert):
     kept until the wallet is open, applied once, and scrubbed from the URL
     so a reload does not replay them. */
  let PENDING_INTENT = null;
  let OPEN_RECOVERY = false;
  let PENDING_CONNECT = null;
  try {
    const q = new URLSearchParams(location.search);
    OPEN_RECOVERY = q.get('open') === 'recover';
    if (!OPEN_RECOVERY && (q.get('open') || q.get('tab'))) PENDING_INTENT = { open: q.get('open'), tab: q.get('tab') };
    if (q.get('connect') && q.get('secret')) PENDING_CONNECT = { sessionId: q.get('connect'), secret: q.get('secret') };
    if ([...q.keys()].length) history.replaceState(null, '', location.pathname);
  } catch (_) {}

  const VIEWS = ['#view-landing', '#view-wallet', '#view-recover'];
  const show = (view) => {
    for (const v of VIEWS) $(v).hidden = v !== view;
    $('#btn-signout').hidden = view !== '#view-wallet';
    UI.onView(view);
    if (view === '#view-wallet') {
      paint();
      if (RESUMING) return;
      if (WalletClient.canBuy) Fund.refresh();
      if (PENDING_INTENT) { UI.applyIntent(PENDING_INTENT); PENDING_INTENT = null; }
      if (PENDING_CONNECT && ACTIVE) { const next = PENDING_CONNECT; PENDING_CONNECT = null; void connectDapp(next).catch(e => dappSay(e.message, 'err')); }
      if (DAPP && DAPP.address === ADDRESS) startDappPoll();
    } else if (WalletClient.canBuy) Fund.stop();
    if (view === '#view-landing') refreshLandingSupport(); // support can change (recovery adds a passkey)
  };

  function takeSmart(smart) {
    if (!smart || smart.address !== ADDRESS) return;
    if (Array.isArray(smart.credentials)) { CREDENTIALS = smart.credentials; renderCredentials(); }
    if (smart.step) setStep(smart.step, smart.error);
  }

  /* Activation banner + send gating: a fresh account exists the moment the
     passkey does, but sends unlock when the contract is live on-chain. */
  function setStep(step, error) {
    ACTIVE = step === 'active';
    const box = $('#activation');
    const send = $('#btn-send');
    if (ACTIVE) { box.hidden = true; send.disabled = false; stopPoll(); return; }
    box.hidden = false;
    send.disabled = true;
    box.className = 'status' + (step === 'conflict' || error ? ' err' : '');
    box.textContent =
      step === 'conflict' ? 'This account answers to a different passkey — sign in with that one.' :
      error ? 'Setup hit a snag — retrying: ' + error :
      'Your smart account is being written on-chain (a real contract, mana-sponsored) — sends unlock in a minute…';
  }
  function stopPoll() { if (POLL) { clearInterval(POLL); POLL = null; } }
  function pollStatus() {
    stopPoll();
    const id = Passkey.storedId();
    const address = ADDRESS;
    if (!id) return;
    POLL = setInterval(async () => {
      try {
        const st = await api('/api/account-status?credentialId=' + encodeURIComponent(id));
        if (ADDRESS !== address || Passkey.storedId() !== id || st.address !== address) return;
        takeSmart(st);
        if (st.step === 'active') paint();
        if (st.step === 'conflict') stopPoll();
      } catch (_) {}
    }, 3000);
  }

  /* ---------------- signing (the one place a transaction gets signed) ----------------
     Recovery mode signs with the kit's software key; otherwise any of the
     account's passkeys — the chain accepts every registered credential. */
  async function signPrepared(tx) {
    if (RESUMING) throw new Error('Your wallet is reconnecting. Please try again in a moment.');
    if (RECOVERY) {
      const a = await Recovery.signTx(RECOVERY.privateKey, RECOVERY.credentialId, tx.id);
      return WebauthnWire.packSignatureBlob(a);
    }
    const allow = CREDENTIALS.filter((c) => c.kind === 'passkey').map((c) => c.id);
    const a = await Passkey.assert(WebauthnWire.challengeForTxId(tx.id), allow.length ? allow : [Passkey.storedId()]);
    return WebauthnWire.packSignatureBlob(a);
  }

  /* ---------------- connected apps ----------------
     The QR contains an expiring random session + bearer secret, never a key.
     The app can queue contract calls, but this wallet prepares the exact
     transaction and requires a fresh passkey assertion before broadcasting. */
  function saveDapp(value) {
    DAPP = value;
    $('#btn-dapp-block').hidden = !value?.origin;
    try { value ? localStorage.setItem('bw_dapp_session', JSON.stringify(value)) : localStorage.removeItem('bw_dapp_session'); } catch (_) {}
  }
  function loadDapp() {
    try { const value = JSON.parse(localStorage.getItem('bw_dapp_session') || 'null'); return value && value.sessionId && value.secret ? value : null; }
    catch (_) { return null; }
  }
  function dappSay(message, kind) {
    const el = $('#dapp-status'); el.hidden = !message; el.className = 'status' + (kind ? ' ' + kind : ''); el.textContent = message || '';
  }
  function blockedDapps() {
    try {
      const saved = JSON.parse(localStorage.getItem('bw_dapp_blocked:' + ADDRESS) || '[]');
      return Array.isArray(saved) ? saved.filter(s => typeof s === 'string' && s.startsWith('https://')) : [];
    } catch (_) { return []; }
  }
  function isDappBlocked(origin) { return !!origin && blockedDapps().includes(origin); }
  function paintBlockedDapps() {
    const list = $('#dapp-blocked-list'); list.replaceChildren();
    const sites = blockedDapps();
    if (!sites.length) { list.textContent = 'No sites blocked for this wallet on this device.'; return; }
    for (const site of sites) {
      const row = document.createElement('p'), name = document.createElement('span'), button = document.createElement('button');
      name.textContent = site + ' '; button.textContent = 'Unblock'; button.className = 'linkish'; button.type = 'button';
      button.addEventListener('click', () => {
        try {
          localStorage.setItem('bw_dapp_blocked:' + ADDRESS, JSON.stringify(blockedDapps().filter(s => s !== site)));
          paintBlockedDapps();
        } catch (_) { dappSay('Could not save blocked sites on this device.', 'err'); }
      });
      row.append(name, button); list.append(row);
    }
  }
  $('#dapp-blocked').addEventListener('toggle', paintBlockedDapps);
  window.addEventListener('storage', event => {
    if (event.key === 'bw_dapp_blocked:' + ADDRESS) { paintBlockedDapps(); void pollDapp(); }
  });
  function parseConnect(raw) {
    try {
      const url = new URL(String(raw || ''), location.origin);
      if (url.origin !== location.origin) throw new Error('This QR belongs to a different wallet site');
      const sessionId = url.searchParams.get('connect'), secret = url.searchParams.get('secret');
      if (!sessionId || !secret) throw new Error('That is not a KOIN Vault connection QR');
      return { sessionId, secret };
    } catch (e) { throw new Error(e.message || 'That is not a KOIN Vault connection QR'); }
  }
  async function connectDapp(pair) {
    UI.showTab('tab-security');
    if (!ADDRESS || !ACTIVE) { PENDING_CONNECT = pair; dappSay('Unlock the wallet first, then the connection will continue.'); return; }
    if (RECOVERY) throw new Error('Sign in with a passkey to connect an app. Recovery mode cannot approve app access.');
    const query = new URLSearchParams(pair);
    const info = await api('/api/dapp/status?' + query);
    if (isDappBlocked(info.origin)) throw new Error('You blocked this site on this device. Unblock it under Security to connect.');
    if (!confirm(`Connect to ${info.origin}?\n\nApp name (provided by the site): ${info.name}\nAccount: ${ADDRESS}\n\nThis shares your address and lets the site request transactions. Each transaction needs your passkey. KOIN Vault has not verified this website.`)) return;
    const proof = await api('/api/dapp/challenge', { ...pair, address: ADDRESS });
    const assertion = await Passkey.assert(new TextEncoder().encode(proof.challenge), CREDENTIALS.filter(c => c.kind === 'passkey').map(c => c.id));
    await api('/api/dapp/connect', { ...pair, address: ADDRESS, credentialId: assertion.credentialId, challenge: proof.challenge, signature: WebauthnWire.packSignatureBlob(assertion) });
    if (isDappBlocked(info.origin)) { await api('/api/dapp/disconnect', pair); throw new Error('This site is blocked'); }
    saveDapp({ ...pair, address: ADDRESS, origin: info.origin }); dappSay(`Connected to ${info.origin}`, 'ok'); $('#btn-dapp-disconnect').hidden = false; startDappPoll();
  }
  async function scanDapp() {
    try { const hit = await QR.scan(); if (hit) await connectDapp(parseConnect(hit.raw || hit.address)); }
    catch (e) { dappSay(e.message || 'Could not connect', 'err'); }
  }
  function paintDappRequest(app, request) {
    const isNew = request && request.id !== DAPP_REQUEST?.id;
    DAPP_REQUEST = request;
    $('#dapp-request').hidden = !request;
    if (!request) return;
    const review = request.review, reviewed = review?.version === 1 && !!request.funding;
    $('#dapp-title').textContent = reviewed ? review.title : 'New transaction review required';
    $('#dapp-detail').textContent = reviewed ? review.actions.map((action, i) => `${i + 1}. ${action.title}\nContract: ${action.contract}\n${action.detail}`).join('\n\n')
      : 'Ask the website to create a new request using the updated wallet.';
    $('#dapp-name').textContent = app.name;
    $('#dapp-origin').textContent = app.origin;
    $('#dapp-ops').textContent = request.operations.map((op) => {
      if (op.upload_contract) return `Deploy collection ${op.upload_contract.contract_id}`;
      const call = op.call_contract || {};
      return `${call.contract_id || 'unknown'} · entry ${call.entry_point}`;
    }).join(' | ');
    $('#dapp-network').textContent = reviewed ? review.network : NET;
    $('#dapp-payer').textContent = reviewed ? `${request.funding.payer === 'sponsor' ? 'KOIN Vault sponsor' : request.funding.payer === 'app' ? 'Requesting app' : 'Your wallet'} · ${request.funding.address}` : 'Unavailable';
    $('#dapp-mana').textContent = reviewed ? `${request.funding.maxMana} mana. Only actual usage is consumed; no KOIN fee.` : 'Unavailable';
    const warnings = reviewed ? review.warnings : [];
    $('#dapp-warnings').textContent = warnings.join('\n\n'); $('#dapp-warnings').hidden = !warnings.length;
    $('#dapp-ack-row').hidden = !reviewed || !review.requiresAcknowledgement;
    if (isNew) $('#dapp-ack').checked = false;
    $('#btn-dapp-approve').disabled = !reviewed || (review.requiresAcknowledgement && !$('#dapp-ack').checked);
    if (isNew) {
      UI.showTab('tab-security');
      $('#dapp-request').scrollIntoView({ block: 'center' });
      $('#btn-dapp-approve').focus({ preventScroll: true });
      dappSay('A transaction needs your approval. Review it below.');
    }
  }
  async function pollDapp() {
    if (RESUMING || !DAPP || !ADDRESS || DAPP.address !== ADDRESS || document.hidden || DAPP_BUSY || DAPP_POLLING) return;
    const pair = DAPP;
    DAPP_POLLING = true;
    try {
      const data = await api('/api/dapp/pending?' + new URLSearchParams(DAPP));
      if (DAPP !== pair || DAPP_BUSY || !ADDRESS) return;
      if (isDappBlocked(data.app.origin)) {
        await api('/api/dapp/disconnect', pair);
        if (DAPP === pair) { saveDapp(null); stopDappPoll(); paintDappRequest(null, null); $('#btn-dapp-disconnect').hidden = true; }
        return;
      }
      if (pair.origin !== data.app.origin) { pair.origin = data.app.origin; saveDapp(pair); }
      $('#btn-dapp-disconnect').hidden = false;
      const incoming = data.requests[0] || null;
      if (incoming && incoming.id !== DAPP_REQUEST?.id) DAPP_RESULT = null;
      paintDappRequest(data.app, incoming);
      if (DAPP_RESULT?.pair === pair) dappSay(DAPP_RESULT.message, DAPP_RESULT.kind);
      else if (!data.requests.length) dappSay(`Connected to ${data.app.origin}`, 'ok');
    } catch (e) {
      if (DAPP !== pair || !ADDRESS) return;
      dappSay(e.status === 404 ? 'Connection expired. Scan a new QR to reconnect.' : 'Cannot receive app requests: ' + e.message, 'err');
      if (e.status === 404) { saveDapp(null); stopDappPoll(); $('#btn-dapp-disconnect').hidden = true; paintDappRequest(null, null); }
    } finally { DAPP_POLLING = false; }
  }
  function startDappPoll() { stopDappPoll(); void pollDapp(); DAPP_POLL = setInterval(pollDapp, 2000); }
  function stopDappPoll() { if (DAPP_POLL) { clearInterval(DAPP_POLL); DAPP_POLL = null; } }
  $('#btn-connect-app').addEventListener('click', scanDapp);
  $('#btn-connect-app-security').addEventListener('click', scanDapp);
  $('#dapp-ack').addEventListener('change', () => {
    $('#btn-dapp-approve').disabled = DAPP_BUSY || !DAPP_REQUEST?.review || (DAPP_REQUEST.review.requiresAcknowledgement && !$('#dapp-ack').checked);
  });
  $('#btn-dapp-approve').addEventListener('click', async () => {
    if (!DAPP || !DAPP_REQUEST || DAPP_BUSY) return;
    if (RECOVERY) { dappSay('Sign in with a passkey to approve app transactions.', 'err'); return; }
    const pair = DAPP, request = DAPP_REQUEST;
    if (isDappBlocked(pair.origin) || request.review?.version !== 1 || !request.funding) return;
    if (request.review.requiresAcknowledgement && !$('#dapp-ack').checked) return;
    DAPP_BUSY = true;
    const btn = $('#btn-dapp-approve'); btn.disabled = true;
    $('#btn-dapp-reject').disabled = true;
    try {
      dappSay('Confirm with your passkey…');
      const blob = await signPrepared(request.transaction);
      if (DAPP !== pair || pair.address !== ADDRESS || isDappBlocked(pair.origin)) throw new Error('Wallet connection changed; reconnect');
      dappSay('Fingerprint accepted. Submitting transaction…');
      const result = await api('/api/dapp/approve', { ...pair, requestId: request.id, acknowledged: $('#dapp-ack').checked, transaction: { ...request.transaction, signatures: [blob] } });
      paintDappRequest(null, null);
      DAPP_RESULT = { pair, message: result.signedOnly ? 'Launch approved. Return to OURO to follow deployment.' : `Transaction submitted: ${result.txid}`, kind: 'ok' };
      if (!result.signedOnly) void transactionFeed?.refresh();
      dappSay(DAPP_RESULT.message, DAPP_RESULT.kind); void paint();
    } catch (e) {
      DAPP_RESULT = { pair, message: friendly(e), kind: 'err' };
      dappSay(DAPP_RESULT.message, DAPP_RESULT.kind);
    }
    finally {
      DAPP_BUSY = false;
      btn.disabled = !DAPP_REQUEST?.review || (DAPP_REQUEST.review.requiresAcknowledgement && !$('#dapp-ack').checked);
      $('#btn-dapp-reject').disabled = false;
    }
  });
  $('#btn-dapp-reject').addEventListener('click', async () => {
    if (!DAPP || !DAPP_REQUEST) return;
    try { await api('/api/dapp/reject', { ...DAPP, requestId: DAPP_REQUEST.id }); paintDappRequest(null, null); dappSay('Request rejected'); }
    catch (e) { dappSay(e.message || 'Could not reject request', 'err'); }
  });
  $('#btn-dapp-block').addEventListener('click', async () => {
    const pair = DAPP, button = $('#btn-dapp-block');
    if (!pair?.origin || button.disabled || !confirm(`Block ${pair.origin} for this wallet on this device?`)) return;
    button.disabled = true;
    try {
      const sites = [...new Set([...blockedDapps(), pair.origin])];
      localStorage.setItem('bw_dapp_blocked:' + ADDRESS, JSON.stringify(sites));
      paintBlockedDapps();
      try { await api('/api/dapp/disconnect', pair); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
      if (DAPP === pair) { saveDapp(null); stopDappPoll(); paintDappRequest(null, null); $('#btn-dapp-disconnect').hidden = true; }
      dappSay('Site blocked on this device and disconnected.', 'ok');
    } catch (e) { dappSay('Site could not be fully disconnected. Retry when online. ' + e.message, 'err'); }
    finally { button.disabled = false; }
  });
  $('#btn-dapp-disconnect').addEventListener('click', async () => {
    const pair = DAPP, btn = $('#btn-dapp-disconnect');
    if (!pair || btn.disabled || !confirm('Disconnect this app?')) return;
    btn.disabled = true;
    try {
      try { await api('/api/dapp/disconnect', pair); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
      if (DAPP !== pair) return;
      saveDapp(null); stopDappPoll(); paintDappRequest(null, null); btn.hidden = true;
      dappSay('App disconnected. Its website will update automatically.');
    } catch (e) {
      if (DAPP === pair) dappSay('Could not disconnect the app. Check your connection and try again.', 'err');
    } finally { btn.disabled = false; }
  });

  /* ---------------- landing: THE button ---------------- */
  const go = $('#btn-go');
  let ENTERING = false;
  async function refreshLandingSupport() {
    const ok = Passkey.supported();
    go.disabled = !ok || ENTERING;
    $('#btn-phone-signin').disabled = !ok || ENTERING;
    $('#btn-phone-create').disabled = !ok || ENTERING;
    $('#btn-saved-signin').disabled = !ok || ENTERING;
    $('#no-passkey').hidden = ok;
    $('#alt-unlock').hidden = !ok;
    $('#phone-option').hidden = !ok;
  }
  await refreshLandingSupport();

  function friendly(e) {
    if (e && e.name === 'NotAllowedError') return 'Prompt closed — nothing changed';
    if (e && e.name === 'InvalidStateError') return 'A new passkey could not be created. Try another passkey provider, or choose a saved passkey to sign in.';
    return (e && e.message) || 'Passkey ceremony failed';
  }

  async function signIn(usePhone) {
    // Sign-in always discovers all accounts, regardless of the last used key.
    const credentialId = await Passkey.identify(true, { usePhone });
    const who = await api('/api/whoami', { credentialId });
    ADDRESS = who.address; storeAddr(ADDRESS);
    RECOVERY = null;
    takeSmart(who);
    if (who.step !== 'active') pollStatus();
    show('#view-wallet');
  }

  async function createAccount(usePhone = false) {
    const made = await Passkey.createCredential({ usePhone });
    const rec = await api('/api/create-account', {
      credentialId: made.credentialId, publicKey: made.publicKey, name: 'passkey',
    });
    ADDRESS = rec.address; storeAddr(ADDRESS);
    RECOVERY = null;
    takeSmart(rec);
    if (rec.step !== 'active') pollStatus();
    show('#view-wallet');
  }

  async function enter(makeNew, usePhone) {
    if (ENTERING) return;
    ENTERING = true;
    go.disabled = true;
    $('#btn-phone-signin').disabled = true;
    $('#btn-phone-create').disabled = true;
    $('#btn-saved-signin').disabled = true;
    UI.setPasskeyBusy(true);
    UI.closeSheet({ immediate: true, restoreFocus: false });
    try {
      if (makeNew) await createAccount(usePhone);
      else await signIn(usePhone);
    } catch (e) {
      if (e.status === 404) {
        alertLine('No wallet was found for that passkey. Choose another saved passkey, or use a registered recovery kit.');
      } else if (usePhone && e.name === 'NotAllowedError') {
        alertLine('Phone sign-in was cancelled or unavailable. If you only saw USB, choose Other options → Use a phone or tablet, or try a saved passkey in Chrome.');
        UI.openSheet('sheet-phone');
      } else alertLine(friendly(e));
    } finally {
      ENTERING = false;
      UI.setPasskeyBusy(false);
      await refreshLandingSupport();
    }
  }

  function chooseAccount() {
    if (ENTERING || !Passkey.supported()) return;
    if (alertEl) alertEl.textContent = '';
    UI.openSheet('sheet-phone');
  }
  // A remembered key must never decide whether the user signs in or creates.
  go.addEventListener('click', chooseAccount);
  $('#btn-use-phone').addEventListener('click', (e) => { e.preventDefault(); chooseAccount(); });
  $('#btn-phone-signin').addEventListener('click', () => enter(false, true));
  $('#btn-saved-signin').addEventListener('click', () => enter(false, false));
  $('#btn-phone-create').addEventListener('click', () => enter(true, false));
  $('#btn-unlock-existing').addEventListener('click', (e) => { e.preventDefault(); return enter(false, false); });
  $('#btn-open-recover').addEventListener('click', (e) => { e.preventDefault(); show('#view-recover'); });
  $('#btn-recover-back').addEventListener('click', (e) => { e.preventDefault(); show('#view-landing'); });

  let alertEl = null;
  function alertLine(msg) {
    if (!alertEl) {
      alertEl = document.createElement('p');
      alertEl.className = 'note';
      go.insertAdjacentElement('afterend', alertEl);
    }
    alertEl.textContent = msg;
  }

  /* ---------------- recovery flow ---------------- */
  $('#btn-recover').addEventListener('click', async () => {
    const st = $('#recover-status');
    const say = (m, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = m; };
    const kit = Recovery.parseKit($('#kit-input').value);
    if (!kit) { say('That doesn\'t look like a recovery kit — paste the whole file, including the Credential and Key lines.', 'err'); return; }
    try {
      await Recovery.signTx(kit.privateKey, kit.credentialId, '0x1220' + '00'.repeat(32)); // key sanity check
    } catch (_) { say('The Key line is damaged — check the file.', 'err'); return; }
    try {
      const who = await api('/api/whoami', { credentialId: kit.credentialId });
      ADDRESS = who.address; storeAddr(ADDRESS);
      RECOVERY = { credentialId: kit.credentialId, privateKey: kit.privateKey };
      takeSmart(who);
      $('#kit-input').value = '';
      show('#view-wallet');
      renderCredentials();
    } catch (e) {
      say(e.status === 404
        ? 'No account answers to this kit. Was it activated? (The kit only works after "activate on-chain".)'
        : (e.message || 'Recovery failed'), 'err');
    }
  });

  /* ---------------- wallet view ----------------
     Two reads: /api/account for the account's own state (activation step,
     credentials, the exact KOIN integer "Send all" needs) and /api/portfolio
     for what the home screen shows (every balance, priced). The screen is
     painted by UI from the portfolio model; a failed read keeps the last
     good numbers rather than blanking them. */
  let PAINTING = false, PAINT_AGAIN = false, PAINT_GEN = 0;
  async function paint() {
    if (!ADDRESS) return;
    transactionFeed?.setAddress(ADDRESS);
    $('#addr').textContent = ADDRESS;
    UI.setContext({ address: ADDRESS, cfg, recovery: RECOVERY, active: ACTIVE, refresh: paint });
    if (RESUMING || document.hidden) return;
    void transactionFeed?.refresh({ automatic: true });
    /* A request that lands mid-poll (a send just confirmed, KOIN just
       landed) is not dropped: it runs once more as soon as this one ends. */
    if (PAINTING) { PAINT_AGAIN = true; return; }
    PAINTING = true;
    /* Answers belong to the account that asked. Sign-out bumps the
       generation, so a slow reply for the previous account never paints —
       or installs its credentials — into the next one's session. */
    const gen = ++PAINT_GEN;
    const credParam = RECOVERY ? RECOVERY.credentialId : (Passkey.storedId() || '');
    const account = api('/api/account?address=' + encodeURIComponent(ADDRESS)
      + '&credentialId=' + encodeURIComponent(credParam))
      .then((a) => {
        if (gen !== PAINT_GEN) return;
        BALANCE_SATS = String(a.koinSats == null ? '' : a.koinSats);
        $('#mana').textContent = Number(a.mana || 0).toFixed(2);
        takeSmart(a.smart);
      })
      .catch(() => { if (gen === PAINT_GEN) { BALANCE_SATS = ''; $('#mana').textContent = '—'; } });
    const portfolio = Portfolio.load(ADDRESS, api);   // resolves with {error} rather than rejecting
    try {
      await account;
      const m = await portfolio;
      if (gen === PAINT_GEN) {
        VHP_BALANCE_SATS = !m.error && m.vhp && !m.vhp.unavailable && m.vhp.sats != null ? String(m.vhp.sats) : '';
        TOKEN_BALANCES = Object.fromEntries((!m.error && m.others || [])
          .filter(row => !row.unavailable && row.sats != null).map(row => [row.id, String(row.sats)]));
        UI.paintPortfolio(m);
      }
    } finally {
      if (gen === PAINT_GEN) {
        PAINTING = false;
        if (PAINT_AGAIN) { PAINT_AGAIN = false; paint(); }
      }
    }
  }
  setInterval(() => { if (!$('#view-wallet').hidden) paint(); }, 30000);
  /* Coming back to the tab or the app: the 30s tick skipped while hidden. */
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#view-wallet').hidden) paint(); });

  $('#addr').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ADDRESS || ''); $('#addr').style.borderColor = 'var(--good)'; UI.toast('Address copied'); }
    catch (_) { window.prompt('Copy your address:', ADDRESS || ''); }
    setTimeout(() => { $('#addr').style.borderColor = ''; }, 900);
  });

  /* ---------------- backups card ---------------- */
  function credentialLimit() {
    const limit = Number(cfg.maxCredentialsPerAccount);
    // Older backends enforce six. Wait for their advertised limit to increase.
    return Number.isSafeInteger(limit) && limit > 0 ? limit : 6;
  }
  function renderCredentials() {
    const list = $('#cred-list');
    list.innerHTML = '';
    for (const c of CREDENTIALS) {
      const li = document.createElement('li');
      const kind = c.kind === 'recovery' ? 'recovery kit' : 'passkey';
      const current = (RECOVERY && c.id === RECOVERY.credentialId) || (!RECOVERY && c.id === Passkey.storedId());
      li.innerHTML = '<span class="cred-kind ' + (c.kind || 'passkey') + '">' + kind + '</span> '
        + '<span class="cred-label"></span>'
        + (current ? ' <span class="cred-now">— in use here</span>' : '')
        + (c.ts ? ' <span class="cred-ts">' + new Date(c.ts).toLocaleDateString() + '</span>' : '');
      li.querySelector('.cred-label').textContent = (c.label || kind)
        + (c.kind === 'recovery' ? ' · ' + c.id.slice(-8) : '');
      list.appendChild(li);
    }
    const kitCount = CREDENTIALS.filter((c) => c.kind === 'recovery').length;
    const hasKit = kitCount > 0;
    $('#kit-armed').hidden = !hasKit;
    $('#kit-armed').textContent = '✓ ' + kitCount + (kitCount === 1 ? ' recovery kit is' : ' recovery kits are')
      + ' active. Each saved file opens this wallet independently.';
    const limit = credentialLimit(), full = CREDENTIALS.length >= limit;
    $('#credential-capacity').textContent = CREDENTIALS.length + ' of ' + limit + ' credential slots used (passkeys + recovery kits).'
      + (full ? ' This wallet has reached the configured limit; another kit cannot be activated yet.' : ' You can add a new kit if an earlier file is lost.');
    $('#btn-add-passkey').hidden = full || !!PENDING_BACKUP;
    $('#btn-make-kit').hidden = false;
    $('#btn-make-kit').disabled = full || !!PENDING_KIT || GENERATING_KIT;
    $('#kit-create-label').textContent = PENDING_KIT ? 'Save and activate the kit below' : hasKit ? 'Create another recovery kit' : 'Create recovery kit';
    $('#recovery-banner').hidden = !RECOVERY;
    const single = CREDENTIALS.length === 1 && !hasKit;
    $('#backup-nudge').hidden = !single || !ACTIVE;
    UI.paintProtection(CREDENTIALS, RECOVERY, ACTIVE, true);
  }

  const bsay = (m, cls) => { const st = $('#backup-status'); st.hidden = !m; st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = m || ''; };

  /** Register one more credential on the account: prepare on the server,
      sign with a CURRENT credential, submit; the chain checks the rest. */
  async function registerCredential(newCred, progressLabel) {
    bsay(progressLabel + ' — preparing the transaction…');
    const signerId = RECOVERY ? RECOVERY.credentialId : Passkey.storedId();
    const prep = await api('/api/prepare-register', {
      address: ADDRESS, signerCredentialId: signerId, newCredential: newCred,
    });
    bsay(progressLabel + ' — confirm with your ' + (RECOVERY ? 'recovery key' : 'passkey') + '…');
    const blob = await signPrepared(prep.tx);
    bsay(progressLabel + ' — writing it on-chain…');
    const r = await api('/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [blob] } });
    takeSmart(r.smart);
    return r;
  }

  /* Adding a backup passkey is two deliberate ceremonies: first the NEW
     authenticator creates its credential (pick a security key or another
     device), then the CURRENT passkey signs the registration. */
  $('#btn-add-passkey').addEventListener('click', async () => {
    const btn = $('#btn-add-passkey');
    btn.disabled = true;
    try {
      const made = await Passkey.createBackupCredential(CREDENTIALS.map((c) => c.id));
      PENDING_BACKUP = made;
      $('#backup-box').hidden = false;
      btn.hidden = true;
      bsay('');
    } catch (e) {
      bsay(e.name === 'InvalidStateError' ? 'That authenticator already holds a passkey for this account — use a different device or a security key.'
        : e.name === 'NotAllowedError' ? 'Prompt closed — nothing changed.'
        : (e.message || 'Could not create the backup passkey'), 'err');
    } finally { btn.disabled = false; }
  });
  $('#btn-backup-activate').addEventListener('click', async () => {
    if (!PENDING_BACKUP) return;
    const btn = $('#btn-backup-activate');
    btn.disabled = true;
    try {
      await registerCredential(
        { credentialId: PENDING_BACKUP.credentialId, publicKey: PENDING_BACKUP.publicKey, kind: 'passkey', label: 'backup passkey' },
        'Adding backup passkey');
      PENDING_BACKUP = null;
      $('#backup-box').hidden = true;
      bsay('Backup passkey added ✓ — it opens this account even if the first one is gone.', 'ok');
    } catch (e) {
      bsay(e.name === 'NotAllowedError' ? 'Prompt closed — the backup is not active yet; confirm with your current passkey to finish.'
        : (e.message || 'Could not add the passkey'), 'err');
    } finally {
      btn.disabled = false;
      renderCredentials();
    }
  });
  $('#btn-backup-cancel').addEventListener('click', () => {
    PENDING_BACKUP = null;
    $('#backup-box').hidden = true;
    renderCredentials();
    bsay('Backup discarded — nothing was registered.', '');
  });

  /* The kit: generate → the user SAVES it → only then register on-chain.
     Never the other way around — a registered key nobody saved is a lie. */
  function clearPendingKit() {
    if (RELEASE_KIT_DOWNLOAD) RELEASE_KIT_DOWNLOAD();
    RELEASE_KIT_DOWNLOAD = null;
    PENDING_KIT = null;
    $('#kit-box').hidden = true;
    $('#kit-text').textContent = '';
    $('#kit-preview').open = false;
  }
  $('#btn-make-kit').addEventListener('click', async () => {
    const btn = $('#btn-make-kit'), account = ADDRESS, generation = PAINT_GEN;
    if (btn.disabled || GENERATING_KIT || PENDING_KIT || !account || CREDENTIALS.length >= credentialLimit()) return;
    GENERATING_KIT = true;
    btn.disabled = true;
    try {
      const k = await Recovery.generate();
      if (ADDRESS !== account || PAINT_GEN !== generation) return;
      PENDING_KIT = { ...k, address: account };
      const download = $('#btn-kit-download');
      RELEASE_KIT_DOWNLOAD = Recovery.prepareDownload(PENDING_KIT, download);
      $('#kit-text').textContent = Recovery.kitText(PENDING_KIT);
      $('#kit-box').hidden = false;
      $('#btn-kit-activate').disabled = false;
      renderCredentials();
      bsay('');
      // Some browsers block automatic downloads after asynchronous key creation.
      // Keep the same file on a real download link for a direct user click.
      download.click();
    } catch (e) {
      if (ADDRESS === account && PAINT_GEN === generation) {
        if (!RELEASE_KIT_DOWNLOAD) clearPendingKit();
        bsay(e.message || 'Could not prepare your recovery kit', 'err');
      }
    } finally { GENERATING_KIT = false; renderCredentials(); }
  });
  $('#btn-kit-activate').addEventListener('click', async () => {
    if (!PENDING_KIT || $('#btn-kit-activate').disabled) return;
    const kit = PENDING_KIT;
    const btn = $('#btn-kit-activate');
    btn.disabled = true;
    $('#btn-kit-cancel').disabled = true;
    try {
      await registerCredential(
        { credentialId: kit.credentialId, publicKey: kit.publicKey, kind: 'recovery', label: 'recovery kit' },
        'Activating your kit');
      if (PENDING_KIT !== kit) return;
      clearPendingKit();
      bsay('Recovery kit active ✓ — the saved file now opens this account all by itself. Keep it offline.', 'ok');
    } catch (e) {
      if (PENDING_KIT !== kit) return;
      bsay((e.message || 'Activation failed') + ' — your downloaded kit is not active yet; try again.', 'err');
    } finally {
      btn.disabled = false;
      $('#btn-kit-cancel').disabled = false;
      renderCredentials();
    }
  });
  $('#btn-kit-cancel').addEventListener('click', () => {
    if ($('#btn-kit-cancel').disabled) return;
    clearPendingKit();
    renderCredentials();
    bsay('Kit discarded — nothing was registered. Delete the downloaded file.', '');
  });

  /* Recovery mode's way back to normal: mint a fresh passkey ON this device
     and register it with the kit key. */
  $('#btn-rekey').addEventListener('click', async () => {
    const btn = $('#btn-rekey');
    btn.disabled = true;
    try {
      const made = await Passkey.createCredential();
      await registerCredential(
        { credentialId: made.credentialId, publicKey: made.publicKey, kind: 'passkey', label: 'passkey' },
        'Adding a new passkey');
      RECOVERY = null;
      renderCredentials();
      bsay('New passkey registered ✓ — you\'re out of recovery mode; the button on the front page signs you in again.', 'ok');
    } catch (e) {
      bsay(e.name === 'NotAllowedError' ? 'Prompt closed — still in recovery mode.' : (e.message || 'Could not add the passkey'), 'err');
    } finally { btn.disabled = false; }
  });

  /* Send — prepare on the server, sign with the passkey (the challenge IS
     the transaction id) or the recovery key, the chain verifies either. */
  $('#btn-send').addEventListener('click', async () => {
    if (SENDING) return;
    const btn = $('#btn-send'), st = $('#send-status');
    const asset = UI.sendAsset(), symbol = UI.sendSymbol();
    const decimals = UI.sendDecimals();
    const custom = asset !== 'koin' && asset !== 'vhp';
    const to = $('#send-to').value.trim();
    const amount = $('#send-amount').value.trim();
    // Token symbols and contract errors are untrusted text, never markup.
    const say = (msg, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = msg; };
    if (!UI.canSendAsset(asset)) { say('Refresh the wallet to check whether this asset can be sent.', 'err'); return; }
    if (!to) { say('Paste a destination address', 'err'); return; }
    let units;
    try { units = TokenAmounts.toUnits(amount, decimals); }
    catch (e) { say(e.message, 'err'); return; }
    SENDING = true;
    btn.disabled = true;
    UI.setSendBusy(true);
    try {
      say('Preparing the exact transaction — the sharer pays the mana…');
      if (custom) {
        const current = await api('/api/config');
        if (current.demo !== false || current.sendCustomTokens !== true || current.network !== cfg.network) {
          throw new Error('Added-token sending is unavailable or the network changed. Refresh the wallet and try again.');
        }
      }
      const prep = await api(custom ? '/api/token/prepare' : '/api/prepare', { address: ADDRESS, to, amount, asset });
      // During a rolling deploy an older server could ignore `asset` and
      // prepare KOIN. Never sign a different token or changed decimals.
      if ((prep.asset || 'koin') !== asset) throw new Error('The prepared asset does not match your selection. Refresh and try again.');
      if (custom) {
        const info = prep.transfer, ops = prep.tx && prep.tx.operations;
        const call = Array.isArray(ops) && ops.length === 1 && ops[0].call_contract;
        if (!info || info.contract !== asset || info.decimals !== decimals || info.symbol !== symbol || info.units !== units
          || !call || call.contract_id !== asset || call.entry_point !== 0x27f576ca || prep.tx.header?.payee !== ADDRESS) {
          throw new Error('The prepared token transfer does not match what you reviewed. Refresh the token details and try again.');
        }
      }
      say(RECOVERY ? 'Signing with your recovery key…' : 'Confirm with your passkey — it signs the transaction id itself…');
      const blob = await signPrepared(prep.tx);
      say('Broadcasting — the chain verifies the signature on-chain…');
      const r = await api(custom ? '/api/token/submit' : '/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [blob] } });
      say(`Sent ${symbol} ✓` + (r.demo ? ` (demo transaction ${r.txid.slice(0, 14)}…)` : ''), 'ok');
      if (typeof r.explorer === 'string' && r.explorer.startsWith('https://')) {
        const link = document.createElement('a');
        link.href = r.explorer; link.target = '_blank'; link.rel = 'noopener'; link.textContent = ' — view it on-chain ↗';
        st.appendChild(link);
      }
      $('#send-to').value = ''; $('#send-amount').value = '';
      void transactionFeed?.refresh();
      paint();
    } catch (e) {
      say(e.name === 'NotAllowedError' ? 'Passkey prompt closed — nothing was sent' : (e.message || 'Send failed'), 'err');
    } finally {
      SENDING = false;
      UI.setSendBusy(false);
      btn.disabled = ACTIVE ? false : true;
    }
  });

  /* ---------------- scan a QR code ----------------
     Typing an address by hand is how money goes to the wrong place. */
  $('#btn-scan').addEventListener('click', async () => {
    const btn = $('#btn-scan'), st = $('#send-status');
    const say = (msg, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = msg; };
    btn.disabled = true;
    try {
      const hit = await QR.scan();
      if (!hit) return;                          // cancelled — say nothing
      if (!QR.looksLikeAddress(hit.address)) {
        return say('That code is not a Koinos address: ' + hit.address.slice(0, 42), 'err');
      }
      $('#send-to').value = hit.address;
      /* A payment QR can carry the amount too; taking it saves retyping a
         number that was already in the code. */
      if (hit.amount) $('#send-amount').value = hit.amount;
      say('Scanned ✓ ' + hit.address + (hit.amount ? ` · ${hit.amount} ${UI.sendSymbol()}` : ''), 'ok');
      ($('#send-amount').value ? $('#btn-send') : $('#send-amount')).focus();
    } catch (e) {
      say(e.message || 'Could not open the camera', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /** The whole balance, to the token's smallest unit.

      Formatted from the chain's own integer rather than the displayed
      number: a float rounds, and "all" that leaves dust behind — or asks for
      more than exists — is not all. Mana is sponsored here, so nothing has
      to be held back for a fee. */
  function sendAllBalance() {
    const asset = UI.sendAsset();
    return asset === 'vhp' ? VHP_BALANCE_SATS : asset === 'koin' ? BALANCE_SATS : TOKEN_BALANCES[asset] || '';
  }
  function sendAllAmount() {
    const amount = TokenAmounts.fromUnits(sendAllBalance(), UI.sendDecimals());
    return amount === '0' ? null : amount;
  }

  $('#btn-send-all').addEventListener('click', () => {
    const st = $('#send-status');
    const all = sendAllAmount();
    if (!all) {
      st.hidden = false; st.className = 'status err';
      const balance = sendAllBalance();
      st.textContent = balance === '' ? 'Balance is unavailable — refresh and try again' : `There is no ${UI.sendSymbol()} in this account yet`;
      return;
    }
    $('#send-amount').value = all;
    $('#send-to').value.trim() ? $('#btn-send').focus() : $('#send-to').focus();
  });

  $('#btn-signout').addEventListener('click', () => {
    if (!confirm('Sign out?\n\nYour passkey (or recovery kit) re-opens this account — nothing is lost.')) return;
    RESUMING = null; // a late restore response must not reopen a signed-out wallet
    stopPoll();
    stopDappPoll();
    if (DAPP) void api('/api/dapp/disconnect', DAPP).catch(() => {});
    saveDapp(null); paintDappRequest(null, null);
    PAINT_GEN++; PAINTING = false; PAINT_AGAIN = false;   // in-flight reads for this account are void
    BALANCE_SATS = ''; VHP_BALANCE_SATS = ''; TOKEN_BALANCES = {};
    clearPendingKit();
    ADDRESS = null; ACTIVE = false; RECOVERY = null; CREDENTIALS = []; PENDING_BACKUP = null;
    transactionFeed?.reset();
    /* The credential id stays remembered: it's public on-chain anyway, the
       biometric still gates every ceremony. Sign-in never creates accounts. */
    storeAddr(null);
    try { localStorage.removeItem('bw_wif'); localStorage.removeItem('bw_passkey_id'); } catch (_) {} // v1 leftovers
    UI.reset(); if (WalletClient.canBuy) Fund.forget();
    show('#view-landing');
    $('#alt-unlock').hidden = false;
  });

  /* ---------------- fund card ---------------- */
  if (WalletClient.canBuy) Fund.mount({
    api,
    signPrepared,
    credentialId: () => (RECOVERY ? RECOVERY.credentialId : Passkey.storedId()),
    onKoinMoved: () => { void transactionFeed?.refresh(); paint(); },
  });

  /* ---------------- resume ---------------- */
  function resumeWallet() {
    const address = storedAddr(), credentialId = Passkey.storedId();
    if (!address || !credentialId) { show('#view-landing'); return; }
    ADDRESS = address;
    const session = { address, credentialId };
    RESUMING = session;
    $('#activation').hidden = false;
    $('#activation').className = 'status';
    $('#activation').textContent = 'Reopening your wallet…';
    $('#btn-send').disabled = true;
    show('#view-wallet');
    void refreshResumedWallet(session);
  }

  async function refreshResumedWallet(session) {
    const current = () => RESUMING === session && ADDRESS === session.address;
    if (!current()) return;
    try {
      // Account identity and balances are public. Transaction authority still
      // requires a new passkey assertion in signPrepared/connectDapp.
      const who = await api('/api/whoami', { credentialId: session.credentialId });
      if (!current()) return;
      if (!who || typeof who.address !== 'string' || !Array.isArray(who.credentials) || typeof who.step !== 'string') {
        throw new Error('Invalid account response');
      }
      if (who.address !== session.address) {
        const error = new Error('The saved passkey belongs to another wallet.');
        error.status = 404; throw error;
      }
      RESUMING = null;
      takeSmart(who);
      if (who.step !== 'active') pollStatus();
      show('#view-wallet');
    } catch (e) {
      if (!current()) return;
      if (e.status === 404) {
        RESUMING = null; ADDRESS = null; ACTIVE = false; CREDENTIALS = [];
        transactionFeed?.reset();
        storeAddr(null); stopDappPoll(); UI.reset(); if (WalletClient.canBuy) Fund.forget();
        show('#view-landing');
        alertLine('Choose a saved passkey to reopen your wallet. The previous account could not be matched.');
        return;
      }
      // A temporary outage is not a sign-out, and must not erase the session.
      $('#activation').className = 'status err';
      $('#activation').textContent = 'Wallet connection unavailable. Reconnecting automatically…';
      setTimeout(() => { void refreshResumedWallet(session); }, 3000);
    }
  }

  DAPP = loadDapp();
  if (DAPP && !DAPP.address) saveDapp(null); // legacy connections need fresh verified approval
  // Explicit recovery links take priority over reopening the saved wallet.
  if (OPEN_RECOVERY) show('#view-recover');
  else resumeWallet();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollDapp(); });
})();
