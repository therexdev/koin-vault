'use strict';

const crypto = require('node:crypto');
const { utils } = require('koilib');
const { websiteOrigin } = require('./dapp-policy');

const SESSION_TTL = 30 * 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
const MAX_OPERATIONS = 6;
const sessions = new Map();
const preparing = new Set();
const error = (status, message) => Object.assign(new Error(message), { status });

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const cleanText = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
const sameSecret = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
};

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires < now) sessions.delete(id);
    else for (const [rid, request] of session.requests) if (request.expires < now) session.requests.delete(rid);
  }
}

function create({ origin, name, icon }) {
  prune();
  if (!websiteOrigin(origin)) throw error(403, 'Connect from an HTTPS website');
  if (sessions.size >= 2000 || [...sessions.values()].filter(s => s.origin === origin).length >= 100) {
    throw error(429, 'Too many open connections; try again later');
  }
  const id = token(18);
  const secret = token(32);
  sessions.set(id, {
    id, secret, origin, name: cleanText(name, 60) || new URL(origin).hostname,
    icon: /^https:\/\//i.test(String(icon || '')) ? cleanText(icon, 300) : '',
    address: null, connectedAt: null, expires: Date.now() + SESSION_TTL, requests: new Map(),
  });
  return { id, secret, expiresAt: Date.now() + SESSION_TTL };
}

function get(id, secret) {
  prune();
  const session = sessions.get(String(id || ''));
  if (!session || !sameSecret(session.secret, secret)) return null;
  return session;
}

function publicSession(session) {
  return {
    id: session.id, name: session.name, origin: session.origin, icon: session.icon,
    connected: !!session.address, address: session.address, connectedAt: session.connectedAt,
    expiresAt: session.expires,
  };
}

function connect(session, address) {
  assertLive(session);
  session.address = address;
  session.connectedAt = Date.now();
  return publicSession(session);
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS) {
    throw new Error(`a request must contain 1-${MAX_OPERATIONS} operations`);
  }
  const encoded = Buffer.byteLength(JSON.stringify(operations));
  if (encoded > 48 * 1024) throw new Error('transaction request is too large');
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('invalid operation');
    if (!operation.call_contract) throw new Error('connected apps may request contract calls only');
    if (Object.keys(operation).length !== 1) throw new Error('mixed operation types are not allowed');
    const call = operation.call_contract;
    if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(k => !['contract_id', 'entry_point', 'args'].includes(k))) throw new Error('invalid contract call fields');
    if (!/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(call.contract_id || '')) || !utils.isChecksumAddress(call.contract_id)) throw new Error('invalid contract address');
    if (!/^(0|[1-9]\d{0,9})$/.test(String(call.entry_point ?? '')) || Number(call.entry_point) > 4294967295) throw new Error('invalid contract entry point');
    if (typeof call.args !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(call.args)
        || Buffer.from(call.args, 'base64url').toString('base64url') !== call.args.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) throw new Error('invalid contract arguments');
  }
  return operations.map(({ call_contract: c }) => ({ call_contract: {
    contract_id: c.contract_id, entry_point: Number(c.entry_point), args: utils.encodeBase64url(Buffer.from(c.args, 'base64url')),
  } }));
}

function assertLive(session) {
  prune();
  if (sessions.get(session.id) !== session) throw error(404, 'connection not found or expired');
}
function assertAvailable(session) {
  assertLive(session);
  if (!session.address) throw new Error('connect the wallet first');
  for (const s of sessions.values()) {
    if (s.address === session.address && [...s.requests.values()].some(r => ['pending', 'submitting'].includes(r.status))) {
      throw error(409, 'finish the pending wallet request first');
    }
  }
  if (session.requests.size >= 60) throw error(429, 'Too many requests in this session');
}
function beginPrepare(session) {
  assertAvailable(session);
  return lockAccount(session);
}
function lockAccount(session) {
  if (preparing.has(session.address)) throw error(409, 'finish the pending wallet request first');
  if (preparing.size >= 32) throw error(429, 'The wallet is busy; try again shortly');
  preparing.add(session.address);
  return () => preparing.delete(session.address);
}
function beginSubmit(session) {
  assertLive(session);
  // Keep the nonce locked even if the user disconnects or the session expires
  // while a broadcast is in flight. Its outcome may already be irreversible.
  return lockAccount(session);
}
function addRequest(session, { operations, summary, review, transaction, mode = 'broadcast', funding }) {
  assertAvailable(session);
  const id = token(18);
  const request = {
    id, operations: mode === 'launch' ? operations : validateOperations(operations), transaction, mode, review, funding,
    summary: {
      title: cleanText(summary && summary.title, 80) || 'Transaction request',
      detail: cleanText(summary && summary.detail, 300),
      network: cleanText(summary && summary.network, 30),
    },
    status: 'pending', createdAt: Date.now(), expires: Math.min(session.expires, Date.now() + REQUEST_TTL),
    txid: null, error: null,
  };
  session.requests.set(id, request);
  return request;
}

function pending(session) {
  return [...session.requests.values()].filter((r) => r.status === 'pending').map((r) => ({
    id: r.id, summary: r.summary, transaction: r.transaction, operations: r.operations, mode: r.mode,
    createdAt: r.createdAt, expiresAt: r.expires, review: r.review, funding: r.funding,
  }));
}

function request(session, id) { return session.requests.get(String(id || '')) || null; }
function settle(request, status, extra = {}) { Object.assign(request, { status, ...extra }); }
function disconnect(session) { sessions.delete(session.id); }

module.exports = { create, get, publicSession, connect, addRequest, pending, request, settle, disconnect, validateOperations, assertLive, beginPrepare, beginSubmit, _sessions: sessions };
