import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

// ---- Module mocks (hoisted - no external variable references) ----

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
  }),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
    cb(null);
  }),
}));

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomInt: vi.fn().mockReturnValue(847293),
  };
});

vi.mock('../../src/docker/docker-manager.js', () => ({
  createDockerManager: vi.fn(() => ({
    preflight: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue('container-id'),
    start: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockResolvedValue(true),
    imageExists: vi.fn().mockResolvedValue(true),
    buildImage: vi.fn().mockResolvedValue(undefined),
    getImageLabel: vi.fn().mockResolvedValue(undefined),
    createNetwork: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    pullImage: vi.fn().mockResolvedValue(undefined),
    containerExists: vi.fn().mockResolvedValue(true),
    getImageId: vi.fn().mockResolvedValue('sha256:abc123'),
  })),
}));

vi.mock('../../src/config/user-config.js', () => ({
  saveUserConfig: vi.fn(),
  loadUserConfig: vi.fn(() => ({
    signal: {
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
    },
  })),
}));

// Container manager mock - needs to be a shared instance for test reconfiguration
const sharedContainerManager = {
  ensureRunning: vi.fn().mockResolvedValue('http://127.0.0.1:0'),
  waitForHealthy: vi.fn().mockResolvedValue(undefined),
  teardown: vi.fn().mockResolvedValue(undefined),
  pullImage: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  isRunning: vi.fn().mockResolvedValue(true),
};

vi.mock('../../src/signal/signal-container.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/signal/signal-container.js')>(
    '../../src/signal/signal-container.js',
  );
  return {
    ...actual,
    createSignalContainerManager: vi.fn(() => sharedContainerManager),
  };
});

vi.mock('../../src/signal/signal-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/signal/signal-config.js')>(
    '../../src/signal/signal-config.js',
  );
  return {
    ...actual,
    getSignalDataDir: vi.fn(() => '/tmp/nonexistent-signal-test-data'),
    resolveSignalConfig: vi.fn(() => ({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: 'bbernhard/signal-cli-rest-api:latest',
        port: 0,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    })),
  };
});

// ---- Imports (after mocks) ----

import * as p from '@clack/prompts';
import {
  validatePhoneNumber,
  registerNewNumber,
  verifyRecipientIdentity,
  runSignalSetup,
  runReTrust,
} from '../../src/signal/setup-signal.js';

// Cast for access to mock methods
const mockP = p as unknown as {
  text: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  intro: ReturnType<typeof vi.fn>;
  outro: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  note: ReturnType<typeof vi.fn>;
  isCancel: ReturnType<typeof vi.fn>;
  spinner: ReturnType<typeof vi.fn>;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
};
// ---- Mock Signal REST API server ----

interface SentMessage {
  message: string;
  number: string;
  recipients: string[];
}

class MockSignalApi {
  private server: http.Server;
  readonly sentMessages: SentMessage[] = [];
  readonly port: number;
  private identities: Array<{
    number: string;
    fingerprint: string;
    safety_number: string;
    added: string;
    status: string;
  }> = [];
  private accounts: string[] = [];
  private registerShouldFail = false;
  private verifyShouldFail = false;

  constructor(port: number) {
    this.port = port;
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  setIdentities(entries: Array<{ number: string; fingerprint: string }>): void {
    this.identities = entries.map((e) => ({
      number: e.number,
      fingerprint: e.fingerprint,
      safety_number: 'test-safety-number',
      added: new Date().toISOString(),
      status: 'TRUSTED_UNVERIFIED',
    }));
  }

  setRegisterShouldFail(fail: boolean): void {
    this.registerShouldFail = fail;
  }

  setVerifyShouldFail(fail: boolean): void {
    this.verifyShouldFail = fail;
  }

  setAccounts(accounts: string[]): void {
    this.accounts = accounts;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/v1/health' && req.method === 'GET') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/v1/accounts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.accounts));
      return;
    }

    if (url.pathname.startsWith('/v1/register/') && !url.pathname.includes('/verify/') && req.method === 'POST') {
      if (this.registerShouldFail) {
        res.writeHead(400);
        res.end('Captcha rejected');
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        void body; // consumed but not needed for mock
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (url.pathname.includes('/verify/') && req.method === 'POST') {
      if (this.verifyShouldFail) {
        res.writeHead(400);
        res.end('Invalid code');
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.pathname === '/v2/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as SentMessage;
        this.sentMessages.push(parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamp: Date.now() }));
      });
      return;
    }

