package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode/utf8"
)

const (
	trustContractPath    = "/opt/ironcurtain-build-trust/build-trust-contract.json"
	qualifiedRuncVersion = "1.3.4"
	maxContractBytes     = 32 << 10
)

var (
	sha256Pattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	caGenerationPattern = regexp.MustCompile(`^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type integrityRecord struct {
	SHA256            string
	Size              int64
	UID               int
	GID               int
	Mode              uint32
	AlternateOwner    ownerPair
	HasAlternateOwner bool
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
	if !ok || version.String() != "1" {
		return trustContract{}, errors.New("trust contract has an unsupported schemaVersion")
	}
	caGeneration, ok := root["caGeneration"].(string)
	if !ok || !caGenerationPattern.MatchString(caGeneration) {
		return trustContract{}, errors.New("trust contract has an invalid CA generation")
	}
	realRunc, ok := root["realRunc"].(map[string]any)
	if !ok || !hasExactKeys(realRunc, "path", "sha256", "size", "ownerPairs", "nlink", "mode", "version") {
		return trustContract{}, errors.New("trust contract has an unsupported realRunc shape")
	}
	if realRunc["path"] != policy.realRuncPath || realRunc["version"] != policy.realRuncVersion {
		return trustContract{}, errors.New("trust contract does not name the qualified real runc")
	}
	ownerPairs, err := parseOwnerPairs(realRunc["ownerPairs"])
	if err != nil || ownerPairs != policy.realRuncOwnerPairs {
		return trustContract{}, errors.New("trust contract real runc owner pairs are not qualified")
	}
	realRuncIntegrity, err := parseIntegrityRecordWithOwner(realRunc, 128<<20, true, ownerPairs[0])
	if err != nil {
		return trustContract{}, fmt.Errorf("trust contract has invalid real runc metadata: %w", err)
	}
	nlink, nlinkErr := exactNonNegativeInteger(realRunc["nlink"], 1)
	if nlinkErr != nil || nlink != 1 {
		return trustContract{}, errors.New("trust contract real runc link count is not qualified")
	}
	realRuncIntegrity.AlternateOwner = ownerPairs[1]
	realRuncIntegrity.HasAlternateOwner = true

	rawSources, ok := root["publicSources"].([]any)
	if !ok || len(rawSources) != len(policy.sources) {
		return trustContract{}, errors.New("trust contract has an unsupported public source set")
	}
	publicSources := make([]verifiedTrustSource, len(rawSources))
	for index, raw := range rawSources {
		entry, ok := raw.(map[string]any)
		if !ok || !hasExactKeys(entry, "path", "destination", "sha256", "size", "mode") {
			return trustContract{}, fmt.Errorf("trust contract public source %d has an unsupported shape", index)
		}
		expected := policy.sources[index]
		if entry["path"] != expected.Source || entry["destination"] != expected.Destination {
			return trustContract{}, fmt.Errorf("trust contract public source %d is not the qualified path pair", index)
		}
		integrity, err := parseIntegrityRecordWithOwner(entry, expected.MaxBytes, false, ownerPair{})
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

func parseIntegrityRecordWithOwner(object map[string]any, maxBytes int64, executable bool, owner ownerPair) (integrityRecord, error) {
	digest, ok := object["sha256"].(string)
	if !ok || !sha256Pattern.MatchString(digest) {
		return integrityRecord{}, errors.New("invalid digest")
	}
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
	if mode&0o022 != 0 || executable && mode&0o111 == 0 || !executable && mode != 0o444 {
		return integrityRecord{}, errors.New("unsafe mode")
	}
	return integrityRecord{SHA256: digest, Size: size, UID: owner.UID, GID: owner.GID, Mode: mode}, nil
}

func parseOwnerPairs(value any) ([2]ownerPair, error) {
	var result [2]ownerPair
	raw, ok := value.([]any)
	if !ok || len(raw) != len(result) {
		return result, errors.New("ownerPairs must contain exactly two entries")
	}
	for index, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok || !hasExactKeys(object, "uid", "gid") {
			return result, errors.New("ownerPairs entry has an unsupported shape")
		}
		uid, uidErr := exactNonNegativeInteger(object["uid"], 1<<31-1)
		gid, gidErr := exactNonNegativeInteger(object["gid"], 1<<31-1)
		if uidErr != nil || gidErr != nil {
			return result, errors.New("ownerPairs entry is invalid")
		}
		result[index] = ownerPair{UID: int(uid), GID: int(gid)}
	}
	return result, nil
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
