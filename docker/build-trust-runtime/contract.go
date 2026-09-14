package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode/utf8"
)

const (
	trustContractPath    = "/ironcurtain-build-trust/build-trust-contract.json"
	qualifiedRuncVersion = "1.3.4"
	maxContractBytes     = 32 << 10
)

var (
	caGenerationPattern = regexp.MustCompile(`^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type integrityRecord struct {
	Size int64
	Mode uint32
}

type ownerPair struct {
	UID int
	GID int
}

type verifiedTrustSource struct {
	trustSource
	integrityRecord
}

type trustContract struct {
	CAGeneration  string
	RealRunc      integrityRecord
	PublicSources []verifiedTrustSource
}

func parseTrustContract(input []byte, policy runtimePolicy) (trustContract, error) {
	if len(input) == 0 || len(input) > maxContractBytes {
		return trustContract{}, fmt.Errorf("trust contract size %d is outside bounds", len(input))
	}
	if !utf8.Valid(input) {
		return trustContract{}, errors.New("trust contract is not valid UTF-8")
	}
	value, err := decodeStrictJSON(input)
	if err != nil {
		return trustContract{}, fmt.Errorf("strict trust contract decode: %w", err)
	}
	root, ok := value.(map[string]any)
	if !ok || !hasExactKeys(root, "schemaVersion", "caGeneration", "realRunc", "publicSources") {
		return trustContract{}, errors.New("trust contract has an unsupported root shape")
	}
	version, ok := root["schemaVersion"].(json.Number)
	if !ok || version.String() != "2" {
		return trustContract{}, errors.New("trust contract has an unsupported schemaVersion")
	}
	caGeneration, ok := root["caGeneration"].(string)
	if !ok || !caGenerationPattern.MatchString(caGeneration) {
		return trustContract{}, errors.New("trust contract has an invalid CA generation")
	}
	realRunc, ok := root["realRunc"].(map[string]any)
	if !ok || !hasExactKeys(realRunc, "path", "nlink", "mode", "version", "requiresEffectiveReadOnly") {
		return trustContract{}, errors.New("trust contract has an unsupported realRunc shape")
	}
	if realRunc["path"] != policy.realRuncPath || realRunc["version"] != policy.realRuncVersion {
		return trustContract{}, errors.New("trust contract does not name the qualified real runc")
	}
	if realRunc["requiresEffectiveReadOnly"] != true {
		return trustContract{}, errors.New("real runc requires effective read-only backing")
	}
	runcMode, ok := realRunc["mode"].(string)
	if !ok || (runcMode != "0755" && runcMode != "0555") {
		return trustContract{}, errors.New("real runc has an unsupported executable mode")
	}
	mode := uint32(0o755)
	if runcMode == "0555" {
		mode = 0o555
	}
	realRuncIntegrity := integrityRecord{Mode: mode}
	nlink, nlinkErr := exactNonNegativeInteger(realRunc["nlink"], 1)
	if nlinkErr != nil || nlink != 1 {
		return trustContract{}, errors.New("trust contract real runc link count is not qualified")
	}

	rawSources, ok := root["publicSources"].([]any)
	if !ok || len(rawSources) != len(policy.sources) {
		return trustContract{}, errors.New("trust contract has an unsupported public source set")
	}
	publicSources := make([]verifiedTrustSource, len(rawSources))
	for index, raw := range rawSources {
		entry, ok := raw.(map[string]any)
		if !ok || !hasExactKeys(entry, "path", "destination", "size", "mode") {
			return trustContract{}, fmt.Errorf("trust contract public source %d has an unsupported shape", index)
		}
		expected := policy.sources[index]
		if entry["path"] != expected.Source || entry["destination"] != expected.Destination {
			return trustContract{}, fmt.Errorf("trust contract public source %d is not the qualified path pair", index)
		}
		integrity, err := parseSourceMetadata(entry, expected.MaxBytes)
		if err != nil {
			return trustContract{}, fmt.Errorf("trust contract public source %d has invalid metadata: %w", index, err)
		}
		publicSources[index] = verifiedTrustSource{
			trustSource:     expected,
			integrityRecord: integrity,
		}
	}
	return trustContract{CAGeneration: caGeneration, RealRunc: realRuncIntegrity, PublicSources: publicSources}, nil
}

func parseSourceMetadata(object map[string]any, maxBytes int64) (integrityRecord, error) {
	size, err := exactNonNegativeInteger(object["size"], maxBytes)
	if err != nil || size == 0 {
		return integrityRecord{}, errors.New("size is outside bounds")
	}
	modeText, ok := object["mode"].(string)
	if !ok || len(modeText) != 4 || modeText[0] != '0' {
		return integrityRecord{}, errors.New("invalid mode")
	}
	var mode uint32
	for _, digit := range modeText[1:] {
		if digit < '0' || digit > '7' {
			return integrityRecord{}, errors.New("invalid mode")
		}
		mode = mode*8 + uint32(digit-'0')
	}
	if mode != 0o444 {
		return integrityRecord{}, errors.New("unsafe mode")
	}
	return integrityRecord{Size: size, Mode: mode}, nil
}

func exactNonNegativeInteger(value any, maximum int64) (int64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, errors.New("value is not an integer")
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 || parsed > maximum {
		return 0, errors.New("integer is outside bounds")
	}
	return parsed, nil
}

func hasExactKeys(object map[string]any, expected ...string) bool {
	if len(object) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, found := object[key]; !found {
			return false
		}
	}
	return true
}

func hasOnlyKeys(object map[string]any, allowed ...string) bool {
	set := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		set[key] = true
	}
	for key := range object {
		if !set[key] {
			return false
		}
	}
	return true
}

func sourcesFromContract(contract trustContract) []trustSource {
	sources := make([]trustSource, len(contract.PublicSources))
	for index, source := range contract.PublicSources {
		sources[index] = source.trustSource
	}
	return sources
}
