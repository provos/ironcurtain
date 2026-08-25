package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestQualifiedBuildkitBundleAcceptsFrozenEvidence(t *testing.T) {
	argv := readArgvFixture(t)
	bundle, err := qualifiedBuildkitBundle(argv, productionPolicy())
	if err != nil {
		t.Fatal(err)
	}
	const expected = buildkitExecutorRoot + "/aaaaaaaaaaaaaaaaaaaaaaaaa"
	if bundle != expected {
		t.Fatalf("bundle = %q, want %q", bundle, expected)
	}
}

func TestQualifiedBuildkitBundleRejectsNearMisses(t *testing.T) {
	valid := readArgvFixture(t)
	tests := map[string]func([]string) []string{
		"wrong log":       func(argv []string) []string { argv[1] = buildkitExecutorRoot + "/other.json"; return argv },
		"relative bundle": func(argv []string) []string { argv[6] = "aaaaaaaaaaaaaaaaaaaaaaaaa"; return argv },
		"parent bundle": func(argv []string) []string {
			argv[6] = buildkitExecutorRoot + "/../aaaaaaaaaaaaaaaaaaaaaaaaa"
			return argv
		},
		"different id": func(argv []string) []string { argv[8] = "bbbbbbbbbbbbbbbbbbbbbbbbb"; return argv },
		"short id":     func(argv []string) []string { argv[8] = "short"; return argv },
		"extra flag":   func(argv []string) []string { return append(argv, "--debug") },
		"equals form": func(_ []string) []string {
			return []string{"run", "--bundle=" + buildkitExecutorRoot + "/aaaaaaaaaaaaaaaaaaaaaaaaa"}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			argv := append([]string(nil), valid...)
			argv = mutate(argv)
			if _, err := qualifiedBuildkitBundle(argv, productionPolicy()); err == nil {
				t.Fatal("near-miss BuildKit invocation was accepted")
			}
		})
	}
}

func TestQualifiedBuildkitBundlePassesUnrelatedRuncCommands(t *testing.T) {
	argv := []string{"--root", "/run/docker/runtime", "create", "container-id"}
	bundle, err := qualifiedBuildkitBundle(argv, productionPolicy())
	if err != nil || bundle != "" {
		t.Fatalf("unrelated command result = %q, %v", bundle, err)
	}
}

func TestQualifiedBuildkitBundlePassesOnlyExactBuildkitDelete(t *testing.T) {
	const syntheticID = "aaaaaaaaaaaaaaaaaaaaaaaaa"
	policy := productionPolicy()
	exact := []string{"--log", buildkitLogPath, "--log-format", "json", "delete", syntheticID}
	if bundle, err := qualifiedBuildkitBundle(exact, policy); err != nil || bundle != "" {
		t.Fatalf("exact delete result = %q, %v", bundle, err)
	}
	for _, argv := range [][]string{
		{"--log", buildkitLogPath, "--log-format", "json", "delete", "short"},
		{"--log", buildkitLogPath, "--log-format", "json", "delete", "--force", syntheticID},
	} {
		if _, err := qualifiedBuildkitBundle(argv, policy); err == nil {
			t.Fatalf("unknown executor delete accepted: %#v", argv)
		}
	}
}

