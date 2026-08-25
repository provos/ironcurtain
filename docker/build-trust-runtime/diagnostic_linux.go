//go:build linux

package main

import (
	"errors"
	"io"
	"os"
	"syscall"
)

func openFailureDiagnosticDirectory() (int, error) {
	root, err := syscall.Open("/", directoryFlags, 0)
	if err != nil {
		return -1, err
	}
	defer syscall.Close(root)
	directory, err := syscall.Openat(root, "tmp", directoryFlags, 0)
	if err != nil {
		return -1, err
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(directory, &stat); err != nil {
		syscall.Close(directory)
		return -1, err
	}
	owners := [2]ownerPair{{UID: 0, GID: 0}, {UID: 65534, GID: 65534}}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR ||
		!directoryOwnerPairAccepted(int(stat.Uid), int(stat.Gid), owners) ||
		stat.Mode&0o7777 != 0o1777 {
		syscall.Close(directory)
		return -1, errors.New("diagnostic directory is not exact sticky tmp")
	}
	return directory, nil
}

func clearFailureDiagnosticSecure() error {
	directory, err := openFailureDiagnosticDirectory()
	if err != nil {
		return err
	}
	defer syscall.Close(directory)
	if err := syscall.Unlinkat(directory, failureDiagnosticName); err != nil && !errors.Is(err, syscall.ENOENT) {
		return err
	}
	return syscall.Fsync(directory)
}

func writeFailureDiagnosticSecure(code failureDiagnosticCode) (result error) {
	if !isAllowedFailureDiagnosticCode(string(code)) {
		return errors.New("failure diagnostic code is not allowlisted")
	}
	directory, err := openFailureDiagnosticDirectory()
	if err != nil {
		return err
	}
	defer syscall.Close(directory)
	fd, err := syscall.Openat(
		directory,
		failureDiagnosticName,
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0o600,
	)
	if err != nil {
		return err
	}
	created := true
	defer func() {
		_ = syscall.Close(fd)
		if result != nil && created {
			_ = syscall.Unlinkat(directory, failureDiagnosticName)
		}
	}()
	var before syscall.Stat_t
	if err := syscall.Fstat(fd, &before); err != nil {
		return err
	}
	if before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Mode&0o7777 != 0o600 || before.Nlink != 1 || before.Size != 0 {
		return errors.New("new failure diagnostic has unsafe metadata")
	}
	contents := []byte(code)
	for len(contents) > 0 {
		written, err := syscall.Write(fd, contents)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		contents = contents[written:]
	}
	if err := syscall.Fsync(fd); err != nil {
		return err
	}
	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil {
		return err
	}
	if after.Dev != before.Dev || after.Ino != before.Ino || after.Mode&syscall.S_IFMT != syscall.S_IFREG ||
		after.Mode&0o7777 != 0o600 || after.Nlink != 1 || after.Size != int64(len(code)) {
		return errors.New("failure diagnostic changed during write")
	}
	created = false
	return nil
}

func readFailureDiagnosticSecure() (string, error) {
	directory, err := openFailureDiagnosticDirectory()
	if err != nil {
		return "", err
	}
	defer syscall.Close(directory)
	fd, err := syscall.Openat(directory, failureDiagnosticName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), failureDiagnosticName)
	if file == nil {
		_ = syscall.Close(fd)
		return "", errors.New("wrap failure diagnostic descriptor")
	}
	defer file.Close()
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return "", err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0o7777 != 0o600 || stat.Nlink != 1 ||
		stat.Size <= 0 || stat.Size > failureDiagnosticMaxBytes {
		return "", errors.New("failure diagnostic has unsafe metadata")
	}
	contents, err := io.ReadAll(io.LimitReader(file, failureDiagnosticMaxBytes+1))
	if err != nil || int64(len(contents)) != stat.Size {
		return "", errors.New("read failure diagnostic")
	}
	code := string(contents)
	if !isAllowedFailureDiagnosticCode(code) {
		return "", errors.New("failure diagnostic code is not allowlisted")
	}
	return code, nil
}
