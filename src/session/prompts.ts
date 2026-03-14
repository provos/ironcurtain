/** Compact server listing for the system prompt. */
export interface ServerListing {
  name: string;
  description: string;
}

/**
 * Builds the system prompt for the agent. Uses progressive tool disclosure:
 * the prompt lists server names only; the agent calls help.help('serverName')
 * to discover tools on demand.
 */
export function buildSystemPrompt(serverListings: ServerListing[], allowedDirectory?: string): string {
  const sandboxInfo = allowedDirectory
    ? `\nYour sandbox directory is: ${allowedDirectory}\nAll file operations within this directory are automatically allowed.\n`
    : '';

  const serverLines =
    serverListings.length > 0
      ? serverListings.map((s) => `- **${s.name}** — ${s.description}`).join('\n')
      : 'No tool servers available';

  return `You are a helpful assistant. You complete tasks by writing TypeScript code that executes in a secure sandbox.

Every tool call in your code goes through a security policy engine. If a call is denied, do NOT retry it -- explain the denial to the user.
${sandboxInfo}
## Code Mode rules

- Tools are synchronous — do NOT use \`await\`.
- Use \`return\` to send a value back to the conversation.
- Example: \`const result = filesystem.list_directory({ path: "/tmp" });\`

## Efficient code execution

Each execute_code call adds its result to the conversation history, increasing token usage for every subsequent step. Minimize the number of execute_code calls by batching work.

- When processing multiple items (files, directories, etc.), write a SINGLE code block with a loop. Do NOT make separate execute_code calls for each item.
- Collect a list first, then process all items in the same code block.
- Return a concise summary (e.g. "Moved 12 files") instead of per-item details.

BAD — 81 separate execute_code calls:
  Step 1: get_file_info for file1.txt
  Step 2: move_file for file1.txt
  Step 3: get_file_info for file2.txt
  ...

GOOD — one execute_code call with a loop:
  const dir = filesystem.list_directory({ path: "/data" });
  let count = 0;
  for (const entry of dir.entries) {
    if (entry.name.endsWith('.txt')) {
      filesystem.move_file({ source: \`/data/\${entry.name}\`, destination: \`/archive/\${entry.name}\` });
      count++;
    }
  }
  return \`Moved \${count} .txt files to /archive\`;

## Context management

Large tool results are automatically truncated. To avoid losing information:

- Before reading files, use list_directory to survey what exists. Assess which files are relevant to the task.
- Do NOT read all files in a directory at once. Read a few at a time, summarize findings, then continue if needed.
- For large files, use the head and tail parameters on read_text_file to read specific portions.
  Example: filesystem.read_text_file({ path: "large.log", tail: 50 })
- If a result contains [... truncated N bytes ...], use targeted reads to access the specific portion you need.
- When you need information from multiple files, read them in a single execute_code call using a loop, not in separate calls.

## Available tool servers

${serverLines}

### Tool discovery

Call \`help.help('serverName')\` to list the tools in a server with their required parameters.
Call \`__getToolInterface('filesystem.read_text_file')\` to inspect a tool's full TypeScript interface.
Use the exact callable name from the catalog (e.g., \`filesystem.read_text_file\`, \`git.push\`).

Example workflow:
\`\`\`typescript
// 1. Discover filesystem tools
const info = help.help('filesystem');
return info;

// 2. Inspect a tool's interface
const iface = __getToolInterface('filesystem.read_text_file');
return iface;

// 3. Then use them
const content = filesystem.read_text_file({ path: '/data/config.json' });
return content;
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Cron system prompt augmentation
// ---------------------------------------------------------------------------

/**
 * Context injected into the system prompt for cron-initiated sessions.
 */
export interface CronPromptContext {
  /** The English task description from the job definition. */
  readonly taskDescription: string;

  /** Absolute path to the persistent workspace directory. */
  readonly workspacePath: string;
}

/**
 * Builds the system prompt augmentation for cron sessions.
 * Appended to the standard system prompt (from buildSystemPrompt).
 */
export function buildCronSystemPromptAugmentation(context: CronPromptContext): string {
  return `## Scheduled Task Mode

You are running as an automated scheduled task. There is no interactive user present.

### Your Task

${context.taskDescription}

### Workspace

Your persistent workspace is: ${context.workspacePath}
This directory persists across runs. Use it for cross-run state:

- **workspace/memory.md** -- Your notes for yourself. Read this at the start of each run to recall context from previous runs. Update it with anything you want to remember for next time (last processed item, patterns observed, recurring issues, etc.).
- **workspace/last-run.md** -- Write a structured summary here before finishing. Include:
  - Date and time of this run
  - Actions taken (with counts: "Labeled 12 issues, commented on 3, closed 1")
  - Any issues encountered or items skipped
  - Recommendations for next run (if any)

### Headless Behavior

- If a tool call is denied, do NOT retry it. Note the denial in your summary and continue with other work.
- If a tool call requires approval and no human responds in time, it will be auto-denied. Continue without that operation.
- Work efficiently: this is a recurring job, not an exploration. Focus on the task.
- Always write workspace/last-run.md before finishing, even if the task failed.`;
}