func TestQualifiedBuildkitBundleRejectsUnknownRunAndExecutorAliases(t *testing.T) {
	root := filepath.Join(t.TempDir(), "executor")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(filepath.Dir(root), "executor-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	policy := productionPolicy()
	policy.buildkitExecutorRoot = root
	policy.buildkitLogPath = filepath.Join(root, "runc-log.json")
	relativeAlias, err := filepath.Rel(mustGetwd(t), alias)
	if err != nil {
		t.Fatal(err)
	}
	for _, argv := range [][]string{
		{"run", "outside-bundle"},
		{"create", "--bundle", alias + "/aaaaaaaaaaaaaaaaaaaaaaaaa"},
		{"create", "--bundle", relativeAlias + "/aaaaaaaaaaaaaaaaaaaaaaaaa"},
		{"create", "--bundle=" + filepath.Join(root, "..", "executor", "aaaaaaaaaaaaaaaaaaaaaaaaa")},
	} {
		if _, err := qualifiedBuildkitBundle(argv, policy); err == nil {
			t.Fatalf("unknown run or executor alias accepted: %#v", argv)
		}
	}
}

func mustGetwd(t *testing.T) string {
	t.Helper()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return workingDirectory
}

func TestRunPreservesArgvEnvironmentAndPinnedPath(t *testing.T) {
	policy := productionPolicy()
	policy.realRuncPath = "/test/pinned/runc"
	argv := []string{"--version"}
	env := []string{"PATH=/untrusted", "MARKER=exact"}
	var gotPath string
	var gotArgv, gotEnv []string
	expected := errors.New("exec sentinel")
	err := handoffRunc(argv, env, policy, func(path string, args, environment []string) error {
		gotPath, gotArgv, gotEnv = path, args, environment
		return expected
	})
	if !errors.Is(err, expected) {
		t.Fatalf("run error = %v, want sentinel", err)
	}
	if gotPath != policy.realRuncPath {
		t.Fatalf("exec path = %q", gotPath)
	}
	if !reflect.DeepEqual(gotArgv, []string{policy.realRuncPath, "--version"}) {
		t.Fatalf("exec argv = %#v", gotArgv)
	}
	if !reflect.DeepEqual(gotEnv, env) {
		t.Fatalf("exec env = %#v", gotEnv)
	}
}

func TestProductionPolicyKeepsRealRuncOwnersAndReadOnlyAuthority(t *testing.T) {
	policy := productionPolicy()
	if policy.effectiveReadOnly == nil {
		t.Fatal("production effective read-only validator is unavailable")
	}
	wantRuncOwners := [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}}
	if policy.realRuncOwnerPairs != wantRuncOwners {
		t.Fatalf("real runc owner pairs = %#v, want %#v", policy.realRuncOwnerPairs, wantRuncOwners)
	}
	if policy.trustTreeOwnerPairs != wantRuncOwners {
		t.Fatalf("trust tree owner pairs = %#v, want %#v", policy.trustTreeOwnerPairs, wantRuncOwners)
	}
	if policy.executorTreeOwnerPairs != wantRuncOwners {
		t.Fatalf("executor tree owner pairs = %#v, want %#v", policy.executorTreeOwnerPairs, wantRuncOwners)
	}
	policy.trustTreeOwnerPairs[0] = ownerPair{UID: 1234, GID: 1234}
	if policy.executorTreeOwnerPairs != wantRuncOwners {
		t.Fatal("executor tree ownership was coupled to trust tree ownership")
	}
	for _, rejected := range []ownerPair{{UID: 1000, GID: 1000}, {UID: 0, GID: 65534}, {UID: 65534, GID: 0}} {
		if directoryOwnerPairAccepted(rejected.UID, rejected.GID, policy.executorTreeOwnerPairs) {
			t.Fatalf("executor tree accepted unqualified owner pair %#v", rejected)
		}
	}
}

