import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getFrozenProfileCeilingPath } from '../../src/docker/docker-workload-paths.js';
import { loadDockerDesktopP2SeccompProfile } from '../../src/docker-workload/docker-desktop-sidecar.js';
import { sha256Hex } from '../../src/hash.js';

interface ProfileCeiling {
  schemaVersion: number;
  maximumArtifactsPerCategory: number;
  absoluteStops: readonly string[];
  categories: {
    seccomp: {
      eligibleGroups: Readonly<Record<string, readonly string[]>>;
      forbidden: readonly string[];
      source: { canonicalSha256: string };
      artifact: { path: string; sha256: string };
      additions: readonly {
        syscall: string;
        arguments: string;
        group: string;
      }[];
    };
  };
}

interface SeccompRule {
  names: string[];
  action: string;
  comment?: string;
  args?: unknown;
  includes?: unknown;
  excludes?: unknown;
  errnoRet?: unknown;
}

interface SeccompProfile {
  defaultAction: string;
  syscalls: SeccompRule[];
}

describe('Docker Desktop profile ceiling', () => {
  it('limits the sidecar to its reviewed seccomp and mount-mask additions', () => {
    const loadedProfile = loadDockerDesktopP2SeccompProfile();
    const ceiling = JSON.parse(readFileSync(getFrozenProfileCeilingPath(), 'utf8')) as ProfileCeiling;
    const seccomp = ceiling.categories.seccomp;
    const artifactBytes = readFileSync(loadedProfile.path);
    const profile = JSON.parse(artifactBytes.toString('utf8')) as SeccompProfile;

    expect(ceiling.schemaVersion).toBe(1);
    expect(ceiling.maximumArtifactsPerCategory).toBe(1);
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');

    const taggedRules = profile.syscalls.filter((rule) => rule.comment?.startsWith('IronCurtain P2:'));
    const baseline = structuredClone(profile);
    baseline.syscalls = baseline.syscalls.filter((rule) => !rule.comment?.startsWith('IronCurtain P2:'));
    expect(sha256Hex(JSON.stringify(baseline))).toBe(seccomp.source.canonicalSha256);

    const declared = new Set<string>();
    for (const addition of seccomp.additions) {
      expect(declared.has(addition.syscall)).toBe(false);
      expect(addition.arguments).toBe('all');
      expect(seccomp.eligibleGroups[addition.group]).toContain(addition.syscall);
      expect(seccomp.forbidden).not.toContain(addition.syscall);
      declared.add(addition.syscall);
    }

    const emitted = new Set<string>();
    for (const rule of taggedRules) {
      expect(rule.action).toBe('SCMP_ACT_ALLOW');
      expect(rule.names).toHaveLength(1);
      expect(rule.args).toBeUndefined();
      expect(rule.includes).toBeUndefined();
      expect(rule.excludes).toBeUndefined();
      expect(rule.errnoRet).toBeUndefined();
      const syscall = rule.names[0];
      expect(declared.has(syscall)).toBe(true);
      expect(emitted.has(syscall)).toBe(false);
      emitted.add(syscall);
    }

    expect([...emitted].sort()).toEqual([...declared].sort());
    expect(emitted.has('sethostname')).toBe(true);

    expect(ceiling.absoluteStops).toContain('systempaths-unconfined-outside-reviewed-nested-daemon-sidecar');
    expect(ceiling.absoluteStops).not.toContain('systempaths-unconfined');
  });
});
