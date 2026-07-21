#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  loadQualificationContract,
  loadQualificationRun,
  loadVitestQualificationReport,
  verifyVitestQualificationRun,
} from '../../../src/docker/qualification-contract.js';

const values = parseArgs(process.argv.slice(2));
const verified = verifyVitestQualificationRun({
  contract: loadQualificationContract(resolve(values.contract)),
  run: loadQualificationRun(resolve(values.run)),
  report: loadVitestQualificationReport(resolve(values.report)),
  repositoryRoot: resolve(values['repository-root']),
});
process.stdout.write(`verified qualification command ${verified.commandId}: ${verified.testCount} tests\n`);

function parseArgs(argv: readonly string[]): Record<'contract' | 'run' | 'report' | 'repository-root', string> {
  const parsed: Partial<Record<'contract' | 'run' | 'report' | 'repository-root', string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${flag ?? '<missing>'}`);
    const name = flag.slice(2);
    if (!['contract', 'run', 'report', 'repository-root'].includes(name)) throw new Error(`unknown argument: ${flag}`);
    parsed[name as keyof typeof parsed] = value;
  }
  for (const name of ['contract', 'run', 'report', 'repository-root'] as const) {
    if (parsed[name] === undefined) throw new Error(`missing --${name}`);
  }
  return parsed as Record<'contract' | 'run' | 'report' | 'repository-root', string>;
}
