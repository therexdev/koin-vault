'use strict';
const { ethers } = require('ethers');

function amountWei(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) throw new Error('Enter an ETH amount with at most 18 decimal places');
  const amount = ethers.parseEther(text);
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  return amount;
}

async function quote({ provider, from, to, amount, max = false }) {
  if (typeof max !== 'boolean') throw new Error('Invalid Max selection');
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error('Enter a valid Ethereum address');
  to = ethers.getAddress(to);
  if (to === ethers.getAddress(from)) throw new Error('Choose a different receiving address');
  const [network, balance, pendingBalance, fee, code, nonce, pendingNonce] = await Promise.all([
    provider.getNetwork(), provider.getBalance(from, 'latest'), provider.getBalance(from, 'pending'),
    provider.getFeeData(), provider.getCode(to), provider.getTransactionCount(from, 'latest'),
    provider.getTransactionCount(from, 'pending'),
  ]);
  if (network.chainId !== 1n) throw new Error('Ethereum mainnet is required');
  if (nonce !== pendingNonce) throw new Error('An Ethereum transaction is still pending; wait for it to confirm');
  const available = balance < pendingBalance ? balance : pendingBalance;
  // A fixed legacy gas price makes Max exact for ordinary 21,000-gas sends.
  // EIP-1559's maximum fee reserve would otherwise leave a refundable surplus.
  if (!fee.gasPrice || fee.gasPrice <= 0n) throw new Error('Could not determine Ethereum gas price');
  const gasPrice = (fee.gasPrice * 12n + 9n) / 10n;
  let gasLimit = 21000n;
  const requested = max ? 0n : amountWei(amount);
  if (code !== '0x') {
    const probe = max ? 1n : requested;
    gasLimit = (await provider.estimateGas({ from, to, value: probe, gasPrice }) * 12n + 9n) / 10n;
  }
  let value = max ? available - gasLimit * gasPrice : requested;
  if (value <= 0n || value + gasLimit * gasPrice > available) throw new Error('Not enough ETH for the amount and network gas');
  // Always simulate the actual value. Contract wallets may use more gas than
  // ordinary addresses, and precompiles can have no code but still execute.
  const estimated = await provider.estimateGas({ from, to, value, gasPrice });
  if (estimated > gasLimit) {
    gasLimit = (estimated * 12n + 9n) / 10n;
    value = max ? available - gasLimit * gasPrice : requested;
    if (value <= 0n || value + gasLimit * gasPrice > available) throw new Error('Not enough ETH for network gas');
    if (await provider.estimateGas({ from, to, value, gasPrice }) > gasLimit) throw new Error('Gas estimate changed; review the withdrawal again');
  }
  return {
    from, to, max, amountEth: ethers.formatEther(value), gasEth: ethers.formatEther(gasLimit * gasPrice),
    totalEth: ethers.formatEther(value + gasLimit * gasPrice), balanceEth: ethers.formatEther(available),
    mayLeaveDust: gasLimit !== 21000n,
    request: { to, value: value.toString(), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), nonce, chainId: 1, type: 0 },
  };
}
module.exports = { quote, amountWei };
