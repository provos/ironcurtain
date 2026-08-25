//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRunLoadsImmutableContractBeforeExactHandoff(t *testing.T) {
	fixture := newSecureFixture(t)
	sentinel := errors.New("exec sentinel")
	var gotPath string
	err := run([]string{"--version"}, []string{"MARKER=exact"}, fixture.policy, func(path string, argv, env []string) error {
		gotPath = path
		if len(argv) != 2 || argv[0] != fixture.policy.realRuncPath || argv[1] != "--version" {
			t.Fatalf("handoff argv = %#v", argv)
		}
		if len(env) != 1 || env[0] != "MARKER=exact" {
			t.Fatalf("handoff env = %#v", env)
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || gotPath != fixture.policy.realRuncPath {
		t.Fatalf("handoff result = path %q, error %v", gotPath, err)
	}
}

func TestPatchBundleSecureUsesNoFollowTraversalAndAtomicReplace(t *testing.T) {
	fixture := newSecureFixture(t)
	wantExecutorOwners := [2]ownerPair{
		{UID: os.Geteuid(), GID: os.Getegid()},
		{UID: 0, GID: 0},
	}
	if fixture.policy.executorTreeOwnerPairs != wantExecutorOwners {
		t.Fatalf("fixture executor owner pairs = %#v, want %#v", fixture.policy.executorTreeOwnerPairs, wantExecutorOwners)
	}
	before, err := os.Stat(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if before.Mode() != after.Mode() || before.Sys().(*syscall.Stat_t).Uid != after.Sys().(*syscall.Stat_t).Uid || before.Sys().(*syscall.Stat_t).Gid != after.Sys().(*syscall.Stat_t).Gid {
		t.Fatal("atomic replacement did not preserve config metadata")
	}
	contents, err := os.ReadFile(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, assignment := range injectedEnvironment {
		if !bytes.Contains(contents, []byte(assignment)) {
			t.Fatalf("patched config lacks %s", assignment)
		}
	}
	entries, err := os.ReadDir(fixture.bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".config.json.ironcurtain-") {
			t.Fatalf("temporary file remains: %s", entry.Name())
		}
	}
	if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err != nil {
		t.Fatalf("idempotent secure patch failed: %v", err)
	}
}

func TestPatchBundleSecureKeepsBundleIdentityAndPathExact(t *testing.T) {
	t.Run("overflow-owned bundle", func(t *testing.T) {
		stat := syscall.Stat_t{Mode: syscall.S_IFDIR | 0o711, Uid: 65534, Gid: 65534}
		if err := validateExactDirectoryStat(stat, 0, 0, 0o711); err == nil {
			t.Fatal("overflow-owned bundle was accepted")
		}
	})

	t.Run("wrong bundle mode", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Chmod(fixture.bundlePath, os.FileMode(fixture.policy.bundleMode^0o011)); err != nil {
			t.Fatal(err)
		}
		requireDiagnosticCode(
			t,
			patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract),
			diagnosticBundleMetadata,
		)
	})

	t.Run("symlinked bundle", func(t *testing.T) {
		fixture := newSecureFixture(t)
		target := fixture.bundlePath + "-target"
		mustRename(t, fixture.bundlePath, target)
		if err := os.Symlink(target, fixture.bundlePath); err != nil {
			t.Fatal(err)
		}
		requireDiagnosticCode(
			t,
			patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract),
			diagnosticBundleOpen,
		)
	})

	t.Run("non-direct bundle", func(t *testing.T) {
		fixture := newSecureFixture(t)
		nested := filepath.Join(fixture.policy.buildkitExecutorRoot, "nested", filepath.Base(fixture.bundlePath))
		requireDiagnosticCode(t, patchBundleSecure(nested, fixture.policy, fixture.contract), diagnosticBundleOpen)
	})
}

