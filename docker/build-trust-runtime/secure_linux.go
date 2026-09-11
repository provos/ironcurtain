//go:build linux

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const directoryFlags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC

var errDirectoryMetadata = errors.New("directory metadata validation failed")

type sourceDiagnosticCodes struct {
	open     failureDiagnosticCode
	metadata failureDiagnosticCode
	readOnly failureDiagnosticCode
}

func patchBundleSecure(bundlePath string, policy runtimePolicy, contract trustContract) error {
	executor, err := openAbsoluteDirectoryWithOwners(policy.buildkitExecutorRoot, policy.executorTreeOwnerPairs)
	if err != nil {
		code := diagnosticExecutorOpen
		if errors.Is(err, errDirectoryMetadata) {
			code = diagnosticExecutorMetadata
		}
		return withDiagnosticCode(code, fmt.Errorf("open executor root: %w", err))
	}
	defer syscall.Close(executor)

	id := filepath.Base(bundlePath)
	if bundlePath != policy.buildkitExecutorRoot+"/"+id || !buildkitIDPattern.MatchString(id) {
		return withDiagnosticCode(diagnosticBundleOpen, errors.New("bundle is not a canonical direct child"))
	}
	bundle, err := syscall.Openat(executor, id, directoryFlags, 0)
	if err != nil {
		return withDiagnosticCode(diagnosticBundleOpen, fmt.Errorf("open bundle without following links: %w", err))
	}
	defer syscall.Close(bundle)
	var bundleStat syscall.Stat_t
	if err := syscall.Fstat(bundle, &bundleStat); err != nil {
		return withDiagnosticCode(diagnosticBundleMetadata, fmt.Errorf("stat bundle: %w", err))
	}
	if err := validateExactDirectoryStat(bundleStat, policy.bundleUID, policy.bundleGID, policy.bundleMode); err != nil {
		return withDiagnosticCode(diagnosticBundleMetadata, fmt.Errorf("validate bundle: %w", err))
	}
	for _, source := range contract.PublicSources {
		if err := validateSourceFile(policy, source); err != nil {
			return err
		}
	}
	return patchConfigAt(bundle, bundlePath, bundleStat, policy, sourcesFromContract(contract))
}

func loadTrustContractSecure(policy runtimePolicy) (trustContract, error) {
	// The mounted leaf's namespace owner is diagnostic only, while every parent
	// component remains trusted root-owned infrastructure in every qualified view.
	fd, err := openAbsoluteFileWithParentOwners(policy.trustContractPath, policy.trustTreeOwnerPairs)
	if err != nil {
		return trustContract{}, fmt.Errorf("open immutable trust contract: %w", err)
	}
	file := os.NewFile(uintptr(fd), "build-trust-contract.json")
	if file == nil {
		_ = syscall.Close(fd)
		return trustContract{}, errors.New("wrap trust contract descriptor")
	}
	defer file.Close()
	stat, err := validateContractFile(fd)
	if err != nil {
		return trustContract{}, fmt.Errorf("validate immutable trust contract: %w", err)
	}
	if err := requireEffectiveReadOnly(policy, fd, policy.trustContractPath); err != nil {
		return trustContract{}, fmt.Errorf("validate immutable trust contract backing: %w", err)
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxContractBytes+1))
	if err != nil || int64(len(contents)) != stat.Size {
		return trustContract{}, errors.New("read immutable trust contract")
	}
	return parseTrustContract(contents, policy)
}

func validateRealRunc(policy runtimePolicy, contract trustContract) error {
	fd, err := openAbsoluteFileWithParentOwners(policy.realRuncPath, policy.trustTreeOwnerPairs)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if err := validateExactOwnerlessRegularStat(stat, contract.RealRunc, 128<<20); err != nil {
		return fmt.Errorf("selected runc metadata does not match the immutable trust contract: %w", err)
	}
	if err := requireEffectiveReadOnly(policy, fd, policy.realRuncPath); err != nil {
		return fmt.Errorf("real runc backing is not read-only: %w", err)
	}
	return nil
}

