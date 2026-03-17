#!/usr/bin/env node
/**
 * Quick smoke test: spawns @alanse/mcp-server-google-workspace inside an
 * anthropic srt sandbox, connects via MCP, and lists the 5 most recent emails.
 *
 * Prerequisites:
 *   - `ironcurtain auth import google <credentials.json>`
 *   - `ironcurtain auth google`  (completes browser OAuth flow)
 *
 * Usage:
 *   node scripts/test-gworkspace.mjs
 */

import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Imports from the project (compiled JS in dist/)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// We import from the compiled dist/ to avoid needing tsx
const { loadOAuthToken } = await import(join(root, 'dist/auth/oauth-token-store.js'));
const { loadClientCredentials } = await import(join(root, 'dist/auth/oauth-provider.js'));
const { googleOAuthProvider } = await import(join(root, 'dist/auth/providers/google.js'));
const { OAuthTokenProvider } = await import(join(root, 'dist/auth/oauth-token-provider.js'));
const { writeGWorkspaceCredentialFile } = await import(
  join(root, 'dist/trusted-process/gworkspace-credentials.js')
);
const { discoverNodePaths } = await import(
  join(root, 'dist/trusted-process/sandbox-integration.js')
);

// MCP SDK
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

const SRT_BIN = join(root, 'node_modules', '.bin', 'srt');

// ---------------------------------------------------------------------------
// 1. Load OAuth credentials and get a valid access token
// ---------------------------------------------------------------------------

const provider = googleOAuthProvider;

const clientCreds = loadClientCredentials(provider);
if (!clientCreds) {
  process.stderr.write(
    'No OAuth client credentials found.\n' +
      'Run: ironcurtain auth import google <path-to-credentials.json>\n',
  );
  process.exit(1);
}

const tokenProvider = new OAuthTokenProvider(provider, clientCreds);
if (!tokenProvider.isAuthorized()) {
  process.stderr.write('Not authorized. Run: ironcurtain auth google\n');
  process.exit(1);
}

process.stderr.write('Refreshing access token...\n');
const accessToken = await tokenProvider.getValidAccessToken();
const storedToken = loadOAuthToken(provider.id);
if (!storedToken) {
  process.stderr.write('Token vanished after refresh — aborting.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Write credential file for the MCP server (no refresh token!)
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'ironcurtain-gws-test-'));
const credsDir = join(workDir, 'gws-creds');
mkdirSync(credsDir, { recursive: true });

writeGWorkspaceCredentialFile(credsDir, accessToken, storedToken.expiresAt, storedToken.scopes);
process.stderr.write(`Credential file written to ${credsDir}\n`);

// ---------------------------------------------------------------------------
// 3. Write srt sandbox settings
// ---------------------------------------------------------------------------

// Discover node/npm paths that need to be readable under denyRead: ["~"]
const nodePaths = discoverNodePaths();
process.stderr.write(`Discovered node paths for allowRead: ${JSON.stringify(nodePaths)}\n`);

const srtSettings = {
  network: {
    allowedDomains: [
      'googleapis.com',
      '*.googleapis.com',
      'accounts.google.com',
      'oauth2.googleapis.com',
      'registry.npmjs.org',
      '*.npmjs.org',
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ['~'],
    allowRead: ['/usr', '/lib', '/etc', '/opt/homebrew', credsDir, ...nodePaths],
    allowWrite: [workDir],
    denyWrite: [],
  },
};

const settingsPath = join(workDir, 'srt-settings.json');
writeFileSync(settingsPath, JSON.stringify(srtSettings, null, 2));

// ---------------------------------------------------------------------------
// 4. Spawn the MCP server inside srt
// ---------------------------------------------------------------------------

const npxPath = process.env.NPX_PATH ?? 'npx';

// srt -s <settings> -c "<command>"
// The -c flag runs the command string through a shell, so no escaping needed
// for the simple npx invocation.
const serverCommand = `${npxPath} -y @alanse/mcp-server-google-workspace`;

process.stderr.write(`Spawning MCP server in srt sandbox...\n`);

const transport = new StdioClientTransport({
  command: SRT_BIN,
  args: ['-s', settingsPath, '-c', serverCommand],
  env: {
    ...process.env,
    NODE_OPTIONS: '',  // Strip IDE debugger preloads that reference paths under ~
    GWORKSPACE_CREDS_DIR: credsDir,
    CLIENT_ID: clientCreds.clientId,
    CLIENT_SECRET: clientCreds.clientSecret,
    npm_config_cache: join(workDir, '.npm-cache'),
  },
  stderr: 'pipe',
  cwd: workDir,
});

// Log server stderr for debugging
if (transport.stderr) {
  transport.stderr.on('data', (chunk) => {
    process.stderr.write(`[mcp-server] ${chunk.toString()}`);
  });
}

// ---------------------------------------------------------------------------
// 5. Connect MCP client and call gmail_list_messages
// ---------------------------------------------------------------------------

const client = new Client({ name: 'gws-test', version: '1.0.0' });

try {
  await client.connect(transport);
  process.stderr.write('Connected to MCP server. Listing tools...\n');

  const { tools } = await client.listTools();
  process.stderr.write(`Server exposes ${tools.length} tools.\n`);

  // Find the gmail_search_messages tool
  const gmailSearch = tools.find((t) => t.name === 'gmail_search_messages');
  if (!gmailSearch) {
    process.stderr.write('Tool gmail_search_messages not found. Available tools:\n');
    for (const t of tools.slice(0, 20)) {
      process.stderr.write(`  ${t.name}\n`);
    }
    process.exit(1);
  }

  process.stderr.write('Searching for 5 most recent emails...\n');

  const searchResult = await client.callTool({
    name: 'gmail_search_messages',
    arguments: { query: '', maxResults: 5 },
  });

  // Extract message IDs — the JSON object is embedded at the end of a text block
  const textContent = searchResult.content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const jsonMatch = textContent?.match(/\{[\s\S]*"messages"[\s\S]*\}$/);
  if (!jsonMatch) {
    process.stderr.write('Unexpected search result format.\n');
    process.stdout.write(JSON.stringify(searchResult, null, 2) + '\n');
    process.exit(1);
  }

  const searchData = JSON.parse(jsonMatch[0]);
  const messageIds = searchData.messages.slice(0, 5).map((m) => m.id);

  process.stderr.write(`Fetching ${messageIds.length} messages...\n\n`);

  // Fetch each message and print a summary
  for (let i = 0; i < messageIds.length; i++) {
    const msgResult = await client.callTool({
      name: 'gmail_get_message',
      arguments: { messageId: messageIds[i] },
    });

    // The result contains a text block with the message details
    const textBlock = msgResult.content?.find((b) => b.type === 'text');
    if (textBlock) {
      // Extract key headers from the text output
      const text = textBlock.text;
      const from = text.match(/From:\s*(.+)/)?.[1] ?? 'unknown';
      const subject = text.match(/Subject:\s*(.+)/)?.[1] ?? '(no subject)';
      const date = text.match(/Date:\s*(.+)/)?.[1] ?? 'unknown date';

      process.stdout.write(`${i + 1}. ${subject}\n`);
      process.stdout.write(`   From: ${from}\n`);
      process.stdout.write(`   Date: ${date}\n\n`);
    }
  }
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.cause) process.stderr.write(`Cause: ${err.cause}\n`);
  process.exit(1);
} finally {
  try {
    await client.close();
  } catch {
    // ignore close errors
  }
}