func TestPatchBundleSecureRejectsUnsafeConfigObjects(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		fixture := newSecureFixture(t)
		target := fixture.configPath + ".target"
		mustRename(t, fixture.configPath, target)
		if err := os.Symlink(target, fixture.configPath); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("symlink config was accepted")
		}
	})

	t.Run("symlinked rootfs", func(t *testing.T) {
		fixture := newSecureFixture(t)
		rootfs := filepath.Join(fixture.bundlePath, "rootfs")
		target := rootfs + ".target"
		mustRename(t, rootfs, target)
		if err := os.Symlink(target, rootfs); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("symlinked rootfs was accepted")
		}
	})

	t.Run("wrong rootfs mode", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Chmod(filepath.Join(fixture.bundlePath, "rootfs"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("rootfs with unqualified mode was accepted")
		}
	})

	t.Run("hardlink", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Link(fixture.configPath, fixture.configPath+".link"); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("multiply linked config was accepted")
		}
	})

	t.Run("writable by group", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Chmod(fixture.configPath, 0o660); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("group-writable config was accepted")
		}
	})
}

func TestPatchBundleSecureReportsExecutorBundleAndConfigStages(t *testing.T) {
	tests := []struct {
		name  string
		want  failureDiagnosticCode
		setup func(*testing.T, *secureFixture)
	}{
		{
			name: "executor open",
			want: diagnosticExecutorOpen,
			setup: func(_ *testing.T, fixture *secureFixture) {
				fixture.policy.buildkitExecutorRoot += "-missing"
			},
		},
		{
			name: "executor metadata",
			want: diagnosticExecutorMetadata,
			setup: func(t *testing.T, fixture *secureFixture) {
				if err := os.Chmod(fixture.policy.buildkitExecutorRoot, 0o722); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "bundle open",
			want: diagnosticBundleOpen,
			setup: func(t *testing.T, fixture *secureFixture) {
				mustRename(t, fixture.bundlePath, fixture.bundlePath+"-missing")
			},
		},
		{
			name: "bundle metadata",
			want: diagnosticBundleMetadata,
			setup: func(t *testing.T, fixture *secureFixture) {
				if err := os.Chmod(fixture.bundlePath, 0o755); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "config open",
			want: diagnosticConfigOpen,
			setup: func(t *testing.T, fixture *secureFixture) {
				mustRename(t, fixture.configPath, fixture.configPath+"-missing")
			},
		},
		{
			name: "config metadata",
			want: diagnosticConfigMetadata,
			setup: func(t *testing.T, fixture *secureFixture) {
				if err := os.Chmod(fixture.configPath, 0o660); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "config strict envelope",
			want: diagnosticConfigStrictEnvelope,
			setup: func(t *testing.T, fixture *secureFixture) {
				if err := os.WriteFile(fixture.configPath, []byte("{\n"), os.FileMode(fixture.policy.configMode)); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "config patch",
			want: diagnosticConfigPatch,
			setup: func(t *testing.T, fixture *secureFixture) {
				contents, err := os.ReadFile(fixture.configPath)
				if err != nil {
					t.Fatal(err)
				}
				var config map[string]any
				if err := json.Unmarshal(contents, &config); err != nil {
					t.Fatal(err)
				}
				process := config["process"].(map[string]any)
				process["env"] = append(process["env"].([]any), "NODE_EXTRA_CA_CERTS=/unqualified")
				contents, err = json.Marshal(config)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(fixture.configPath, contents, os.FileMode(fixture.policy.configMode)); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newSecureFixture(t)
			test.setup(t, &fixture)
			requireDiagnosticCode(t, patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract), test.want)
		})
	}
}

func TestPatchBundleSecureReportsEveryPublicSourceStage(t *testing.T) {
	sources := []struct {
		name     string
		index    int
		open     failureDiagnosticCode
		metadata failureDiagnosticCode
		readOnly failureDiagnosticCode
		digest   failureDiagnosticCode
	}{
		{"CA certificate", 0, diagnosticSourceCACertOpen, diagnosticSourceCACertMetadata, diagnosticSourceCACertReadOnly, diagnosticSourceCACertDigest},
		{"CA bundle", 1, diagnosticSourceCABundleOpen, diagnosticSourceCABundleMeta, diagnosticSourceCABundleRO, diagnosticSourceCABundleDigest},
		{"APT config", 2, diagnosticSourceAPTConfigOpen, diagnosticSourceAPTConfigMeta, diagnosticSourceAPTConfigRO, diagnosticSourceAPTConfigDigest},
	}
	for _, source := range sources {
		for _, stage := range []struct {
			name  string
			want  failureDiagnosticCode
			setup func(*testing.T, *secureFixture, string)
		}{
			{
				name: "open",
				want: source.open,
				setup: func(t *testing.T, _ *secureFixture, path string) {
					mustRename(t, path, path+"-missing")
				},
			},
			{
				name: "metadata",
				want: source.metadata,
				setup: func(t *testing.T, _ *secureFixture, path string) {
					if err := os.Chmod(path, 0o644); err != nil {
						t.Fatal(err)
					}
				},
			},
			{
				name: "read-only",
				want: source.readOnly,
				setup: func(_ *testing.T, fixture *secureFixture, path string) {
					fixture.policy.effectiveReadOnly = func(_ int, observed string) error {
						if observed == path {
							return errors.New("injected writable backing")
						}
						return nil
					}
				},
			},
			{
				name: "digest",
				want: source.digest,
				setup: func(t *testing.T, _ *secureFixture, path string) {
					if err := os.Chmod(path, 0o644); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte("mutated\n"), 0o644); err != nil {
						t.Fatal(err)
					}
					if err := os.Chmod(path, 0o444); err != nil {
						t.Fatal(err)
					}
				},
			},
		} {
			t.Run(source.name+" "+stage.name, func(t *testing.T) {
				fixture := newSecureFixture(t)
				path := fixture.policy.sources[source.index].Source
				stage.setup(t, &fixture, path)
				requireDiagnosticCode(t, patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract), stage.want)
			})
		}
	}
}

func TestRunPreservesNestedBuildkitStageCode(t *testing.T) {
	fixture := newSecureFixture(t)
	sourcePath := fixture.policy.sources[1].Source
	if err := os.Chmod(sourcePath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, []byte("mutated\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sourcePath, 0o444); err != nil {
		t.Fatal(err)
	}
	id := filepath.Base(fixture.bundlePath)
	argv := []string{
		"--log", fixture.policy.buildkitLogPath,
		"--log-format", "json",
		"run", "--bundle", fixture.bundlePath,
		"--keep", id,
	}
	err := run(argv, nil, fixture.policy, func(_ string, _ []string, _ []string) error {
		return errors.New("unexpected runc handoff")
	})
	requireDiagnosticCode(t, err, diagnosticSourceCABundleDigest)
}

func TestConfigReadStageIsTyped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = readConfigFile(file)
	requireDiagnosticCode(t, err, diagnosticConfigRead)
}

func TestPatchBundleSecureRejectsSymlinkedExecutorAndTrustSources(t *testing.T) {
	t.Run("executor", func(t *testing.T) {
		fixture := newSecureFixture(t)
		alias := filepath.Join(filepath.Dir(fixture.policy.buildkitExecutorRoot), "executor-link")
		if err := os.Symlink(fixture.policy.buildkitExecutorRoot, alias); err != nil {
			t.Fatal(err)
		}
		fixture.policy.buildkitExecutorRoot = alias
		fixture.bundlePath = filepath.Join(alias, filepath.Base(fixture.bundlePath))
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("symlinked executor root was accepted")
		}
	})

	t.Run("source", func(t *testing.T) {
		fixture := newSecureFixture(t)
		source := fixture.policy.sources[0].Source
		target := source + ".target"
		mustRename(t, source, target)
		if err := os.Symlink(target, source); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("symlinked trust source was accepted")
		}
	})

	t.Run("hard-linked source", func(t *testing.T) {
		fixture := newSecureFixture(t)
		source := fixture.policy.sources[0].Source
		if err := os.Link(source, source+".link"); err != nil {
			t.Fatal(err)
		}
		if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
			t.Fatal("hard-linked trust source was accepted")
		}
	})
}

