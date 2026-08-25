//go:build !linux

package main

import "errors"

func patchBundleSecure(_ string, _ runtimePolicy, _ trustContract) error {
	return errors.New("secure bundle mutation is supported only on Linux")
}

func loadTrustContractSecure(_ runtimePolicy) (trustContract, error) {
	return trustContract{}, errors.New("secure trust contract loading is supported only on Linux")
}

func validateRealRunc(_ runtimePolicy, _ trustContract) error {
	return errors.New("pinned runc validation is supported only on Linux")
}

func validateEffectiveReadOnlyFile(_ int, _ string) error {
	return errors.New("effective read-only validation is supported only on Linux")
}

func clearFailureDiagnosticSecure() error {
	return errors.New("failure diagnostics are supported only on Linux")
}

func writeFailureDiagnosticSecure(_ failureDiagnosticCode) error {
	return errors.New("failure diagnostics are supported only on Linux")
}

func readFailureDiagnosticSecure() (string, error) {
	return "", errors.New("failure diagnostics are supported only on Linux")
}
