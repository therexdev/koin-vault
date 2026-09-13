'use strict';

// Per-page state only. A shared Chrome cookie/localStorage flag would also
// remove Buy from a browser tab or PWA opened by the same person.
const WalletClient = (() => {
  const android = document.documentElement.dataset.walletClient === 'android'
    || /^\/android(?:\/|$)/.test(location.pathname);
  if (android) document.documentElement.dataset.walletClient = 'android';
  // This script runs in <head>, before the browser can offer installation.
  // Keep the event even if the rest of the UI has not loaded yet.
  const installation = { prompt: null, installed: false, busy: false };
  window.addEventListener('beforeinstallprompt', (event) => {
    if (android) return;
    event.preventDefault();
    installation.prompt = event;
    installation.installed = false;
    window.dispatchEvent(new Event('wallet-install-change'));
  });
  window.addEventListener('appinstalled', () => {
    if (android) return;
    installation.prompt = null;
    installation.installed = true;
    window.dispatchEvent(new Event('wallet-install-change'));
  });
  return Object.freeze({
    android,
    installation,
    canBuy: !android,
    apiPath: (path) => android && path.startsWith('/api/') ? '/android' + path : path,
    serviceWorker: android ? '/android/sw.js' : '/sw.js',
    serviceWorkerScope: android ? '/android/' : '/',
  });
})();