func validateOwnExecutableReadOnly(policy runtimePolicy) error {
	path, err := os.Executable()
	if err != nil {
		return err
	}
	fd, err := openAbsoluteFileWithParentOwners(path, policy.trustTreeOwnerPairs)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return requireEffectiveReadOnly(policy, fd, path)
}

func openAbsoluteDirectory(path string, allowedUIDs ...int) (int, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return -1, errors.New("path must be clean and absolute")
	}
	fd, err := syscall.Open("/", directoryFlags, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if component == "" || component == "." || component == ".." || len(component) > 255 {
			syscall.Close(fd)
			return -1, errors.New("path contains an invalid component")
		}
		next, err := syscall.Openat(fd, component, directoryFlags, 0)
		syscall.Close(fd)
		if err != nil {
			return -1, err
		}
		if err := validateDirectoryFD(next, allowedUIDs...); err != nil {
			syscall.Close(next)
			return -1, fmt.Errorf("%w: %w", errDirectoryMetadata, err)
		}
		fd = next
	}
	return fd, nil
}

func openAbsoluteFile(path string, allowedUIDs ...int) (int, error) {
	directory := filepath.Dir(path)
	parent, err := openAbsoluteDirectory(directory, allowedUIDs...)
	if err != nil {
		return -1, err
	}
	defer syscall.Close(parent)
	return syscall.Openat(parent, filepath.Base(path), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
}

func openAbsoluteFileWithParentOwners(path string, allowedOwners [2]ownerPair) (int, error) {
	parent, err := openAbsoluteDirectoryWithOwners(filepath.Dir(path), allowedOwners)
	if err != nil {
		return -1, err
	}
	defer syscall.Close(parent)
	return syscall.Openat(parent, filepath.Base(path), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
}

func openAbsoluteDirectoryWithOwners(path string, allowedOwners [2]ownerPair) (int, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return -1, errors.New("path must be clean and absolute")
	}
	fd, err := syscall.Open("/", directoryFlags, 0)
	if err != nil {
		return -1, err
	}
	if path == "/" {
		return fd, nil
	}
	traversed := ""
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if component == "" || component == "." || component == ".." || len(component) > 255 {
			syscall.Close(fd)
			return -1, errors.New("path contains an invalid component")
		}
		next, err := syscall.Openat(fd, component, directoryFlags, 0)
		syscall.Close(fd)
		if err != nil {
			return -1, err
		}
		traversed += "/" + component
		var metadataError error
		if traversed == filepath.Dir(trustContractPath) {
			metadataError = validateProtectedDirectoryFD(next)
		} else {
			metadataError = validateDirectoryOwnerPairs(next, allowedOwners)
		}
		if metadataError != nil {
			syscall.Close(next)
			return -1, fmt.Errorf("%w: %w", errDirectoryMetadata, metadataError)
		}
		fd = next
	}
	return fd, nil
}

// The coordinator mounts this exact top-level directory read-only. Its source
// UID is namespace-mapped host metadata, not authority over the mounted files.
func validateProtectedDirectoryFD(fd int) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR || stat.Mode&0o7777 != 0o755 {
		return errors.New("protected generation directory metadata is invalid")
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Fstatfs(fd, &filesystem); err != nil {
		return err
	}
	if filesystem.Flags&1 == 0 {
		return errors.New("protected generation directory is writable")
	}
	return nil
}

func requireEffectiveReadOnly(policy runtimePolicy, fd int, path string) error {
	if policy.effectiveReadOnly == nil {
		return errors.New("effective read-only validator is unavailable")
	}
	return policy.effectiveReadOnly(fd, path)
}

