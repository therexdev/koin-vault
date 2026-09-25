'use strict';
// Reproduce the public-listener interception in managed Node launchers:
// LiteSpeed ignores a second http.listen; Passenger auto-install throws.
// https://github.com/litespeedtech/openlitespeed/blob/master/dist/fcgi-bin/lsnode.js
// https://www.phusionpassenger.com/library/indepth/nodejs/reverse_port_binding.html
const http = require('node:http');
const net = require('node:net');
const mode = process.env.MANAGED_HTTP_TEST;
if (mode === 'denied') {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (args[0]?.exclusive === true) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('Private port denied by host'), { code: 'EACCES' })));
      return this;
    }
    return listen.apply(this, args);
  };
}
if (mode) {
  const listen = http.Server.prototype.listen;
  let installed = false;
  http.Server.prototype.listen = function (...args) {
    if (installed) {
      const message = 'http.Server.listen() was called more than once';
      if (mode === 'passenger') throw new Error(message + ' (auto-install mode)');
      console.error(message + ', ignore.');
      return this;
    }
    installed = true;
    return listen.apply(this, args);
  };
  // LiteSpeed also overrides address() for all HTTP servers. Private
  // endpoint checks must inspect the underlying net.Server instead.
  http.Server.prototype.address = () => '/managed/public.socket';
}
