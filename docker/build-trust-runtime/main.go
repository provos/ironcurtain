package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

const (
	realRuncPath                  = "/usr/local/lib/ironcurtain-docker/bin/runc"
	buildkitExecutorRoot          = "/home/codespace/.local/share/docker/buildkit/executor"
	buildkitLogPath               = buildkitExecutorRoot + "/runc-log.json"
	failureExitCode               = 125
	failureDiagnosticDirectory    = "/tmp"
	failureDiagnosticName         = ".ironcurtain-build-trust-runc-failure-v1"
	failureDiagnosticPath         = failureDiagnosticDirectory + "/" + failureDiagnosticName
	failureDiagnosticMaxBytes     = 128
	failureDiagnosticClearCommand = "--ironcurtain-internal-clear-failure-v1"
	failureDiagnosticReadCommand  = "--ironcurtain-internal-read-failure-v1"
	failureDiagnosticUnavailable  = "ICBT-DIAGNOSTIC-UNAVAILABLE-V1"
)

type failureDiagnosticCode string

const (
	// ironcurtain:failure-diagnostic-code-values:begin
	diagnosticRuncGrammar           failureDiagnosticCode = "ICBT-RUNC-GRAMMAR-V1"
	diagnosticContractLoad          failureDiagnosticCode = "ICBT-CONTRACT-LOAD-V1"
	diagnosticExecutorOpen          failureDiagnosticCode = "ICBT-EXECUTOR-OPEN-V1"
	diagnosticExecutorMetadata      failureDiagnosticCode = "ICBT-EXECUTOR-METADATA-V1"
	diagnosticBundleOpen            failureDiagnosticCode = "ICBT-BUNDLE-OPEN-V1"
	diagnosticBundleMetadata        failureDiagnosticCode = "ICBT-BUNDLE-METADATA-V1"
	diagnosticSourceCACertOpen      failureDiagnosticCode = "ICBT-SOURCE-CA-CERT-OPEN-V1"
	diagnosticSourceCACertMetadata  failureDiagnosticCode = "ICBT-SOURCE-CA-CERT-METADATA-V1"
	diagnosticSourceCACertReadOnly  failureDiagnosticCode = "ICBT-SOURCE-CA-CERT-READONLY-V1"
	diagnosticSourceCACertDigest    failureDiagnosticCode = "ICBT-SOURCE-CA-CERT-DIGEST-V1"
	diagnosticSourceCABundleOpen    failureDiagnosticCode = "ICBT-SOURCE-CA-BUNDLE-OPEN-V1"
	diagnosticSourceCABundleMeta    failureDiagnosticCode = "ICBT-SOURCE-CA-BUNDLE-METADATA-V1"
	diagnosticSourceCABundleRO      failureDiagnosticCode = "ICBT-SOURCE-CA-BUNDLE-READONLY-V1"
	diagnosticSourceCABundleDigest  failureDiagnosticCode = "ICBT-SOURCE-CA-BUNDLE-DIGEST-V1"
	diagnosticSourceAPTConfigOpen   failureDiagnosticCode = "ICBT-SOURCE-APT-CONFIG-OPEN-V1"
	diagnosticSourceAPTConfigMeta   failureDiagnosticCode = "ICBT-SOURCE-APT-CONFIG-METADATA-V1"
	diagnosticSourceAPTConfigRO     failureDiagnosticCode = "ICBT-SOURCE-APT-CONFIG-READONLY-V1"
	diagnosticSourceAPTConfigDigest failureDiagnosticCode = "ICBT-SOURCE-APT-CONFIG-DIGEST-V1"
	diagnosticConfigOpen            failureDiagnosticCode = "ICBT-CONFIG-OPEN-V1"
	diagnosticConfigMetadata        failureDiagnosticCode = "ICBT-CONFIG-METADATA-V1"
	diagnosticConfigRead            failureDiagnosticCode = "ICBT-CONFIG-READ-V1"
	diagnosticConfigStrictEnvelope  failureDiagnosticCode = "ICBT-CONFIG-STRICT-ENVELOPE-V1"
	diagnosticConfigPatch           failureDiagnosticCode = "ICBT-CONFIG-PATCH-V1"
	diagnosticConfigAtomicCommit    failureDiagnosticCode = "ICBT-CONFIG-ATOMIC-COMMIT-V1"
	diagnosticRealRunc              failureDiagnosticCode = "ICBT-REAL-RUNC-VALIDATION-V1"
	diagnosticRuncHandoff           failureDiagnosticCode = "ICBT-REAL-RUNC-HANDOFF-V1"
	diagnosticInternal              failureDiagnosticCode = "ICBT-INTERNAL-ERROR-V1"
	// ironcurtain:failure-diagnostic-code-values:end
)

var failureDiagnosticCodeCatalog = [...]failureDiagnosticCode{
	// ironcurtain:failure-diagnostic-codes:begin
	diagnosticRuncGrammar,
	diagnosticContractLoad,
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
	diagnosticRealRunc,
	diagnosticRuncHandoff,
	diagnosticInternal,
	// ironcurtain:failure-diagnostic-codes:end
}

