# Daemon Mode

IronCurtain's daemon mode runs a long-lived process that combines Signal messaging with scheduled cron jobs. The daemon manages both interactive sessions (triggered by Signal messages) and headless sessions (triggered by cron schedules) through a single process with unified escalation routing.

Use daemon mode when you want IronCurtain to run tasks on a schedule — code reviews, repository maintenance, report generation, data processing — without manual intervention.

## Quick Start

**1. Define a job:**

```bash
ironcurtain daemon add-job
```

The interactive wizard prompts for a job ID, name, cron schedule, task description, task constitution (security policy), optional git repo, notification preferences, and budget overrides. Multi-line fields (task description, constitution) open your `$EDITOR`.

**2. Start the daemon:**

```bash
ironcurtain daemon
```

The daemon loads all enabled jobs, compiles any missing per-job policies, schedules them, and optionally connects to Signal. It runs until stopped with Ctrl-C or SIGTERM.

**Example: daily repository triage**

```bash
# Add a job that triages GitHub issues every morning at 8am
ironcurtain daemon add-job
# → ID: issue-triage
# → Schedule: 0 8 * * *
# → Task: "Review open issues in the repo, label them, and close stale ones"
# → Constitution: "Allow reading and labeling issues. Escalate closing issues."
# → Git repo: https://github.com/myorg/myrepo.git

# Start the daemon
ironcurtain daemon
```

## Job Definition

