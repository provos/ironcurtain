/**
 * CLI entry point for `ironcurtain persona` subcommands.
 *
 * Subcommands: create, list, compile, edit, delete, show.
 *
 * Follows the same patterns as job-commands.ts for interactive flows
 * and cli-help.ts for help formatting.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { checkHelp, printHelp, type CommandSpec } from '../cli-help.js';
import { loadConfig } from '../config/index.js';
import { openEditor, openEditorForMultiline } from '../utils/editor.js';
import { createPersonaName, type PersonaDefinition, type PersonaName } from './types.js';
import {
  getPersonaDir,
  getPersonaGeneratedDir,
  getPersonaConstitutionPath,
  getPersonaWorkspaceDir,
  getPersonaDefinitionPath,
  getPersonasDir,
  loadPersona,
} from './resolve.js';
import { compilePersonaPolicy } from './compile-persona-policy.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

const personaSpec: CommandSpec = {
  name: 'ironcurtain persona',
  description: 'Manage personas (named policy profiles)',
  usage: ['ironcurtain persona <action> [options]'],
  subcommands: [
    { name: 'create <name>', description: 'Create a new persona interactively' },
    { name: 'list', description: 'List all personas' },
    { name: 'compile <name>', description: "Compile a persona's constitution into policy" },
    { name: 'edit <name>', description: "Edit a persona's constitution" },
    { name: 'delete <name>', description: 'Delete a persona (with confirmation)' },
    { name: 'show <name>', description: 'Show persona metadata and constitution' },
  ],
  examples: [
    'ironcurtain persona create exec-assistant',
    'ironcurtain persona list',
    'ironcurtain persona compile coder',
    'ironcurtain persona edit exec-assistant',
    'ironcurtain persona show coder',
    'ironcurtain persona delete old-persona',
  ],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Loads a persona by name string, exiting with an error if not found. */
function loadPersonaOrExit(nameStr: string): PersonaDefinition {
  try {
    const name = createPersonaName(nameStr);
    return loadPersona(name);
  } catch {
    console.error(chalk.red(`Persona not found: ${nameStr}`));
    process.exit(1);
  }
}

/** Returns all persona names by reading the personas directory. */
function listPersonaNames(): PersonaName[] {
  const dir = getPersonasDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        createPersonaName(name);
        return true;
      } catch {
        return false;
      }
    })
    .map((name) => name as PersonaName);
}

// ---------------------------------------------------------------------------
// Shared helpers for create & edit flows
// ---------------------------------------------------------------------------

/**
 * Generates a constitution via LLM, then presents accept/refine/discard.
 * Returns the final constitution text, or undefined if discarded/cancelled.
 */
