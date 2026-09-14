'use strict';
const { Contract, utils } = require('koilib');
const tokenAbi = require('../abi/token-abi.json');
const producer = require('./dapp-producer');
const accountAbi = require('../contracts/vendor/account/account-abi.json');
const signAbi = require('../contracts/vendor/mod-sign-webauthn/modsignwebauthn-abi.json');
const validationAbi = require('../contracts/vendor/mod-validation-signature/modvalidationsignature-abi.json');

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
}
function abi(input) {
  const copy = JSON.parse(JSON.stringify(input));
  const n = copy.koilib_types?.nested?.koinos?.nested;
  if (n) { delete n.btype; delete n._btype; }
  return copy;
}
function amount(raw, decimals) {
  const value = String(raw ?? '0');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error('Invalid token amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return `${value} base units (decimals unavailable)`;
  return utils.formatUnits(value, decimals);
}
function methodFor(contractAbi, entry) {
  return Object.entries(contractAbi.methods).find(([, m]) => Number(m.entry_point) === Number(entry))?.[0];
}
async function decode(operation, contractAbi) {
  const contract = new Contract({ id: operation.call_contract.contract_id, abi: abi(contractAbi) });
  const decoded = await contract.decodeOperation(operation);
  const rebuilt = await contract.functions[decoded.name](decoded.args, { onlyOperation: true });
  const a = operation.call_contract, b = rebuilt.operation.call_contract;
  if (a.contract_id !== b.contract_id || Number(a.entry_point) !== Number(b.entry_point)
      || !Buffer.from(a.args, 'base64url').equals(Buffer.from(b.args, 'base64url'))) {
    throw new Error('Noncanonical contract arguments; recreate the transaction');
  }
  return decoded;
}

async function metadata(chain, id) {
  let timer;
  try {
    return await Promise.race([
      chain.tokenMeta(id, { fresh: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Token metadata unavailable')), 5000); }),
    ]);
  } catch (_) { return { symbol: 'token', decimals: null }; }
  finally { clearTimeout(timer); }
}

// Never use a website's ABI or description as the wallet's review. Unknown
// methods retain their exact contract/entry/arguments and require an explicit
// acknowledgement. They are always self-paid: the sponsor's ordinary ECDSA
// co-signature would grant its authority to arbitrary nested contract calls.
async function review(operations, address, network, chain) {
  const net = chain.net(), actions = [], warnings = [];
  let sponsorEligible = true;
  if (network === 'mainnet' && operations.some(op => op.call_contract.contract_id === producer.CONTRACTS.pob)) {
    try {
      const summary = await producer.reviewProducer(operations, address, network);
      return { version: 1, title: summary.title, network, sponsorEligible: true,
        actions: [{ title: summary.title, contract: producer.CONTRACTS.pob, detail: summary.detail }],
        warnings: [], requiresAcknowledgement: false };
    } catch (_) { /* Mixed or unfamiliar PoB operations receive the general review. */ }
  }
  for (const operation of operations) {
    const call = operation.call_contract;
    const native = call.contract_id === net.koinContract ? 'KOIN' : call.contract_id === net.vhpContract ? 'VHP' : null;
    const sensitiveAbi = call.contract_id === address ? accountAbi
      : call.contract_id === chain.K.modules.modSign ? signAbi
      : call.contract_id === chain.K.modules.modValidation ? validationAbi : null;
    if (sensitiveAbi) {
      sponsorEligible = false;
      let detail = `Entry point: ${call.entry_point}\nEncoded arguments: ${call.args}`;
      if (methodFor(sensitiveAbi, call.entry_point)) {
        const decoded = await decode(operation, sensitiveAbi);
        detail = `${decoded.name}\n${JSON.stringify(decoded.args, null, 2)}`;
      }
      actions.push({ title: 'Wallet permissions or configuration', contract: call.contract_id, detail });
      warnings.push('This calls your wallet or a wallet authority module. It may change who can control your account or remove your access.');
      continue;
    }
    const name = methodFor(tokenAbi, call.entry_point);
    if (['transfer', 'approve', 'burn', 'mint', 'transfer_ownership'].includes(name)) {
      let decoded;
      try { decoded = await decode(operation, tokenAbi); }
      catch (error) { if (native) throw error; /* An NFT or another contract may use a different schema. */ }
      if (decoded) {
        const a = decoded.args, meta = native ? { symbol: native, decimals: 8 } : await metadata(chain, call.contract_id);
        const unit = clean(meta.symbol, 30) || 'token';
        let title, detail, owner;
        const value = amount(a.value, meta.decimals);
        if (name === 'transfer') {
          owner = a.from; title = `Transfer ${value} ${unit}`;
          detail = `From: ${a.from}\nTo: ${a.to}\nAmount: ${value} ${unit}`;
        } else if (name === 'approve') {
          owner = a.owner; title = BigInt(a.value || '0') === 0n ? `Remove ${unit} spending permission` : `Allow spending of ${unit}`;
          detail = `Owner: ${a.owner}\nSpender: ${a.spender}\nSpending limit: ${value} ${unit}`;
          if (BigInt(a.value || '0') > 0n) warnings.push('A spending permission can let this spender move tokens later without another fingerprint approval.');
          if (String(a.value) === '18446744073709551615') warnings.push('This grants the maximum possible spending allowance.');
        } else if (name === 'burn') {
          owner = a.from; title = `Burn ${value} ${unit}`;
          detail = `From: ${a.from}\nAmount permanently burned: ${value} ${unit}`;
          warnings.push('Burning destroys tokens. It cannot be undone.');
        } else {
          title = name === 'mint' ? `Mint ${value} ${unit}` : 'Change token ownership';
          detail = JSON.stringify(a, null, 2);
          warnings.push('This changes token supply or token administration.');
        }
        const validAddresses = ['from', 'to', 'owner', 'spender', 'new_owner'].every(key => !a[key] || chain.isAddr(a[key]));
        if (!validAddresses) throw new Error('Invalid address in token operation');
        // Only native-token methods with the user's explicit authority are
        // eligible. Recognizing an arbitrary token's interface is not an audit.
        const eligible = !!native && ['transfer', 'approve', 'burn'].includes(name) && owner === address;
        sponsorEligible = sponsorEligible && eligible;
        if (!native) warnings.push('This token contract is not verified by KOIN Vault. Its symbol and decimals are contract-provided; decoded fields do not guarantee its behavior.');
        if (owner && owner !== address) warnings.push('This action names an account other than your connected wallet as its source or owner.');
        actions.push({ title, contract: call.contract_id, detail, entryPoint: call.entry_point });
        continue;
      }
    }
    sponsorEligible = false;
    actions.push({ title: 'Unrecognized contract action', contract: call.contract_id,
      detail: `Entry point: ${call.entry_point}\nEncoded arguments (base64url): ${call.args}`, unknown: true });
    warnings.push('KOIN Vault cannot explain this contract action. It may transfer assets, grant permissions, or change wallet authority. Continue only if you understand the contract and arguments.');
  }
  return { version: 1, title: actions.length === 1 ? actions[0].title : `Review ${actions.length} contract actions`, network,
    actions, warnings: [...new Set(warnings)], sponsorEligible, requiresAcknowledgement: warnings.length > 0 };
}

module.exports = { review, decode, amount, clean };