    if (url.pathname.startsWith('/v1/identities/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.identities));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }
}

// ---- Tests ----

describe('validatePhoneNumber', () => {
  it('accepts valid E.164 numbers', () => {
    expect(validatePhoneNumber('+15551234567')).toBeUndefined();
    expect(validatePhoneNumber('+491711234567')).toBeUndefined();
    expect(validatePhoneNumber('+8613800138000')).toBeUndefined();
  });

  it('rejects empty input', () => {
    expect(validatePhoneNumber('')).toBe('Phone number is required');
    expect(validatePhoneNumber(undefined)).toBe('Phone number is required');
  });

  it('rejects numbers without + prefix', () => {
    expect(validatePhoneNumber('15551234567')).toContain('E.164');
  });

  it('rejects numbers that are too short', () => {
    expect(validatePhoneNumber('+12345')).toContain('E.164');
  });

  it('rejects numbers with non-digit characters', () => {
    expect(validatePhoneNumber('+1-555-123-4567')).toContain('E.164');
    expect(validatePhoneNumber('+1 555 1234567')).toContain('E.164');
  });
});

describe('registerNewNumber', () => {
  let api: MockSignalApi;
  let baseUrl: string;
  const PORT = 19201;

  beforeAll(async () => {
    api = new MockSignalApi(PORT);
    await api.start();
    baseUrl = `http://127.0.0.1:${PORT}`;
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.setRegisterShouldFail(false);
    api.setVerifyShouldFail(false);
  });

  it('completes registration successfully', async () => {
    mockP.text
      .mockResolvedValueOnce('+15551234567') // phone number
      .mockResolvedValueOnce('signalcaptcha://token123') // captcha
      .mockResolvedValueOnce('123-456'); // verification code

    const result = await registerNewNumber(baseUrl);
    expect(result).toBe('+15551234567');
  });

  it('throws when captcha is rejected', async () => {
    api.setRegisterShouldFail(true);

    mockP.text.mockResolvedValueOnce('+15551234567').mockResolvedValueOnce('signalcaptcha://badtoken');

    await expect(registerNewNumber(baseUrl)).rejects.toThrow('Registration failed: 400');
  });

  it('throws when verification code is wrong', async () => {
    api.setVerifyShouldFail(true);

    mockP.text
      .mockResolvedValueOnce('+15551234567')
      .mockResolvedValueOnce('signalcaptcha://token123')
      .mockResolvedValueOnce('999999');

    await expect(registerNewNumber(baseUrl)).rejects.toThrow('Verification failed: 400');
  });
});

describe('verifyRecipientIdentity', () => {
  let api: MockSignalApi;
  let baseUrl: string;
  const PORT = 19203;

  beforeAll(async () => {
    api = new MockSignalApi(PORT);
    await api.start();
    baseUrl = `http://127.0.0.1:${PORT}`;
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5' }]);
  });

  it('sends challenge code and returns identity key on correct entry', async () => {
    // randomInt is mocked to return 847293
    mockP.text.mockResolvedValueOnce('847293');

    const result = await verifyRecipientIdentity(baseUrl, '+15551234567', '+15559876543');

    expect(result).toBe('05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5');
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0].message).toContain('847293');
    expect(api.sentMessages[0].recipients).toEqual(['+15559876543']);
    expect(api.sentMessages[0].number).toBe('+15551234567');
  });

  it('allows retry on wrong code', async () => {
    mockP.text
      .mockResolvedValueOnce('000000') // wrong
      .mockResolvedValueOnce('847293'); // correct

    const result = await verifyRecipientIdentity(baseUrl, '+15551234567', '+15559876543');
    expect(result).toBe('05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5');
    expect(mockP.log.warn).toHaveBeenCalledWith(expect.stringContaining('2 attempt(s) remaining'));
  });

  it('fails after 3 wrong attempts', async () => {
    mockP.text.mockResolvedValueOnce('000000').mockResolvedValueOnce('111111').mockResolvedValueOnce('222222');

    await expect(verifyRecipientIdentity(baseUrl, '+15551234567', '+15559876543')).rejects.toThrow(
      'Challenge verification failed after 3 attempts',
    );
  });

  it('throws when identity key is not available', async () => {
    api.setIdentities([]); // No identities
    mockP.text.mockResolvedValueOnce('847293');

    await expect(verifyRecipientIdentity(baseUrl, '+15551234567', '+15559876543')).rejects.toThrow(
      'Identity key could not be retrieved',
    );
  });

  it('handles fingerprints with spaces', async () => {
    api.setIdentities([{ number: '+15559876543', fingerprint: '05 a1 b2 c3 d4' }]);
    mockP.text.mockResolvedValueOnce('847293');

    const result = await verifyRecipientIdentity(baseUrl, '+15551234567', '+15559876543');
    expect(result).toBe('05a1b2c3d4');
  });
});

