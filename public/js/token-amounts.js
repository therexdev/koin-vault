/* Shared by the send form and server: token amounts never pass through a
   floating-point number. Standard Koinos transfers carry an unsigned uint64. */
'use strict';
const TokenAmounts = (() => {
  const MAX_UNITS = 18446744073709551615n;
  function validDecimals(decimals) {
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
  }
  function toUnits(amount, decimals) {
    if (!validDecimals(decimals)) throw new Error('This token has unsupported decimals');
    const message = decimals === 0
      ? 'Amount must be a positive whole number (this token has 0 decimals)'
      : `Amount must be a positive number (max ${decimals} decimals)`;
    if (typeof amount !== 'string' || amount.length > decimals + 21 || !/^\d+(\.\d+)?$/.test(amount)) throw new Error(message);
    const [whole, fraction = ''] = amount.split('.');
    if (fraction.length > decimals) throw new Error(message);
    const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
    if (units <= 0n) throw new Error(message);
    if (units > MAX_UNITS) throw new Error('Amount exceeds the token transfer limit');
    return units.toString();
  }
  function fromUnits(units, decimals) {
    if (!validDecimals(decimals) || typeof units !== 'string' || !/^\d{1,20}$/.test(units)) return null;
    const value = BigInt(units);
    if (value > MAX_UNITS) return null;
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = decimals ? String(value % base).padStart(decimals, '0').replace(/0+$/, '') : '';
    return fraction ? `${whole}.${fraction}` : String(whole);
  }
  return { validDecimals, toUnits, fromUnits };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TokenAmounts;