func validateEffectiveReadOnlyFile(fd int, _ string) error {
	var filesystem syscall.Statfs_t
	if err := syscall.Fstatfs(fd, &filesystem); err != nil {
		return fmt.Errorf("inspect filesystem flags: %w", err)
	}
	const statfsReadOnly = 1
	if filesystem.Flags&statfsReadOnly == 0 {
		return errors.New("filesystem or mount is writable")
	}
	var metadata syscall.Stat_t
	if err := syscall.Fstat(fd, &metadata); err != nil {
		return fmt.Errorf("inspect file metadata: %w", err)
	}
	if metadata.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return errors.New("protected input is not a regular file")
	}
	// A pathname write-open can fail on executable text or file permissions
	// before checking mount writability. Probe the same already-open object by
	// requesting its unchanged mode instead. Both descriptor-bound ST_RDONLY
	// and EROFS are mandatory; ETXTBSY and permission errors never suffice.
	if err := syscall.Fchmod(fd, metadata.Mode&0o7777); !errors.Is(err, syscall.EROFS) {
		return fmt.Errorf("mode probe did not fail with EROFS: %v", err)
	}
	return nil
}

func validateDirectoryFD(fd int, allowedUIDs ...int) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errors.New("component is not a directory")
	}
	if !directoryOwnerAccepted(int(stat.Uid), allowedUIDs...) {
		return errors.New("directory has an unexpected owner")
	}
	if stat.Mode&0o022 != 0 {
		return errors.New("directory is group- or other-writable")
	}
	return nil
}

func validateDirectoryOwnerPairs(fd int, allowedOwners [2]ownerPair) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errors.New("component is not a directory")
	}
	if !directoryOwnerPairAccepted(int(stat.Uid), int(stat.Gid), allowedOwners) {
		return errors.New("directory has an unexpected owner pair")
	}
	if stat.Mode&0o022 != 0 {
		return errors.New("directory is group- or other-writable")
	}
	return nil
}

func validateSourceFile(policy runtimePolicy, source verifiedTrustSource) error {
	codes := diagnosticCodesForSource(source.trustSource)
	fd, err := openAbsoluteFileWithParentOwners(source.Source, policy.trustTreeOwnerPairs)
	if err != nil {
		code := codes.open
		if errors.Is(err, errDirectoryMetadata) {
			code = codes.metadata
		}
		return withDiagnosticCode(code, fmt.Errorf("open trust source %s: %w", source.Source, err))
	}
	defer syscall.Close(fd)
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return withDiagnosticCode(codes.metadata, err)
	}
	if err := validateExactOwnerlessRegularStat(stat, source.integrityRecord, source.MaxBytes); err != nil {
		return withDiagnosticCode(codes.metadata, fmt.Errorf("trust source %s is not immutable: %w", source.Source, err))
	}
	if err := requireEffectiveReadOnly(policy, fd, source.Source); err != nil {
		return withDiagnosticCode(codes.readOnly, fmt.Errorf("trust source %s backing is not immutable: %w", source.Source, err))
	}
	return nil
}

func diagnosticCodesForSource(source trustSource) sourceDiagnosticCodes {
	switch source.Destination {
	case "/dev/ironcurtain/ca-cert.pem":
		return sourceDiagnosticCodes{
			open: diagnosticSourceCACertOpen, metadata: diagnosticSourceCACertMetadata,
			readOnly: diagnosticSourceCACertReadOnly,
		}
	case "/dev/ironcurtain/ca-bundle.pem":
		return sourceDiagnosticCodes{
			open: diagnosticSourceCABundleOpen, metadata: diagnosticSourceCABundleMeta,
			readOnly: diagnosticSourceCABundleRO,
		}
	case "/dev/ironcurtain/apt.conf":
		return sourceDiagnosticCodes{
			open: diagnosticSourceAPTConfigOpen, metadata: diagnosticSourceAPTConfigMeta,
			readOnly: diagnosticSourceAPTConfigRO,
		}
	default:
		return sourceDiagnosticCodes{
			open: diagnosticInternal, metadata: diagnosticInternal,
			readOnly: diagnosticInternal,
		}
	}
}

