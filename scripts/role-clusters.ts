#!/usr/bin/env tsx
/**
 * role-clusters.ts
 *
 * Computes role-based connected components from tool-annotations.json.
 *
 * Algorithm (from MISSING_FEATURES.md):
 *   Build an undirected graph where tools are nodes and edges connect tools
 *   sharing at least one non-'none' ArgumentRole. Each connected component
 *   is an independent policy domain that can be compiled in its own LLM call.
 *
 * Usage:
 *   npx tsx scripts/role-clusters.ts [path/to/tool-annotations.json]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types (inlined to keep the script self-contained)
// ---------------------------------------------------------------------------

interface ToolAnnotation {
  toolName: string;
  serverName: string;
  args: Record<string, string[]>;
}

interface ToolAnnotationsFile {
  servers: Record<string, { tools: ToolAnnotation[] }>;
}

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: Map<string, string> = new Map();

  private root(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.root(this.parent.get(x)!)); // path compression
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  clusters(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const r = this.root(node);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(node);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const annotationsPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(fileURLToPath(import.meta.url), '../../src/config/generated/tool-annotations.json');

const file: ToolAnnotationsFile = JSON.parse(readFileSync(annotationsPath, 'utf8'));

// Flatten all tools and collect non-'none' roles per tool key (server__tool)
const toolRoles = new Map<string, Set<string>>();

for (const [serverName, { tools }] of Object.entries(file.servers)) {
  for (const tool of tools) {
    const key = `${serverName}__${tool.toolName}`;
    const roles = new Set<string>();
    for (const argRoles of Object.values(tool.args)) {
      for (const role of argRoles) {
        if (role !== 'none') roles.add(role);
      }
    }
    toolRoles.set(key, roles);
  }
}

// Build role → tools index
const roleToTools = new Map<string, string[]>();
for (const [toolKey, roles] of toolRoles) {
  for (const role of roles) {
    if (!roleToTools.has(role)) roleToTools.set(role, []);
    roleToTools.get(role)!.push(toolKey);
  }
}

// Union tools that share a role
const uf = new UnionFind();
// Register all tools (including those with only 'none' roles, which stay isolated)
for (const key of toolRoles.keys()) uf['parent'].set(key, key);

for (const tools of roleToTools.values()) {
  for (let i = 1; i < tools.length; i++) {
    uf.union(tools[0], tools[i]);
  }
}

// Gather clusters and annotate with the roles that bridge them
const clusters = uf.clusters();

// For each cluster, compute the union of roles across member tools
type ClusterInfo = {
  tools: string[];
  roles: string[];
  pureNoneTools: string[]; // tools with no non-none roles
};

const clusterInfos: ClusterInfo[] = [];
for (const members of clusters.values()) {
  const allRoles = new Set<string>();
  const pureNone: string[] = [];
  const active: string[] = [];

  for (const tool of members) {
    const roles = toolRoles.get(tool) ?? new Set();
    if (roles.size === 0) {
      pureNone.push(tool);
    } else {
      active.push(tool);
      for (const r of roles) allRoles.add(r);
    }
  }

  clusterInfos.push({
    tools: members.sort(),
    roles: [...allRoles].sort(),
    pureNoneTools: pureNone.sort(),
  });
}

// Sort: largest cluster first, then alphabetically by first tool
clusterInfos.sort((a, b) => b.tools.length - a.tools.length || a.tools[0].localeCompare(b.tools[0]));

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log(`\nRole-clustered policy domains (${clusterInfos.length} clusters from ${toolRoles.size} tools)\n`);
console.log('='.repeat(70));

for (let i = 0; i < clusterInfos.length; i++) {
  const { tools, roles, pureNoneTools } = clusterInfos[i];
  const label = roles.length > 0 ? roles.join(', ') : '(no resource roles — compile-time safe)';
  console.log(`\nCluster ${i + 1}  [${label}]`);
  console.log('-'.repeat(70));
  for (const tool of tools) {
    const toolRoleSet = toolRoles.get(tool) ?? new Set();
    const roleStr = toolRoleSet.size > 0 ? `  → ${[...toolRoleSet].sort().join(', ')}` : '  → none';
    console.log(`  ${tool}${roleStr}`);
  }
  if (pureNoneTools.length > 0) {
    console.log(`  (+ ${pureNoneTools.length} tools with only 'none' roles merged into this cluster)`);
  }
}

// Summary table: roles → cluster index
console.log('\n' + '='.repeat(70));
console.log('\nRole → Cluster index\n');
const sortedRoles = [...roleToTools.keys()].sort();
for (const role of sortedRoles) {
  const tools = roleToTools.get(role)!;
  // Find which cluster this role's tools ended up in
  const clusterIdx = clusterInfos.findIndex((c) => c.tools.includes(tools[0]));
  console.log(`  ${role.padEnd(20)} ${tools.length} tool(s)  →  cluster ${clusterIdx + 1}`);
}

console.log('');
