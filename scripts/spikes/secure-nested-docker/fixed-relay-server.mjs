#!/usr/bin/env node

import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const args = parseArgs(process.argv.slice(2));
const socketPath = args.socket;
const readyFile = args['ready-file'];
const logFile = args['log-file'];
if (!socketPath || !readyFile || !logFile) {
  throw new Error('--socket, --ready-file, and --log-file are required');
}

let connections = 0;
const server = net.createServer((socket) => {
  connections += 1;
  const connection = connections;
  let requestBytes = 0;
  let responded = false;
  socket.on('data', (chunk) => {
    requestBytes += chunk.length;
    if (responded) return;
    responded = true;
    const body = 'outer-relay-ok';
    socket.end(
      `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
  socket.on('close', () => {
    appendFileSync(logFile, `${JSON.stringify({ connection, requestBytes, time: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
  });
});

server.listen(socketPath, () => {
  // Apple preserves the source socket mode on the guest relay. Rootless-Docker
  // children use subordinate UIDs, so the bundle-wide fixed endpoint must be
  // connectable by all bundle principals. Its host parent remains mode 0700.
  chmodSync(socketPath, 0o666);
  writeFileSync(readyFile, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`);
    result[key.slice(2)] = value;
  }
  return result;
}