func TestLoadTrustContractSecureRejectsMutableOrLinkedContract(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		fixture := newSecureFixture(t)
		contract, err := loadTrustContractSecure(fixture.policy)
		if err != nil {
			t.Fatal(err)
		}
		if contract.RealRunc != fixture.contract.RealRunc {
			t.Fatal("loaded contract differs from parsed fixture")
		}
	})

	t.Run("writable", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Chmod(fixture.policy.trustContractPath, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadTrustContractSecure(fixture.policy); err == nil {
			t.Fatal("owner-writable trust contract was accepted")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		fixture := newSecureFixture(t)
		target := fixture.policy.trustContractPath + ".target"
		mustRename(t, fixture.policy.trustContractPath, target)
		if err := os.Symlink(target, fixture.policy.trustContractPath); err != nil {
			t.Fatal(err)
		}
		if _, err := loadTrustContractSecure(fixture.policy); err == nil {
			t.Fatal("symlinked trust contract was accepted")
		}
	})

	t.Run("hardlink", func(t *testing.T) {
		fixture := newSecureFixture(t)
		if err := os.Link(fixture.policy.trustContractPath, fixture.policy.trustContractPath+".link"); err != nil {
			t.Fatal(err)
		}
		if _, err := loadTrustContractSecure(fixture.policy); err == nil {
			t.Fatal("hard-linked trust contract was accepted")
		} else if message := err.Error(); !strings.Contains(message, "observed type=0100000") ||
			!strings.Contains(message, "uid=") || !strings.Contains(message, "gid=") ||
			!strings.Contains(message, "nlink=2") || len(message) > 256 {
			t.Fatalf("contract metadata diagnostic is missing or unbounded: %q", message)
		}
	})

	t.Run("missing read-only authority", func(t *testing.T) {
		fixture := newSecureFixture(t)
		fixture.policy.effectiveReadOnly = nil
		if _, err := loadTrustContractSecure(fixture.policy); err == nil || !strings.Contains(err.Error(), "validator is unavailable") {
			t.Fatalf("missing effective read-only authority result = %v", err)
		}
	})
}

