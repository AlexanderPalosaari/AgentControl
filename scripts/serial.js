#!/usr/bin/env node
// Runs a command while holding a machine-wide lock, so commands that share one resource run one at a time.
// Usage: node scripts/serial.js <lock-name> -- <command> [args...]
import { runSerial } from '../lib/serial.js';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const name = args[0];
if (!name || name === '--' || sep < 0) {
  process.stderr.write('Usage: node serial.js <lock-name> -- <command> [args...]\n');
  process.exit(2);
}
process.exitCode = await runSerial(name, args.slice(sep + 1));