Jobs are defined interactively via `add-job` and stored as JSON at `~/.ironcurtain/jobs/{jobId}/job.json`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Stable slug identifier (lowercase alphanumeric, hyphens, underscores, 1-63 chars) |
| `name` | string | Yes | Human-friendly display name |
| `schedule` | string | Yes | Cron expression (5-field format: min hour dom mon dow) |
| `taskDescription` | string | Yes | English task description sent to the agent as its work prompt |
| `taskConstitution` | string | Yes | English policy text compiled into per-job security rules |
| `workspace` | string | No | Custom workspace path (default: `~/.ironcurtain/jobs/{id}/workspace/`) |
| `gitRepo` | string | No | Git repository URI to clone/sync before each run |
| `notifyOnEscalation` | boolean | Yes | Send Signal message on escalation (requires Signal) |
| `notifyOnCompletion` | boolean | Yes | Send Signal message with run summary on completion |
| `budgetOverrides` | object | No | Per-job resource budget overrides (see [Resource Budgets](#resource-budgets)) |
| `enabled` | boolean | Yes | Whether the job is scheduled. Disabled jobs are skipped |

## Commands

All commands are subcommands of `ironcurtain daemon`:

| Command | Description |
|---------|-------------|
| *(no subcommand)* | Start the daemon |
| `add-job` | Add a new scheduled job (interactive wizard) |
| `edit-job <id>` | Edit an existing job (interactive, opens `$EDITOR` for multi-line fields) |
| `list-jobs` | List all jobs with schedule, status, and next run time |
| `run-job <id>` | Manually trigger a job run immediately |
| `status` | Show daemon status (uptime, job counts, Signal status, next fire time) |
| `remove-job <id> [-f]` | Delete a job and all its artifacts (`-f` skips confirmation) |
| `disable-job <id>` | Stop scheduling a job (preserves definition and workspace) |
| `enable-job <id>` | Resume scheduling a disabled job |
| `recompile-job <id>` | Re-run policy compilation for a job |
| `logs <id> [--runs N]` | Show recent run summaries (default: last 5 runs) |

**Daemon options:**

| Option | Description |
|--------|-------------|
| `-a, --agent <name>` | Agent mode (same as `ironcurtain start`) |
| `--no-signal` | Skip Signal transport (cron-only mode) |
| `-f, --force` | Skip confirmation prompts |

When a daemon is running, mutation commands (`run-job`, `remove-job`, `disable-job`, `enable-job`, `recompile-job`) are automatically forwarded to it via a Unix domain socket. If no daemon is running, they operate directly on the filesystem.

## Cron Expressions

Jobs use standard 5-field cron expressions:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

**Examples:**

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 1 * *` | First day of every month at midnight |
| `0 9 * * 1` | Every Monday at 9:00 AM |

## Per-Job Policy

Each job has its own security policy compiled from its `taskConstitution` field. This is separate from the global policy used by interactive sessions.

**How it works:**

1. The `taskConstitution` text is compiled through the same pipeline as the global constitution (annotate → compile → verify), but scoped to the job's workspace.
2. Compiled artifacts are written to `~/.ironcurtain/jobs/{jobId}/generated/`.
3. The job's workspace directory is set as the `allowedDirectory` for policy evaluation — file operations within the workspace are governed by the job's own rules.
4. Global tool annotations (`~/.ironcurtain/generated/tool-annotations.json`) are reused; only the policy rules are job-specific.

**When to recompile:**

- After editing a job's `taskConstitution` (the daemon detects changes via content hash)
- After updating global tool annotations (`ironcurtain annotate-tools`)
- Manually via `ironcurtain daemon recompile-job <id>`

Policy compilation happens automatically when the daemon starts if a job has no compiled policy or its constitution has changed.

## Workspace and Git Sync

Each job has a persistent workspace directory that survives across runs.

**Default workspace:** `~/.ironcurtain/jobs/{jobId}/workspace/`

**Git sync behavior:** When a job has a `gitRepo` configured:

- **First run:** The repository is cloned into the workspace.
- **Subsequent runs:** Tracked files are fetched and reset to the remote's default branch (auto-detected via `origin/HEAD`, fallback to `main`). Untracked files are preserved — this means cross-run state files like `memory.md` and `last-run.md` survive the sync.
- **Discarded changes:** Any tracked-file modifications from a previous run are discarded. The `git diff --stat` of discarded changes is recorded in the run record.
- **Supported protocols:** https, http, ssh, git, file, and SCP-style (`git@host:org/repo.git`). The `ext::` protocol is rejected for security.

**Cross-run state files:**

The agent is instructed to maintain two files in the workspace:

- **`memory.md`** — The agent's notes to itself. Read at the start of each run to recall context from previous runs (last processed item, patterns observed, recurring issues).
- **`last-run.md`** — A structured summary of each run: date/time, actions taken with counts, issues encountered, recommendations for next run. The first 2000 characters are captured in the run record.

## Escalation Handling

How tool call escalations are handled depends on whether Signal is configured:

**Without Signal (or `--no-signal`):**
- All escalations are **auto-denied**. The agent is instructed not to retry denied operations and to note them in its summary.

**With Signal and `notifyOnEscalation: true`:**
- The daemon sends a Signal message describing the escalation and waits for the user to reply with "approve" or "deny".
- Escalation routing is unified — `approve #N` from Signal works for both Signal-initiated and cron-initiated sessions.
- If no response arrives before the escalation times out, the request is auto-denied.

**With Signal and `notifyOnEscalation: false`:**
- Escalations are auto-denied (same as no Signal).

Completion notifications (`notifyOnCompletion: true`) send a Signal message with the run summary, outcome, duration, and cost.

## Resource Budgets

Cron jobs use tighter default budgets than interactive sessions to prevent runaway costs:

| Limit | Cron Default | Interactive Default |
|-------|-------------|-------------------|
| Max tokens | 500,000 | 1,000,000 |
| Max steps | 100 | 200 |
| Session timeout | 1 hour | 30 minutes |
| Cost cap | $2.00 | $5.00 |

Override per-job via the `budgetOverrides` field in the job definition. Set any field to `null` to disable that limit.

```json
{
  "budgetOverrides": {
    "maxTotalTokens": 1000000,
    "maxSteps": null,
    "maxSessionSeconds": 7200,
    "maxEstimatedCostUsd": 5.0
  }
}
```

When a budget is exhausted, the run ends with outcome `budget_exhausted` and the exceeded dimension is recorded.

## File Layout

```
~/.ironcurtain/
├── daemon.sock                    # Unix domain socket for CLI ↔ daemon communication
├── jobs/
│   └── {jobId}/
│       ├── job.json               # Job definition
│       ├── generated/             # Compiled per-job policy artifacts
│       │   ├── compiled-policy.json
│       │   ├── tool-annotations.json (symlink or copy)
│       │   └── ...
│       ├── workspace/             # Persistent workspace (or custom path)
│       │   ├── memory.md          # Agent's cross-run notes (created by agent)
│       │   ├── last-run.md        # Agent's run summary (created by agent)
│       │   └── ...                # Cloned repo or working files
│       └── runs/
│           └── {timestamp}.json   # Run records (one per completed run)
├── logs/
│   └── *.log                      # Daemon process logs
└── sessions/
    └── {sessionId}/               # Per-run session data (audit, escalations, logs)
```

## Troubleshooting

| Issue | Guidance |
|-------|----------|
| **Job not running on schedule** | Check that the job is enabled (`list-jobs`). Verify the cron expression is correct. The daemon must be running — jobs don't run without it. |
| **Policy compilation fails** | Run `ironcurtain daemon recompile-job <id>` to see errors. Ensure the `taskConstitution` is well-formed English. Check that global tool annotations exist (`~/.ironcurtain/generated/tool-annotations.json`). |
| **Git sync fails** | Verify the `gitRepo` URI uses a supported protocol (https, ssh, git). Ensure credentials (SSH keys, tokens) are available to the daemon process. Check network connectivity. |
| **Escalations always denied** | Without Signal, all escalations are auto-denied by design. Enable Signal (`ironcurtain setup-signal`) and set `notifyOnEscalation: true` on the job. |
| **Daemon won't start ("already running")** | Check if another daemon is running. The control socket at `~/.ironcurtain/daemon.sock` is auto-cleaned if the previous process is dead. |
| **Run record shows `budget_exhausted`** | The job hit a resource limit. Increase the relevant budget via `edit-job` or set the field to `null` to disable the limit. |
| **`memory.md` / `last-run.md` missing** | These files are created by the agent, not the daemon. If the agent didn't write them, check the task description — the agent is prompted to use these files but may skip them if the task completes very quickly or errors out early. |
| **Changes from previous run discarded** | This is expected behavior with `gitRepo` configured. Tracked files are reset to remote HEAD before each run. Untracked files (including `memory.md` and `last-run.md`) are preserved. |