describe('runSignalSetup', () => {
  let api: MockSignalApi;
  const PORT = 19204;

  beforeAll(async () => {
    api = new MockSignalApi(PORT);
    await api.start();
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5' }]);
    api.setRegisterShouldFail(false);
    api.setVerifyShouldFail(false);

    sharedContainerManager.ensureRunning.mockResolvedValue(`http://127.0.0.1:${PORT}`);
    sharedContainerManager.isRunning.mockResolvedValue(true);
    sharedContainerManager.pullImage.mockResolvedValue(undefined);
    sharedContainerManager.waitForHealthy.mockResolvedValue(undefined);
  });

  it('completes full registration flow and saves config', async () => {
    const { saveUserConfig: mockSave } = await import('../../src/config/user-config.js');

    mockP.confirm.mockResolvedValueOnce(true);
    mockP.text
      .mockResolvedValueOnce('+15551234567') // bot phone
      .mockResolvedValueOnce('signalcaptcha://tok123') // captcha
      .mockResolvedValueOnce('123-456') // SMS code
      .mockResolvedValueOnce('+15559876543') // recipient
      .mockResolvedValueOnce('847293'); // challenge code

    await runSignalSetup();

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({
          botNumber: '+15551234567',
          recipientNumber: '+15559876543',
          recipientIdentityKey: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5',
        }),
      }),
    );

    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('Setup complete'));
  });

  it('delegates to runReTrust when reTrust option is set', async () => {
    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: 'bbernhard/signal-cli-rest-api:latest',
        port: PORT,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    });

    mockP.text.mockResolvedValueOnce('847293');

    await runSignalSetup({ reTrust: true });

    expect(mockP.intro).toHaveBeenCalledWith('Signal Identity Re-verification');
  });

  it('displays summary note with all config values', async () => {
    mockP.confirm.mockResolvedValueOnce(true);
    mockP.text
      .mockResolvedValueOnce('+15551234567')
      .mockResolvedValueOnce('signalcaptcha://tok123')
      .mockResolvedValueOnce('123-456')
      .mockResolvedValueOnce('+15559876543')
      .mockResolvedValueOnce('847293');

    await runSignalSetup();

    // Find the 'Configuration saved' note
    const noteCall = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'Configuration saved');
    expect(noteCall).toBeDefined();
    expect(noteCall![0]).toContain('+15551234567');
    expect(noteCall![0]).toContain('+15559876543');
    expect(noteCall![0]).toContain('18080');
  });
});

describe('runReTrust', () => {
  let api: MockSignalApi;
  const PORT = 19205;

  beforeAll(async () => {
    api = new MockSignalApi(PORT);
    await api.start();
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05newkey9876543210fedcba' }]);

    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: 'bbernhard/signal-cli-rest-api:latest',
        port: PORT,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    });

    sharedContainerManager.isRunning.mockResolvedValue(true);
    sharedContainerManager.ensureRunning.mockResolvedValue(`http://127.0.0.1:${PORT}`);
  });

  it('re-verifies identity and saves new key', async () => {
    const { saveUserConfig: mockSave } = await import('../../src/config/user-config.js');
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({
          recipientIdentityKey: '05newkey9876543210fedcba',
        }),
      }),
    );

    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('Transport unlocked'));
  });

  it('displays previous and new key in note', async () => {
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    const noteCall = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'Key updated');
    expect(noteCall).toBeDefined();
    expect(noteCall![0]).toContain('Previous key:');
    expect(noteCall![0]).toContain('New key:');
  });

  it('starts container if not running', async () => {
    sharedContainerManager.isRunning.mockResolvedValue(false);
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(sharedContainerManager.ensureRunning).toHaveBeenCalled();
    expect(sharedContainerManager.waitForHealthy).toHaveBeenCalled();
  });

  it('exits when signal is not configured', async () => {
    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runReTrust()).rejects.toThrow('process.exit called');
      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    } finally {
      mockExit.mockRestore();
    }
  });
});
