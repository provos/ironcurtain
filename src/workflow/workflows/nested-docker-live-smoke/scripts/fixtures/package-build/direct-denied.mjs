import { connect } from 'node:net';

const EXPECTED_NETWORK_ERRORS = new Set(['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT']);

function requireNoDirectTcpRoute(hostname) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443 });
    socket.setTimeout(5_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`unexpected direct TCP route to ${hostname}:443`));
    });
    socket.once('timeout', () =>
      socket.destroy(Object.assign(new Error('expected bounded timeout'), { code: 'ETIMEDOUT' })),
    );
    socket.once('error', (error) => {
      if (EXPECTED_NETWORK_ERRORS.has(error.code)) resolve();
      else reject(error);
    });
  });
}

await requireNoDirectTcpRoute('registry.npmjs.org');
await requireNoDirectTcpRoute('104.16.25.34');