func TestEffectiveReadOnlyAuthorityRejectsWritableBacking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "contract.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := validateEffectiveReadOnlyFile(fd, path); err == nil || !strings.Contains(err.Error(), "writable") {
		t.Fatalf("writable backing result = %v", err)
	}
}

func TestEffectiveReadOnlyAuthorityAcceptsQualifiedMount(t *testing.T) {
	path := os.Getenv("IRONCURTAIN_READONLY_TEST_FILE")
	if path == "" {
		t.Skip("requires a caller-provided read-only mount")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := validateEffectiveReadOnlyFile(fd, path); err != nil {
		t.Fatalf("qualified read-only mount rejected: %v", err)
	}
}

func TestFailureDiagnosticSecureLifecycle(t *testing.T) {
	if err := clearFailureDiagnosticSecure(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clearFailureDiagnosticSecure() })
	if err := writeFailureDiagnosticSecure(diagnosticConfigPatch); err != nil {
		t.Fatal(err)
	}
	stat, err := os.Lstat(failureDiagnosticPath)
	if err != nil {
		t.Fatal(err)
	}
	if !stat.Mode().IsRegular() || stat.Mode().Perm() != 0o600 || stat.Mode()&os.ModeSymlink != 0 || stat.Sys().(*syscall.Stat_t).Nlink != 1 {
		t.Fatalf("diagnostic metadata = %#v", stat)
	}
	if err := writeFailureDiagnosticSecure(diagnosticContractLoad); !errors.Is(err, syscall.EEXIST) {
		t.Fatalf("existing diagnostic was replaced: %v", err)
	}
	code, err := readFailureDiagnosticSecure()
	if err != nil || code != string(diagnosticConfigPatch) {
		t.Fatalf("diagnostic read = %q, %v", code, err)
	}
	if err := clearFailureDiagnosticSecure(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(failureDiagnosticPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("diagnostic remained after clear: %v", err)
	}
	if handled, exitCode, output := dispatchFailureDiagnosticCommand([]string{failureDiagnosticReadCommand}); !handled || exitCode != 0 || output != failureDiagnosticUnavailable {
		t.Fatalf("absent diagnostic read = handled:%t exit:%d output:%q", handled, exitCode, output)
	}
}

func TestFailureDiagnosticNeverFollowsPreexistingLeaf(t *testing.T) {
	if err := clearFailureDiagnosticSecure(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clearFailureDiagnosticSecure() })
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, failureDiagnosticPath); err != nil {
		t.Fatal(err)
	}
	if err := writeFailureDiagnosticSecure(diagnosticConfigPatch); err == nil {
		t.Fatal("preexisting diagnostic symlink was followed or replaced")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "unchanged" {
		t.Fatalf("symlink target changed: %q, %v", contents, err)
	}
	if handled, exitCode, output := dispatchFailureDiagnosticCommand([]string{failureDiagnosticReadCommand}); !handled || exitCode != 0 || output != failureDiagnosticUnavailable {
		t.Fatalf("symlink diagnostic read = handled:%t exit:%d output:%q", handled, exitCode, output)
	}
}