func TestFailureDiagnosticCodesAreCanonicalAndTyped(t *testing.T) {
	if len(failureDiagnosticCodes) != len(failureDiagnosticCodeCatalog) {
		t.Fatalf("runtime allowlist has %d entries, catalog has %d", len(failureDiagnosticCodes), len(failureDiagnosticCodeCatalog))
	}
	seen := make(map[failureDiagnosticCode]struct{}, len(failureDiagnosticCodeCatalog))
	for index, code := range failureDiagnosticCodeCatalog {
		if _, duplicate := seen[code]; duplicate {
			t.Fatalf("catalog entry %d duplicates diagnostic code %q", index, code)
		}
		seen[code] = struct{}{}
		if _, allowed := failureDiagnosticCodes[code]; !allowed {
			t.Fatalf("catalog diagnostic code %q is absent from runtime membership", code)
		}
		if !isAllowedFailureDiagnosticCode(string(code)) {
			t.Fatalf("allowlisted diagnostic code %q was rejected", code)
		}
		if len(code) > failureDiagnosticMaxBytes {
			t.Fatalf("diagnostic code %q exceeds its bound", code)
		}
	}
	for code := range failureDiagnosticCodes {
		if _, catalogued := seen[code]; !catalogued {
			t.Fatalf("runtime membership contains non-catalog diagnostic code %q", code)
		}
	}
	for _, invalid := range []string{
		"",
		failureDiagnosticUnavailable,
		"ICBT-UNREVIEWED-CODE-V1",
		"ICBT-CONTRACT-LOAD-V1\nsecret",
		"é",
	} {
		if isAllowedFailureDiagnosticCode(invalid) {
			t.Fatalf("non-canonical diagnostic code %q was accepted", invalid)
		}
	}
}

func TestDiagnosticCodePreservesPrimaryErrorTyping(t *testing.T) {
	primary := errors.New("primary sentinel")
	wrapped := withDiagnosticCode(diagnosticConfigStrictEnvelope, primary)
	if !errors.Is(wrapped, primary) {
		t.Fatal("diagnostic typing replaced primary error causality")
	}
	if got := diagnosticCodeForError(wrapped); got != diagnosticConfigStrictEnvelope {
		t.Fatalf("diagnostic code = %q", got)
	}
	nested := withDiagnosticCode(diagnosticConfigPatch, wrapped)
	if nested != wrapped || diagnosticCodeForError(nested) != diagnosticConfigStrictEnvelope {
		t.Fatalf("outer stage replaced nested diagnostic typing: %v", nested)
	}
	if got := diagnosticCodeForError(primary); got != diagnosticInternal {
		t.Fatalf("uncoded diagnostic = %q", got)
	}
}

func TestEveryBuildkitDiagnosticStageMapsExactly(t *testing.T) {
	stages := []failureDiagnosticCode{
		diagnosticExecutorOpen,
		diagnosticExecutorMetadata,
		diagnosticBundleOpen,
		diagnosticBundleMetadata,
		diagnosticSourceCACertOpen,
		diagnosticSourceCACertMetadata,
		diagnosticSourceCACertReadOnly,
		diagnosticSourceCACertDigest,
		diagnosticSourceCABundleOpen,
		diagnosticSourceCABundleMeta,
		diagnosticSourceCABundleRO,
		diagnosticSourceCABundleDigest,
		diagnosticSourceAPTConfigOpen,
		diagnosticSourceAPTConfigMeta,
		diagnosticSourceAPTConfigRO,
		diagnosticSourceAPTConfigDigest,
		diagnosticConfigOpen,
		diagnosticConfigMetadata,
		diagnosticConfigRead,
		diagnosticConfigStrictEnvelope,
		diagnosticConfigPatch,
		diagnosticConfigAtomicCommit,
	}
	for _, stage := range stages {
		t.Run(string(stage), func(t *testing.T) {
			injected := withDiagnosticCode(stage, errors.New("injected stage failure"))
			if got := diagnosticCodeForError(injected); got != stage {
				t.Fatalf("diagnostic code = %q, want %q", got, stage)
			}
		})
	}
}

func TestFailureDiagnosticCommandsRequireExactSoleArgument(t *testing.T) {
	for _, argv := range [][]string{
		nil,
		{},
		{failureDiagnosticClearCommand, "extra"},
		{"prefix", failureDiagnosticReadCommand},
		{"--version"},
	} {
		if handled, _, _ := dispatchFailureDiagnosticCommand(argv); handled {
			t.Fatalf("non-exact internal argv was dispatched: %#v", argv)
		}
	}
}