async function generateAndReviewConstitution(
  description: string,
  workspacePath: string,
  servers: readonly string[] | undefined,
  p: typeof import('@clack/prompts'),
): Promise<string | undefined> {
  const genSpinner = p.spinner();
  genSpinner.start('Generating constitution...');
  try {
    const { generateConstitution } = await import('../cron/constitution-generator.js');
    const result = await generateConstitution({
      taskDescription: description,
      workspacePath,
      context: 'persona',
      onProgress: (msg) => genSpinner.message(msg),
    });
    genSpinner.stop('Constitution generated.');
    p.note(result.constitution.trim(), 'Generated Constitution');
    if (result.reasoning) {
      p.log.info(result.reasoning);
    }

    const action = await p.select({
      message: 'What would you like to do with the generated constitution?',
      options: [
        { value: 'accept' as const, label: 'Accept as-is' },
        { value: 'refine' as const, label: 'Customize interactively' },
        { value: 'discard' as const, label: 'Discard' },
      ],
    });
    if (p.isCancel(action) || action === 'discard') return undefined;

    if (action === 'refine') {
      const { runPersonaConstitutionCustomizer } = await import('./persona-customizer.js');
      return (await runPersonaConstitutionCustomizer(result.constitution, description, servers)) ?? undefined;
    }
    return result.constitution;
  } catch (err) {
    genSpinner.stop('Generation failed.');
    p.log.error(`Constitution generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Runs policy compilation with a spinner and error handling. */
async function compileWithSpinner(name: PersonaName, p: typeof import('@clack/prompts')): Promise<boolean> {
  const compileSpinner = p.spinner();
  compileSpinner.start('Compiling policy...');
  try {
    await compilePersonaPolicy(name);
    compileSpinner.stop('Policy compiled.');
    return true;
  } catch (err) {
    compileSpinner.stop('Compilation failed.');
    p.log.error(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runCreate(nameStr: string, args: string[]): Promise<void> {
  const { values: createValues } = parseArgs({
    args,
    options: {
      description: { type: 'string' },
      servers: { type: 'string' },
      'no-generate': { type: 'boolean' },
    },
    strict: false,
  });

  const name = createPersonaName(nameStr);
  const personaDir = getPersonaDir(name);

  if (existsSync(personaDir)) {
    console.error(chalk.red(`Persona "${name}" already exists.`));
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro(`Create persona "${name}"`);

  // 1. Description
  let description: string;
  if (createValues.description) {
    description = createValues.description as string;
    p.log.info(`Description: ${description}`);
  } else {
    const descInput = await p.text({
      message: "Describe this persona's purpose",
      placeholder: 'e.g., Email triage, calendar management, and document review',
    });
    if (p.isCancel(descInput)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    description = descInput.trim();
  }

  // 2. Server allowlist
  let servers: string[] | undefined;
  if (createValues.servers) {
    servers = (createValues.servers as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    p.log.info(`Servers: ${servers.join(', ')}`);
  } else {
    const config = loadConfig();
    const serverNames = Object.keys(config.mcpServers);
    if (serverNames.length > 1) {
      const selected = await p.multiselect({
        message: 'Select MCP servers for this persona (filesystem is always included)',
        options: serverNames.map((s) => ({
          value: s,
          label: s === 'filesystem' ? `${s} (always included)` : s,
          hint: config.mcpServers[s].description,
        })),
        initialValues: serverNames,
      });
      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      // Only set servers if not all selected (undefined = all servers)
      if (selected.length < serverNames.length) {
        servers = selected;
      }
    }
  }

  // Create the persona directory structure
  mkdirSync(personaDir, { recursive: true });
  mkdirSync(getPersonaGeneratedDir(name), { recursive: true });
  const workspaceDir = getPersonaWorkspaceDir(name);
  mkdirSync(workspaceDir, { recursive: true });

  // Create empty memory file in workspace
  const memoryPath = join(workspaceDir, 'memory.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, '', 'utf-8');
  }

  // Save persona.json
  const personaDef: PersonaDefinition = {
    name,
    description,
    createdAt: new Date().toISOString(),
    ...(servers ? { servers } : {}),
  };
  writeFileSync(getPersonaDefinitionPath(name), JSON.stringify(personaDef, null, 2) + '\n', 'utf-8');

  // 3. Constitution authoring
  let constitution: string | undefined;
  const constitutionPath = getPersonaConstitutionPath(name);
  const noGenerate = createValues['no-generate'] as boolean | undefined;

  if (!noGenerate) {
    const shouldGenerate = await p.confirm({
      message: 'Generate a constitution automatically from the description?',
      initialValue: true,
    });
    if (p.isCancel(shouldGenerate)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    if (shouldGenerate) {
      constitution = await generateAndReviewConstitution(description, workspaceDir, servers, p);
      // undefined: falls through to editor below
    }
  }

  // 4. Fallback: open $EDITOR
  if (!constitution) {
    p.log.step('Opening editor for constitution...');
    const instructions =
      'Enter the persona constitution -- guiding principles for what the agent\n' +
      'is and is not permitted to do.\n' +
      'Lines starting with # are ignored.';
    constitution = openEditorForMultiline(instructions);
  }

  if (!constitution) {
    p.log.warn('No constitution provided. You can add one later with: ironcurtain persona edit ' + name);
    writeFileSync(constitutionPath, '', 'utf-8');
    p.outro(`Persona "${name}" created (no constitution -- compilation skipped).`);
    return;
  }

  // 5. Write constitution and compile
  writeFileSync(constitutionPath, constitution + '\n', 'utf-8');

  const compiled = await compileWithSpinner(name, p);
  if (!compiled) {
    p.log.warn(`Persona "${name}" was created. Fix the issue then run: ironcurtain persona compile ${name}`);
    process.exit(1);
  }

  p.outro(`Persona "${name}" created and compiled.`);
}

function runList(): void {
  const names = listPersonaNames();

  if (names.length === 0) {
    console.error('No personas configured. Use "ironcurtain persona create <name>" to create one.');
    return;
  }

  for (const name of names) {
    let description: string;
    let status = 'not compiled';

    try {
      const persona = loadPersona(name);
      description = persona.description;
    } catch {
      description = '(error reading persona.json)';
    }

    const compiledPath = join(getPersonaGeneratedDir(name), 'compiled-policy.json');
    if (existsSync(compiledPath)) {
      status = 'compiled';
    }

    const statusColor = status === 'compiled' ? chalk.green(status) : chalk.yellow(status);
    console.error(`  ${chalk.bold(name.padEnd(24))} ${description.slice(0, 50).padEnd(52)} ${statusColor}`);
  }
}

async function runCompile(nameStr: string): Promise<void> {
  const name = createPersonaName(nameStr);
  const constitutionPath = getPersonaConstitutionPath(name);

  if (!existsSync(constitutionPath)) {
    console.error(chalk.red(`Persona "${name}" not found or has no constitution.md.`));
    process.exit(1);
  }

  const constitution = readFileSync(constitutionPath, 'utf-8').trim();
  if (!constitution) {
    console.error(chalk.red(`Persona "${name}" has an empty constitution. Edit it first.`));
    process.exit(1);
  }

  console.error(`Compiling policy for persona "${name}"...`);
  try {
    await compilePersonaPolicy(name);
    console.error(chalk.green('Done.'));
  } catch (err) {
    console.error(chalk.red(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

async function runEdit(nameStr: string): Promise<void> {
  const name = createPersonaName(nameStr);
  const constitutionPath = getPersonaConstitutionPath(name);

  if (!existsSync(getPersonaDir(name))) {
    console.error(chalk.red(`Persona "${name}" not found.`));
    process.exit(1);
  }

  // Ensure constitution file exists
  if (!existsSync(constitutionPath)) {
    writeFileSync(constitutionPath, '', 'utf-8');
  }

  const persona = loadPersona(name);
  const p = await import('@clack/prompts');
  p.intro(`Edit persona "${name}"`);

  const editAction = await p.select({
    message: 'How would you like to edit the constitution?',
    options: [
      { value: 'customize' as const, label: 'Customize interactively (LLM-assisted)' },
      { value: 'editor' as const, label: 'Edit in $EDITOR' },
      { value: 'generate' as const, label: 'Generate new constitution from description' },
    ],
  });

  if (p.isCancel(editAction)) {
    p.cancel('Cancelled.');
    return;
  }

  let constitutionChanged: boolean;

  if (editAction === 'customize') {
    constitutionChanged = await editViaCustomizer(persona, constitutionPath);
  } else if (editAction === 'editor') {
    constitutionChanged = editViaEditor(constitutionPath);
  } else {
    constitutionChanged = await editViaGeneration(persona, constitutionPath, p);
  }

  if (!constitutionChanged) {
    p.outro('No changes made.');
    return;
  }

  await offerCompilation(name, p);
}

/** Runs the LLM-assisted interactive customizer on the current constitution. */
async function editViaCustomizer(persona: PersonaDefinition, constitutionPath: string): Promise<boolean> {
  const currentConstitution = readFileSync(constitutionPath, 'utf-8');
  const { runPersonaConstitutionCustomizer } = await import('./persona-customizer.js');
  const refined = await runPersonaConstitutionCustomizer(currentConstitution, persona.description, persona.servers);
  if (refined) {
    writeFileSync(constitutionPath, refined + '\n', 'utf-8');
    return true;
  }
  return false;
}

/** Opens $EDITOR on the constitution file and returns whether it changed. */
function editViaEditor(constitutionPath: string): boolean {
  console.error('Opening constitution in editor...');
  return openEditor(constitutionPath);
}

/** Generates a fresh constitution from the persona description. */
async function editViaGeneration(
  persona: PersonaDefinition,
  constitutionPath: string,
  p: typeof import('@clack/prompts'),
): Promise<boolean> {
  const constitution = await generateAndReviewConstitution(
    persona.description,
    getPersonaWorkspaceDir(persona.name),
    persona.servers,
    p,
  );
  if (!constitution) return false;
  writeFileSync(constitutionPath, constitution + '\n', 'utf-8');
  return true;
}

/** Offers to compile the persona policy after a constitution change. */
async function offerCompilation(name: PersonaName, p: typeof import('@clack/prompts')): Promise<void> {
  const shouldCompile = await p.confirm({
    message: 'Compile policy now?',
    initialValue: true,
  });

  if (p.isCancel(shouldCompile) || !shouldCompile) {
    p.outro(`Constitution updated. Run "ironcurtain persona compile ${name}" when ready.`);
    return;
  }

  const compiled = await compileWithSpinner(name, p);
  if (compiled) {
    p.outro(`Persona "${name}" updated and compiled.`);
  } else {
    p.outro(`Constitution saved. Fix the issue then run: ironcurtain persona compile ${name}`);
  }
}

async function runDelete(nameStr: string): Promise<void> {
  const name = createPersonaName(nameStr);
  const personaDir = getPersonaDir(name);

  if (!existsSync(personaDir)) {
    console.error(chalk.red(`Persona "${name}" not found.`));
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  const confirmed = await p.confirm({
    message: `Delete persona "${name}" and all its data?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    console.error('Cancelled.');
    return;
  }

  rmSync(personaDir, { recursive: true, force: true });
  console.error(chalk.green(`Persona "${name}" deleted.`));
}

function runShow(nameStr: string): void {
  const persona = loadPersonaOrExit(nameStr);
  const name = persona.name;

  console.error(chalk.bold(`Persona: ${name}`));
  console.error(`Description: ${persona.description}`);
  console.error(`Created: ${persona.createdAt}`);
  if (persona.servers) {
    console.error(`Servers: ${persona.servers.join(', ')}`);
  } else {
    console.error('Servers: all (no filter)');
  }

  const compiledPath = join(getPersonaGeneratedDir(name), 'compiled-policy.json');
  const compiled = existsSync(compiledPath);
  console.error(`Policy: ${compiled ? chalk.green('compiled') : chalk.yellow('not compiled')}`);

  const constitutionPath = getPersonaConstitutionPath(name);
  if (existsSync(constitutionPath)) {
    const constitution = readFileSync(constitutionPath, 'utf-8').trim();
    if (constitution) {
      console.error('');
      console.error(chalk.bold('Constitution:'));
      console.error(constitution);
    } else {
      console.error('\nConstitution: (empty)');
    }
  } else {
    console.error('\nConstitution: (not created)');
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  const action = positionals[0];

  if (!action || action === 'help' || (values.help && !action)) {
    printHelp(personaSpec);
    return;
  }

  if (checkHelp(values as { help?: boolean }, personaSpec)) return;

  switch (action) {
    case 'create': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona create <name>'));
        process.exit(1);
      }
      await runCreate(name, args.slice(2));
      break;
    }
    case 'list': {
      runList();
      break;
    }
    case 'compile': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona compile <name>'));
        process.exit(1);
      }
      await runCompile(name);
      break;
    }
    case 'edit': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona edit <name>'));
        process.exit(1);
      }
      await runEdit(name);
      break;
    }
    case 'delete': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona delete <name>'));
        process.exit(1);
      }
      await runDelete(name);
      break;
    }
    case 'show': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona show <name>'));
        process.exit(1);
      }
      runShow(name);
      break;
    }
    default: {
      console.error(chalk.red(`Unknown persona action: ${action}`));
      printHelp(personaSpec);
      process.exit(1);
    }
  }
}
