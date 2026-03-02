import { describe, it, expect, afterEach } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { TcpServerTransport } from '../src/trusted-process/tcp-server-transport.js';
import { serializeMessage, deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Connects to a TCP host:port and returns the socket. */
function connectToTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port }, () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Sends a JSON-RPC message over a socket using NDJSON framing. */
function sendMessage(socket: Socket, message: JSONRPCMessage): void {
  socket.write(serializeMessage(message));
}

/** Reads lines from a socket until a complete JSON-RPC message is received. */
function readMessage(socket: Socket): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        socket.off('data', onData);
        socket.off('error', reject);
        const line = buffer.substring(0, newlineIndex);
        resolve(deserializeMessage(line));
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/**
 * Collects messages from a transport's onmessage callback.
 * Returns the array (filled by side-effect) and a function
 * that waits until at least `count` messages have arrived.
 */
function createMessageCollector(transport: TcpServerTransport) {
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => messages.push(msg);

  function waitForMessages(count: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (messages.length >= count) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });
  }

  return { messages, waitForMessages };
}

describe('TcpServerTransport', () => {
  let transport: TcpServerTransport | undefined;
  let clientSocket: Socket | null = null;

  afterEach(async () => {
    if (clientSocket) {
      clientSocket.destroy();
      clientSocket = null;
    }
    if (transport) await transport.close();
  });

  it('binds to an OS-assigned port and exposes it via .port', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();

    const port = transport.port;
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('throws when accessing .port before start()', () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    expect(() => transport!.port).toThrow('has not been started');
  });

  it('accepts connections and receives messages', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();
    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };

    sendMessage(clientSocket, testMessage);

    await waitForMessages(1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(testMessage);
  });

  it('sends messages to the connected client', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { waitForMessages } = createMessageCollector(transport);
    await transport.start();

    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    // Send a client→server message to prove the connection is established.
    // This is more reliable than setImmediate — on macOS the connection
    // callback can be deferred past a single event-loop tick.
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 0, method: 'ping' });
    await waitForMessages(1);

    const responseMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    };

    await transport.send(responseMessage);

    const received = await readMessage(clientSocket);
    expect(received).toEqual(responseMessage);
  });

  it('handles multiple messages in sequence', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();
    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    for (let i = 1; i <= 3; i++) {
      sendMessage(clientSocket, {
        jsonrpc: '2.0',
        id: i,
        method: 'tools/list',
      });
    }

    await waitForMessages(3);

    expect(messages).toHaveLength(3);
    expect(messages.map((m) => ('id' in m ? m.id : null))).toEqual([1, 2, 3]);
  });

  it('invokes onclose callback when closed', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);

    let closeCalled = false;
    transport.onclose = () => {
      closeCalled = true;
    };

    await transport.start();
    await transport.close();

    expect(closeCalled).toBe(true);
  });

  it('throws when sending without an active connection', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 1,
        result: {},
      }),
    ).rejects.toThrow('No active TCP connection');
  });

  it('start() is idempotent -- second call is a no-op', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();
    const firstPort = transport.port;

    // Second start should not rebind to a different port
    await transport.start();
    expect(transport.port).toBe(firstPort);

    // Should still accept connections on the original port
    clientSocket = await connectToTcp('127.0.0.1', firstPort);
    expect(clientSocket.destroyed).toBe(false);
  });

  it('replaces old connection when a new client connects', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();

    // First client — send a message to confirm the connection is live
    const firstClient = await connectToTcp('127.0.0.1', transport.port);
    sendMessage(firstClient, { jsonrpc: '2.0', id: 0, method: 'setup' });
    await waitForMessages(1);

    // Second client replaces the first — send a message to confirm
    clientSocket = await connectToTcp('127.0.0.1', transport.port);
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 42, method: 'test' });
    await waitForMessages(2);

    expect(messages[1]).toEqual({
      jsonrpc: '2.0',
      id: 42,
      method: 'test',
    });

    firstClient.destroy();
  });
});