func TestPatchBundleSecureRequiresReadOnlyPublicTrustSources(t *testing.T) {
	fixture := newSecureFixture(t)
	target := fixture.policy.sources[1].Source
	fixture.policy.effectiveReadOnly = func(_ int, path string) error {
		if path == target {
			return errors.New("writable source sentinel")
		}
		return nil
	}
	if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil ||
		!strings.Contains(err.Error(), "writable source sentinel") {
		t.Fatalf("public trust source read-only authority result = %v", err)
	}
}

func TestPublicTrustSourceOwnerIsDiagnosticOnly(t *testing.T) {
	fixture := newSecureFixture(t)
	source := fixture.contract.PublicSources[0]
	stat := syscall.Stat_t{
		Mode:  syscall.S_IFREG | source.Mode,
		Uid:   12345,
		Gid:   54321,
		Nlink: 1,
		Size:  source.Size,
	}
	if err := validateExactOwnerlessRegularStat(stat, source.integrityRecord, source.MaxBytes); err != nil {
		t.Fatalf("public source owner was used as authority: %v", err)
	}
	stat.Nlink = 2
	if err := validateExactOwnerlessRegularStat(stat, source.integrityRecord, source.MaxBytes); err == nil {
		t.Fatal("public source with multiple links was accepted")
	}
}