var failureDiagnosticCodes = func() map[failureDiagnosticCode]struct{} {
	result := make(map[failureDiagnosticCode]struct{}, len(failureDiagnosticCodeCatalog))
	for _, code := range failureDiagnosticCodeCatalog {
		result[code] = struct{}{}
	}
	return result
}()

var buildkitIDPattern = regexp.MustCompile(`^[a-z0-9]{25}$`)

type runtimePolicy struct {
	realRuncPath           string
	realRuncVersion        string
	realRuncOwnerPairs     [2]ownerPair
	trustTreeOwnerPairs    [2]ownerPair
	executorTreeOwnerPairs [2]ownerPair
	buildkitExecutorRoot   string
	buildkitLogPath        string
	trustContractPath      string
	bundleUID              int
	bundleGID              int
	bundleMode             uint32
	configUID              int
	configGID              int
	configMode             uint32
	rootfsUID              int
	rootfsGID              int
	rootfsMode             uint32
	effectiveReadOnly      effectiveReadOnlyValidator
	sources                []trustSource
}

type effectiveReadOnlyValidator func(fd int, path string) error

type contractFileMetadata struct {
	fileType uint32
	mode     uint32
	uid      uint32
	gid      uint32
	nlink    uint64
	size     int64
}

func productionPolicy() runtimePolicy {
	return runtimePolicy{
		realRuncPath:           realRuncPath,
		realRuncVersion:        qualifiedRuncVersion,
		realRuncOwnerPairs:     [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}},
		trustTreeOwnerPairs:    [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}},
		executorTreeOwnerPairs: [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}},
		buildkitExecutorRoot:   buildkitExecutorRoot,
		buildkitLogPath:        buildkitLogPath,
		trustContractPath:      trustContractPath,
		bundleUID:              0,
		bundleGID:              0,
		bundleMode:             0o711,
		configUID:              0,
		configGID:              0,
		configMode:             0o644,
		rootfsUID:              0,
		rootfsGID:              0,
		rootfsMode:             0o755,
		effectiveReadOnly:      validateEffectiveReadOnlyFile,
		sources:                productionTrustSources,
	}
}

type execFunc func(path string, argv []string, env []string) error

func directoryOwnerAccepted(uid int, allowedUIDs ...int) bool {
	if uid == 0 {
		return true
	}
	for _, allowedUID := range allowedUIDs {
		if uid == allowedUID {
			return true
		}
	}
	return false
}

func directoryOwnerPairAccepted(uid, gid int, allowed [2]ownerPair) bool {
	observed := ownerPair{UID: uid, GID: gid}
	return observed == allowed[0] || observed == allowed[1]
}

func validateContractMetadata(observed contractFileMetadata) error {
	if observed.fileType != syscall.S_IFREG || observed.nlink != 1 {
		return fmt.Errorf(
			"unsafe type or link count (observed type=%#o uid=%d gid=%d nlink=%d)",
			observed.fileType,
			observed.uid,
			observed.gid,
			observed.nlink,
		)
	}
	if observed.mode != 0o444 || observed.size <= 0 || observed.size > maxContractBytes {
		return fmt.Errorf(
			"unsafe mode or size (observed mode=%#o uid=%d gid=%d size=%d)",
			observed.mode,
			observed.uid,
			observed.gid,
			observed.size,
		)
	}
	return nil
}

func main() {
	policy := productionPolicy()
	if handled, exitCode, output := dispatchFailureDiagnosticCommand(os.Args[1:]); handled {
		if output != "" {
			_, _ = fmt.Fprintln(os.Stdout, output)
		}
		if exitCode != 0 {
			os.Exit(exitCode)
		}
		return
	}
	if err := run(os.Args[1:], os.Environ(), policy, syscall.Exec); err != nil {
		_ = writeFailureDiagnosticSecure(diagnosticCodeForError(err))
		_, _ = fmt.Fprintf(os.Stderr, "ironcurtain build runtime: %s\n", boundedError(err))
		os.Exit(failureExitCode)
	}
}

type codedRuntimeError struct {
	code failureDiagnosticCode
	err  error
}

func (err codedRuntimeError) Error() string { return err.err.Error() }
func (err codedRuntimeError) Unwrap() error { return err.err }

func withDiagnosticCode(code failureDiagnosticCode, err error) error {
	if err == nil {
		return nil
	}
	var nested codedRuntimeError
	if errors.As(err, &nested) && isAllowedFailureDiagnosticCode(string(nested.code)) {
		return err
	}
	return codedRuntimeError{code: code, err: err}
}

func diagnosticCodeForError(err error) failureDiagnosticCode {
	var coded codedRuntimeError
	if errors.As(err, &coded) && isAllowedFailureDiagnosticCode(string(coded.code)) {
		return coded.code
	}
	return diagnosticInternal
}

func isAllowedFailureDiagnosticCode(value string) bool {
	if len(value) == 0 || len(value) > failureDiagnosticMaxBytes {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return false
		}
	}
	_, ok := failureDiagnosticCodes[failureDiagnosticCode(value)]
	return ok
}

