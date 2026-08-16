import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { formatHelp, type CommandSpec } from '../cli-help.js';
import { getLlmStatisticsDatabasePath } from '../config/paths.js';
import type { LlmDeleteBeforeOptions, LlmDeleteBeforeResult, LlmMetricsRepository } from './persistence/repository.js';
import { SqliteLlmMetricsRepository } from './persistence/sqlite-repository.js';
import { BOUNDED_STATISTICS_DELETE_OPTIONS } from './persistence/delete-policy.js';

const MAX_DELETE_PASSES = 10_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

type StatisticsManagementRepository = Pick<LlmMetricsRepository, 'deleteBefore' | 'close'>;

export interface StatisticsCommandDependencies {
  readonly databasePath?: string;
  readonly databaseExists?: (path: string) => boolean;
  readonly openRepository?: (path: string) => Promise<StatisticsManagementRepository>;
  readonly now?: () => number;
  readonly write?: (message: string) => void;
}

const STATISTICS_COMMAND_SPEC: CommandSpec = {
  name: 'ironcurtain statistics',
  description: 'Manage locally persisted LLM statistics',
  usage: ['ironcurtain statistics delete --before <ISO-date-or-epoch-ms>', 'ironcurtain statistics delete --all'],
  options: [
    { flag: 'before', placeholder: '<time>', description: 'Delete before epoch-ms or an ISO date with timezone' },
    { flag: 'all', description: 'Delete all rows present at command start' },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
};

function usage(): string {
  return (
    `${formatHelp(STATISTICS_COMMAND_SPEC)}\n\n` +
    'Deletion is chunked and uses a start-of-command snapshot; newer rows are preserved.\n' +
    'This performs logical SQLite row deletion, not secure erasure of free pages, WAL files, snapshots, or backups.\n' +
    'The statistics identity key is not deleted or rotated by this command.\n'
  );
}

function hasValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.slice(0, 10).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseCutoff(value: string): number {
  const isEpochMilliseconds = /^\d+$/.test(value);
  const isUnambiguousIso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
    value,
  );
  let numeric = Number.NaN;
  if (isEpochMilliseconds) numeric = Number(value);
  else if (isUnambiguousIso && hasValidCalendarDate(value)) numeric = Date.parse(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > MAX_DATE_MS) {
    throw new Error(`Invalid statistics cutoff: ${value}`);
  }
  return numeric;
}

async function yieldToWriters(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function deleteSnapshot(
  repository: StatisticsManagementRepository,
  cutoffMs: number,
): Promise<{ readonly result: LlmDeleteBeforeResult; readonly deletedCount: number }> {
  let snapshotMaxSequence: number | undefined;
  let deletedCount = 0;
  let latest: LlmDeleteBeforeResult | undefined;
  for (let pass = 0; pass < MAX_DELETE_PASSES; pass++) {
    const options: LlmDeleteBeforeOptions = {
      ...BOUNDED_STATISTICS_DELETE_OPTIONS,
      ...(snapshotMaxSequence === undefined ? {} : { snapshotMaxSequence }),
    };
    latest = await repository.deleteBefore(cutoffMs, options);
    deletedCount += latest.deletedCount;
    snapshotMaxSequence ??= latest.snapshotMaxSequence ?? undefined;
    if (latest.status !== 'partial') return { result: latest, deletedCount };
    await yieldToWriters();
  }
  if (latest === undefined) throw new Error('Statistics deletion did not start');
  return { result: latest, deletedCount };
}

/** Local, explicit management surface. It is never called by normal startup. */
export async function runStatisticsCommand(
  args: readonly string[],
  dependencies: StatisticsCommandDependencies = {},
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      all: { type: 'boolean' },
      before: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  if (values.help) {
    write(usage());
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'delete') throw new Error(usage().trimEnd());
  if (values.all === true && values.before !== undefined) {
    throw new Error('Choose either --before or --all, not both');
  }
  if (values.all !== true && values.before === undefined) {
    throw new Error('statistics delete requires --before <time> or --all');
  }

  const now = dependencies.now ?? Date.now;
  const cutoffMs = values.all === true ? Math.min(MAX_DATE_MS, now() + 1) : parseCutoff(values.before as string);
  const databasePath = dependencies.databasePath ?? getLlmStatisticsDatabasePath();
  const databaseExists = dependencies.databaseExists ?? existsSync;
  if (!databaseExists(databasePath)) {
    write('No statistics database exists; nothing was deleted.\n');
    return;
  }

  const openRepository =
    dependencies.openRepository ??
    (async (path: string): Promise<StatisticsManagementRepository> =>
      SqliteLlmMetricsRepository.open({ databasePath: path }));
  const repository = await openRepository(databasePath);
  try {
    const deletion = await deleteSnapshot(repository, cutoffMs);
    const suffix = deletion.result.status === 'busy' ? ' Another process owns the maintenance lease; retry later.' : '';
    write(
      `Deleted ${deletion.deletedCount} statistics exchange(s) before ${new Date(cutoffMs).toISOString()}.` +
        `${suffix}\n`,
    );
    if (deletion.result.status === 'partial') {
      throw new Error('Statistics deletion reached its bounded pass limit before completing');
    }
  } finally {
    await repository.close();
  }
}