func TestPatchBundleSecureRejectsSameSizeSourceDigestMismatch(t *testing.T) {
	fixture := newSecureFixture(t)
	sourcePath := fixture.policy.sources[0].Source
	if err := os.Chmod(sourcePath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, []byte("mutated\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sourcePath, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := patchBundleSecure(fixture.bundlePath, fixture.policy, fixture.contract); err == nil {
		t.Fatal("same-size source digest mismatch was accepted")
	}
}

func TestReplaceConfigAtDetectsMutationBeforeAtomicRename(t *testing.T) {
	// This covers the bounded check-before-rename guarantee only. The bundle
	// remains same-UID agent state after validation and is not claimed sealed.
	fixture := newSecureFixture(t)
	bundle, err := syscall.Open(fixture.bundlePath, directoryFlags, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(bundle)
	config, err := syscall.Openat(bundle, "config.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	var original syscall.Stat_t
	if err := syscall.Fstat(config, &original); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Close(config); err != nil {
		t.Fatal(err)
	}
	originalContents, err := os.ReadFile(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	err = commitPatchedConfigAt(bundle, &original, originalContents, []byte("replacement\n"), func() error {
		return os.WriteFile(fixture.configPath, bytes.Repeat([]byte("x"), len(originalContents)), 0o640)
	})
	if err == nil || !strings.Contains(err.Error(), "changed during validation") {
		t.Fatalf("concurrent replacement error = %v", err)
	}
	requireDiagnosticCode(t, err, diagnosticConfigAtomicCommit)
	entries, err := os.ReadDir(fixture.bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".config.json.ironcurtain-") {
			t.Fatalf("temporary file remains after race: %s", entry.Name())
		}
	}
}

func TestValidateRealRuncRejectsSymlinksAndWritableBinary(t *testing.T) {
	fixture := newSecureFixture(t)
	if err := validateRealRunc(fixture.policy, fixture.contract); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fixture.policy.realRuncPath, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := validateRealRunc(fixture.policy, fixture.contract); err == nil {
		t.Fatal("group-writable runc was accepted")
	}
	if err := os.Chmod(fixture.policy.realRuncPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.policy.realRuncPath, []byte("xxxx-fixture\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := validateRealRunc(fixture.policy, fixture.contract); err == nil {
		t.Fatal("same-size runc digest mismatch was accepted")
	}
	if err := os.WriteFile(fixture.policy.realRuncPath, []byte("runc-fixture\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := fixture.policy.realRuncPath + ".target"
	mustRename(t, fixture.policy.realRuncPath, target)
	if err := os.Symlink(target, fixture.policy.realRuncPath); err != nil {
		t.Fatal(err)
	}
	if err := validateRealRunc(fixture.policy, fixture.contract); err == nil {
		t.Fatal("symlinked runc was accepted")
	}
}

func TestRealRuncAcceptsOnlyQualifiedNamespaceOwnerViews(t *testing.T) {
	expected := integrityRecord{
		UID:               0,
		GID:               0,
		AlternateOwner:    ownerPair{UID: 65534, GID: 65534},
		HasAlternateOwner: true,
	}
	tests := []struct {
		name string
		uid  uint32
		gid  uint32
		want bool
	}{
		{name: "rootless child overflow owner", uid: 65534, gid: 65534, want: true},
		{name: "root-owned outer view", uid: 0, gid: 0, want: true},
		{name: "runtime user", uid: 1000, gid: 1000, want: false},
		{name: "mixed root and overflow", uid: 0, gid: 65534, want: false},
		{name: "mixed overflow and root", uid: 65534, gid: 0, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stat := syscall.Stat_t{Uid: test.uid, Gid: test.gid}
			if got := matchesIntegrityOwner(stat, expected); got != test.want {
				t.Fatalf("matchesIntegrityOwner(%d:%d) = %t, want %t", test.uid, test.gid, got, test.want)
			}
		})
	}
}

func TestRealRuncTraversalAcceptsOnlyRootAndOverflowOwners(t *testing.T) {
	for _, test := range []struct {
		uid  int
		want bool
	}{{uid: 0, want: true}, {uid: 65534, want: true}, {uid: 1000, want: false}} {
		if got := directoryOwnerAccepted(test.uid, 0, 65534); got != test.want {
			t.Fatalf("directoryOwnerAccepted(%d) = %t, want %t", test.uid, got, test.want)
		}
	}
}

type secureFixture struct {
	policy     runtimePolicy
	contract   trustContract
	bundlePath string
	configPath string
}

func newSecureFixture(t *testing.T) secureFixture {
	t.Helper()
	fixtureRoot := os.Getenv("IRONCURTAIN_WRAPPER_TEST_ROOT")
	if fixtureRoot == "" {
		fixtureRoot = "."
	}
	base, err := os.MkdirTemp(fixtureRoot, ".secure-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	absoluteBase, err := filepath.Abs(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(absoluteBase) })
	uid := os.Geteuid()
	gid := os.Getegid()
	executor := filepath.Join(absoluteBase, "executor")
	bundle := filepath.Join(executor, "aaaaaaaaaaaaaaaaaaaaaaaaa")
	rootfs := filepath.Join(bundle, "rootfs")
	trust := filepath.Join(absoluteBase, "trust")
	bin := filepath.Join(absoluteBase, "bin")
	for _, directory := range []string{executor, bundle, rootfs, trust, bin} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(bundle, "config.json")
	configContents := bytes.ReplaceAll(readConfigFixture(t), []byte(syntheticBundlePath), []byte(bundle))
	if err := os.WriteFile(config, configContents, 0o640); err != nil {
		t.Fatal(err)
	}
	sources := make([]trustSource, len(productionTrustSources))
	for index, production := range productionTrustSources {
		source := filepath.Join(trust, filepath.Base(production.Source))
		if err := os.WriteFile(source, []byte("fixture\n"), 0o444); err != nil {
			t.Fatal(err)
		}
		sources[index] = trustSource{Source: source, Destination: production.Destination, MaxBytes: production.MaxBytes}
	}
	runc := filepath.Join(bin, "runc")
	if err := os.WriteFile(runc, []byte("runc-fixture\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	contractPath := filepath.Join(trust, "build-trust-contract.json")
	contractBytes, err := os.ReadFile(testPackagePath("testdata/synthetic-build-trust-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contractObject map[string]any
	if err := json.Unmarshal(contractBytes, &contractObject); err != nil {
		t.Fatal(err)
	}
	realRunc := contractObject["realRunc"].(map[string]any)
	realRunc["path"] = runc
	realRunc["ownerPairs"] = []any{
		map[string]any{"uid": uid, "gid": gid},
		map[string]any{"uid": 0, "gid": 0},
	}
	for index, source := range sources {
		contractObject["publicSources"].([]any)[index].(map[string]any)["path"] = source.Source
	}
	contractBytes, err = json.Marshal(contractObject)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(contractPath, contractBytes, 0o444); err != nil {
		t.Fatal(err)
	}
	policy := runtimePolicy{
		realRuncPath:           runc,
		realRuncVersion:        qualifiedRuncVersion,
		realRuncOwnerPairs:     [2]ownerPair{{UID: uid, GID: gid}, {UID: 0, GID: 0}},
		trustTreeOwnerPairs:    [2]ownerPair{{UID: uid, GID: gid}, {UID: 0, GID: 0}},
		buildkitExecutorRoot:   executor,
		buildkitLogPath:        filepath.Join(executor, "runc-log.json"),
		trustContractPath:      contractPath,
		executorTreeOwnerPairs: [2]ownerPair{{UID: uid, GID: gid}, {UID: 0, GID: 0}},
		bundleUID:              uid,
		bundleGID:              gid,
		bundleMode:             0o700,
		configUID:              uid,
		configGID:              gid,
		configMode:             0o640,
		rootfsUID:              uid,
		rootfsGID:              gid,
		rootfsMode:             0o700,
		effectiveReadOnly:      func(_ int, _ string) error { return nil },
		sources:                sources,
	}
	contract, err := parseTrustContract(contractBytes, policy)
	if err != nil {
		t.Fatal(err)
	}
	return secureFixture{
		policy:     policy,
		contract:   contract,
		bundlePath: bundle,
		configPath: config,
	}
}

func mustRename(t *testing.T, oldPath, newPath string) {
	t.Helper()
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}
}

func requireDiagnosticCode(t *testing.T, err error, want failureDiagnosticCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected diagnostic stage %q, got nil", want)
	}
	if got := diagnosticCodeForError(err); got != want {
		t.Fatalf("diagnostic code = %q, want %q (error: %v)", got, want, err)
	}
}