func dispatchFailureDiagnosticCommand(argv []string) (handled bool, exitCode int, output string) {
	if len(argv) != 1 {
		return false, 0, ""
	}
	switch argv[0] {
	case failureDiagnosticClearCommand:
		if err := clearFailureDiagnosticSecure(); err != nil {
			return true, failureExitCode, ""
		}
		return true, 0, ""
	case failureDiagnosticReadCommand:
		code, err := readFailureDiagnosticSecure()
		if err != nil || !isAllowedFailureDiagnosticCode(code) {
			return true, 0, failureDiagnosticUnavailable
		}
		return true, 0, code
	default:
		return false, 0, ""
	}
}

func run(argv, env []string, policy runtimePolicy, exec execFunc) error {
	bundle, err := qualifiedBuildkitBundle(argv, policy)
	if err != nil {
		return withDiagnosticCode(diagnosticRuncGrammar, err)
	}
	contract, err := loadTrustContractSecure(policy)
	if err != nil {
		return withDiagnosticCode(diagnosticContractLoad, fmt.Errorf("refusing runtime handoff: %w", err))
	}
	if bundle != "" {
		if err := patchBundleSecure(bundle, policy, contract); err != nil {
			return fmt.Errorf("refusing BuildKit launch: %w", err)
		}
	}
	if err := validateRealRunc(policy, contract); err != nil {
		return withDiagnosticCode(diagnosticRealRunc, fmt.Errorf("refusing runtime handoff: %w", err))
	}
	return withDiagnosticCode(diagnosticRuncHandoff, handoffRunc(argv, env, policy, exec))
}

func handoffRunc(argv, env []string, policy runtimePolicy, exec execFunc) error {
	execArgv := make([]string, 0, len(argv)+1)
	execArgv = append(execArgv, policy.realRuncPath)
	execArgv = append(execArgv, argv...)
	if err := exec(policy.realRuncPath, execArgv, env); err != nil {
		return fmt.Errorf("exec pinned runc: %w", err)
	}
	return errors.New("pinned runc unexpectedly returned")
}

func qualifiedBuildkitBundle(argv []string, policy runtimePolicy) (string, error) {
	if len(argv) == 9 &&
		argv[0] == "--log" && argv[1] == policy.buildkitLogPath &&
		argv[2] == "--log-format" && argv[3] == "json" &&
		argv[4] == "run" && argv[5] == "--bundle" &&
		argv[7] == "--keep" && argv[8] != "" {
		id := argv[8]
		if !buildkitIDPattern.MatchString(id) {
			return "", errors.New("BuildKit executor id is outside the qualified grammar")
		}
		expectedBundle := policy.buildkitExecutorRoot + "/" + id
		if argv[6] != expectedBundle {
			return "", errors.New("BuildKit bundle is not the canonical direct child")
		}
		return expectedBundle, nil
	}
	if len(argv) == 6 &&
		argv[0] == "--log" && argv[1] == policy.buildkitLogPath &&
		argv[2] == "--log-format" && argv[3] == "json" &&
		argv[4] == "delete" && buildkitIDPattern.MatchString(argv[5]) {
		return "", nil
	}
	for _, arg := range argv {
		if arg == "run" {
			return "", errors.New("unknown runc run invocation is not qualified for trust injection")
		}
	}

	for _, arg := range argv {
		if len(arg) > 4096 {
			return "", errors.New("runc argument exceeds the qualified bound")
		}
		if referencesExecutorRoot(arg, policy.buildkitExecutorRoot) {
			return "", errors.New("unknown invocation references the BuildKit executor root")
		}
	}
	return "", nil
}

func referencesExecutorRoot(argument, executorRoot string) bool {
	value := argument
	if _, optionValue, found := strings.Cut(argument, "="); found {
		value = optionValue
	}
	if len(value) > 4096 {
		return false
	}
	root := filepath.Clean(executorRoot)
	candidate := filepath.Clean(value)
	if !filepath.IsAbs(candidate) {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			return false
		}
		candidate = absolute
	}
	if pathIsAtOrBelow(candidate, root) {
		return true
	}
	resolvedRoot, rootErr := filepath.EvalSymlinks(root)
	resolvedCandidate, candidateErr := filepath.EvalSymlinks(candidate)
	if rootErr == nil && candidateErr == nil && pathIsAtOrBelow(resolvedCandidate, resolvedRoot) {
		return true
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return false
	}
	for current := candidate; ; current = filepath.Dir(current) {
		if info, err := os.Stat(current); err == nil && os.SameFile(info, rootInfo) {
			return true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false
		}
	}
}

func pathIsAtOrBelow(candidate, root string) bool {
	return candidate == root || strings.HasPrefix(candidate, root+string(filepath.Separator))
}

func boundedError(err error) string {
	const maxErrorBytes = 512
	message := strings.ReplaceAll(err.Error(), "\n", " ")
	if len(message) <= maxErrorBytes {
		return message
	}
	return message[:maxErrorBytes] + "..."
}