func TestContractMetadataDoesNotUseNamespaceOwnerAsAuthority(t *testing.T) {
	for _, owner := range []struct{ uid, gid uint32 }{{0, 0}, {1000, 1000}, {65534, 65534}, {12345, 54321}} {
		observed := contractFileMetadata{
			fileType: syscall.S_IFREG,
			mode:     0o444,
			uid:      owner.uid,
			gid:      owner.gid,
			nlink:    1,
			size:     128,
		}
		if err := validateContractMetadata(observed); err != nil {
			t.Fatalf("owner %d:%d was used as contract authority: %v", owner.uid, owner.gid, err)
		}
	}
	for _, invalid := range []contractFileMetadata{
		{fileType: syscall.S_IFDIR, mode: 0o444, uid: 12345, gid: 54321, nlink: 1, size: 128},
		{fileType: syscall.S_IFREG, mode: 0o644, uid: 12345, gid: 54321, nlink: 1, size: 128},
		{fileType: syscall.S_IFREG, mode: 0o444, uid: 12345, gid: 54321, nlink: 2, size: 128},
		{fileType: syscall.S_IFREG, mode: 0o444, uid: 12345, gid: 54321, nlink: 1, size: 0},
	} {
		if err := validateContractMetadata(invalid); err == nil {
			t.Fatalf("invalid contract metadata was accepted: %#v", invalid)
		}
	}
}

func TestTrustContractParentTraversalRemainsRootOnly(t *testing.T) {
	if !directoryOwnerAccepted(0) {
		t.Fatal("root-owned trust contract parent was rejected")
	}
	if directoryOwnerAccepted(1000) {
		t.Fatal("codespace-owned trust contract parent was accepted")
	}
}

func TestTrustTreeTraversalAcceptsOnlyCompleteRootAndOverflowPairs(t *testing.T) {
	allowed := [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}}
	for _, test := range []struct {
		uid, gid int
		want     bool
	}{
		{uid: 0, gid: 0, want: true},
		{uid: 65534, gid: 65534, want: true},
		{uid: 1000, gid: 1000, want: false},
		{uid: 0, gid: 65534, want: false},
		{uid: 65534, gid: 0, want: false},
	} {
		if got := directoryOwnerPairAccepted(test.uid, test.gid, allowed); got != test.want {
			t.Fatalf("directoryOwnerPairAccepted(%d:%d) = %t, want %t", test.uid, test.gid, got, test.want)
		}
	}
}

func TestBoundedErrorRemovesNewlinesAndBoundsOutput(t *testing.T) {
	message := boundedError(errors.New(strings.Repeat("x", 600) + "\nsecret"))
	if strings.Contains(message, "\n") || len(message) != 515 || !strings.HasSuffix(message, "...") {
		t.Fatalf("unexpected bounded error: len=%d %q", len(message), message)
	}
}

func readArgvFixture(t *testing.T) []string {
	t.Helper()
	const syntheticID = "aaaaaaaaaaaaaaaaaaaaaaaaa"
	repositoryRoot := os.Getenv("IRONCURTAIN_REPOSITORY_ROOT")
	if repositoryRoot == "" {
		repositoryRoot = filepath.Join("..", "..")
	}
	contents, err := os.ReadFile(filepath.Join(repositoryRoot, "docs", "designs", "evidence", "ca-injection-runc-path-spike.argv.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		RedactionToken string   `json:"redactionToken"`
		ExecutorRoot   string   `json:"executorRoot"`
		ArgvAfterRunc  []string `json:"argvAfterRunc"`
	}
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.RedactionToken == "" || fixture.ExecutorRoot != buildkitExecutorRoot {
		t.Fatal("argv evidence has an unexpected root or redaction contract")
	}
	argv := make([]string, len(fixture.ArgvAfterRunc))
	for index, argument := range fixture.ArgvAfterRunc {
		argv[index] = strings.ReplaceAll(argument, fixture.RedactionToken, syntheticID)
	}
	return argv
}

func testPackagePath(relative string) string {
	repositoryRoot := os.Getenv("IRONCURTAIN_REPOSITORY_ROOT")
	if repositoryRoot == "" {
		return relative
	}
	return filepath.Join(repositoryRoot, "docker", "build-trust-runtime", relative)
}