func validateExactOwnerlessRegularStat(stat syscall.Stat_t, expected integrityRecord, maxBytes int64) error {
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Nlink != 1 {
		return fmt.Errorf("unsafe type or link count (observed uid=%d gid=%d nlink=%d)", stat.Uid, stat.Gid, stat.Nlink)
	}
	if stat.Mode&0o7777 != expected.Mode || stat.Mode&0o022 != 0 || (expected.Size != 0 && stat.Size != expected.Size) || stat.Size <= 0 || stat.Size > maxBytes {
		return fmt.Errorf("mode or size mismatch (observed uid=%d gid=%d mode=%#o size=%d)", stat.Uid, stat.Gid, stat.Mode&0o7777, stat.Size)
	}
	return nil
}

func validateContractFile(fd int) (syscall.Stat_t, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return stat, err
	}
	if err := validateContractMetadata(contractFileMetadata{
		fileType: stat.Mode & syscall.S_IFMT,
		mode:     stat.Mode & 0o7777,
		uid:      stat.Uid,
		gid:      stat.Gid,
		nlink:    uint64(stat.Nlink),
		size:     stat.Size,
	}); err != nil {
		return stat, err
	}
	return stat, nil
}

func validateExactDirectoryStat(stat syscall.Stat_t, expectedUID, expectedGID int, expectedMode uint32) error {
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR || int(stat.Uid) != expectedUID || int(stat.Gid) != expectedGID {
		return errors.New("unsafe directory type, owner, or group")
	}
	if stat.Mode&0o7777 != expectedMode || stat.Mode&0o022 != 0 {
		return errors.New("directory mode mismatch")
	}
	return nil
}

func patchConfigAt(bundle int, bundlePath string, bundleStat syscall.Stat_t, policy runtimePolicy, sources []trustSource) error {
	rootfs, err := syscall.Openat(bundle, "rootfs", directoryFlags, 0)
	if err != nil {
		return withDiagnosticCode(diagnosticConfigOpen, fmt.Errorf("open rootfs without following links: %w", err))
	}
	defer syscall.Close(rootfs)
	var rootfsStat syscall.Stat_t
	if err := syscall.Fstat(rootfs, &rootfsStat); err != nil {
		return withDiagnosticCode(diagnosticConfigMetadata, err)
	}
	if err := validateExactDirectoryStat(rootfsStat, policy.rootfsUID, policy.rootfsGID, policy.rootfsMode); err != nil {
		return withDiagnosticCode(diagnosticConfigMetadata, fmt.Errorf("validate rootfs: %w", err))
	}
	if rootfsStat.Dev == bundleStat.Dev && rootfsStat.Ino == bundleStat.Ino {
		return withDiagnosticCode(diagnosticConfigMetadata, errors.New("rootfs aliases the bundle directory"))
	}
	config, err := syscall.Openat(bundle, "config.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return withDiagnosticCode(diagnosticConfigOpen, fmt.Errorf("open config without following links: %w", err))
	}
	configFile := os.NewFile(uintptr(config), "config.json")
	if configFile == nil {
		_ = syscall.Close(config)
		return withDiagnosticCode(diagnosticConfigOpen, errors.New("wrap config descriptor"))
	}
	defer configFile.Close()
	var original syscall.Stat_t
	if err := syscall.Fstat(config, &original); err != nil {
		return withDiagnosticCode(diagnosticConfigMetadata, err)
	}
	if original.Mode&syscall.S_IFMT != syscall.S_IFREG || int(original.Uid) != policy.configUID || int(original.Gid) != policy.configGID || original.Nlink != 1 {
		return withDiagnosticCode(diagnosticConfigMetadata, errors.New("config has unsafe type, owner, group, or link count"))
	}
	if original.Mode&0o7777 != policy.configMode || original.Mode&0o022 != 0 || original.Size <= 0 || original.Size > maxConfigBytes {
		return withDiagnosticCode(diagnosticConfigMetadata, errors.New("config has unsafe mode or size"))
	}
	if original.Dev == bundleStat.Dev && (original.Ino == bundleStat.Ino || original.Ino == rootfsStat.Ino) {
		return withDiagnosticCode(diagnosticConfigMetadata, errors.New("config aliases a bundle directory"))
	}
	input, err := readConfigFile(configFile)
	if err != nil {
		return err
	}
	output, err := patchOCIConfig(input, sources, bundlePath)
	if err != nil {
		return err
	}
	if bytes.Equal(input, output) {
		return nil
	}
	return commitPatchedConfigAt(bundle, &original, input, output, nil)
}

