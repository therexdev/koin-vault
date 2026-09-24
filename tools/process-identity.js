'use strict';
const fs = require('node:fs');
const os = require('node:os');

function processIdentity(pid) {
  const value = { pid, host: os.hostname() };
  if (process.platform !== 'linux') return value;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 is parenthesized and may contain spaces or parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    value.state = fields[0];
    value.start = fields[19];
    value.boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    value.namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
  } catch (_) { /* PID existence remains the conservative fallback. */ }
  return value;
}

// Return false only with evidence that this PID belongs to another process.
function sameProcess(a, b) {
  if (!a || !b || a.pid !== b.pid || a.host !== b.host) return null;
  if (['Z', 'X'].includes(b.state)) return false;
  if (a.boot && b.boot && a.boot !== b.boot) return false;
  if (!a.boot || a.boot !== b.boot || !a.namespace || a.namespace !== b.namespace) return null;
  return a.start && b.start ? a.start === b.start : null;
}

module.exports = { processIdentity, sameProcess };