func readConfigFile(configFile *os.File) ([]byte, error) {
	input, err := io.ReadAll(io.LimitReader(configFile, maxConfigBytes+1))
	return input, withDiagnosticCode(diagnosticConfigRead, err)
}

func commitPatchedConfigAt(bundle int, original *syscall.Stat_t, originalContents, output []byte, beforeCommit func() error) error {
	return withDiagnosticCode(
		diagnosticConfigAtomicCommit,
		replaceConfigAt(bundle, original, originalContents, output, beforeCommit),
	)
}

func replaceConfigAt(bundle int, original *syscall.Stat_t, originalContents, output []byte, beforeCommit func() error) (returnErr error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	temporary := ".config.json.ironcurtain-" + hex.EncodeToString(random)
	tempFD, err := syscall.Openat(bundle, temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	renamed := false
	tempFile := os.NewFile(uintptr(tempFD), temporary)
	if tempFile == nil {
		_ = syscall.Close(tempFD)
		_ = syscall.Unlinkat(bundle, temporary)
		return errors.New("wrap temporary descriptor")
	}
	defer func() {
		if closeErr := tempFile.Close(); returnErr == nil && closeErr != nil {
			returnErr = closeErr
		}
		if !renamed {
			_ = syscall.Unlinkat(bundle, temporary)
		}
	}()
	if err := syscall.Fchown(tempFD, int(original.Uid), int(original.Gid)); err != nil {
		return err
	}
	if err := syscall.Fchmod(tempFD, original.Mode&0o7777); err != nil {
		return err
	}
	if _, err := tempFile.Write(output); err != nil {
		return err
	}
	if err := syscall.Fsync(tempFD); err != nil {
		return err
	}
	if beforeCommit != nil {
		if err := beforeCommit(); err != nil {
			return err
		}
	}
	current, err := syscall.Openat(bundle, "config.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	currentFile := os.NewFile(uintptr(current), "config.json")
	if currentFile == nil {
		_ = syscall.Close(current)
		return errors.New("wrap current config descriptor")
	}
	var currentStat syscall.Stat_t
	statErr := syscall.Fstat(current, &currentStat)
	if statErr != nil {
		_ = currentFile.Close()
		return statErr
	}
	if currentStat.Dev != original.Dev || currentStat.Ino != original.Ino || currentStat.Size != original.Size || currentStat.Mode != original.Mode || currentStat.Uid != original.Uid || currentStat.Gid != original.Gid {
		_ = currentFile.Close()
		return errors.New("config changed during validation")
	}
	currentContents, readErr := io.ReadAll(io.LimitReader(currentFile, maxConfigBytes+1))
	closeErr := currentFile.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	if !bytes.Equal(currentContents, originalContents) {
		return errors.New("config contents changed during validation")
	}
	if err := syscall.Renameat(bundle, temporary, bundle, "config.json"); err != nil {
		return err
	}
	renamed = true
	if err := syscall.Fsync(bundle); err != nil {
		return err
	}
	post, err := syscall.Openat(bundle, "config.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	postFile := os.NewFile(uintptr(post), "config.json")
	if postFile == nil {
		_ = syscall.Close(post)
		return errors.New("wrap patched config descriptor")
	}
	defer postFile.Close()
	var postStat syscall.Stat_t
	if err := syscall.Fstat(post, &postStat); err != nil {
		return err
	}
	if postStat.Mode != original.Mode || postStat.Uid != original.Uid || postStat.Gid != original.Gid || postStat.Nlink != 1 || postStat.Size != int64(len(output)) {
		return errors.New("patched config failed metadata verification")
	}
	actual, err := io.ReadAll(io.LimitReader(postFile, int64(len(output))+1))
	if err != nil || !bytes.Equal(actual, output) {
		return errors.New("patched config failed content verification")
	}
	return nil
}
