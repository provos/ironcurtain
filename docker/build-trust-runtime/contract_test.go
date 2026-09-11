package main

import (
	"bytes"
	"os"
	"testing"
)

func TestParseTrustContractAcceptsOnlyExactQualifiedSchema(t *testing.T) {
	contract, err := parseTrustContract(readContractFixture(t), productionPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if contract.CAGeneration != "gen-00000000-0000-4000-8000-000000000000" {
		t.Fatalf("unexpected CA generation %q", contract.CAGeneration)
	}
	if contract.RealRunc != (integrityRecord{Mode: 0o755}) {
		t.Fatalf("unexpected real runc record %#v", contract.RealRunc)
	}
	if len(contract.PublicSources) != len(productionTrustSources) {
		t.Fatalf("public source count = %d", len(contract.PublicSources))
	}
	for index, source := range contract.PublicSources {
		if source.trustSource != productionTrustSources[index] || source.Size != 8 || source.Mode != 0o444 {
			t.Fatalf("public source %d = %#v", index, source)
		}
	}
}

func TestParseTrustContractRejectsUnknownDuplicateAndNonQualifiedValues(t *testing.T) {
	valid := readContractFixture(t)
	tests := map[string][]byte{
		"unknown root key":   bytes.Replace(valid, []byte(`"schemaVersion": 2,`), []byte(`"schemaVersion": 2, "unknown": true,`), 1),
		"duplicate key":      bytes.Replace(valid, []byte(`"schemaVersion": 2,`), []byte(`"schemaVersion": 2, "schemaVersion": 2,`), 1),
		"missing generation": bytes.Replace(valid, []byte("  \"caGeneration\": \"gen-00000000-0000-4000-8000-000000000000\",\n"), nil, 1),
		"malformed generation": bytes.Replace(
			valid,
			[]byte(`gen-00000000-0000-4000-8000-000000000000`),
			[]byte(`gen-not-authenticated`),
			1,
		),
		"non-v4 generation": bytes.Replace(valid, []byte(`gen-00000000-0000-4000-8000-000000000000`), []byte(`gen-00000000-0000-1000-8000-000000000000`), 1),
		"non-RFC variant generation": bytes.Replace(
			valid,
			[]byte(`gen-00000000-0000-4000-8000-000000000000`),
			[]byte(`gen-00000000-0000-4000-7000-000000000000`),
			1,
		),
		"wrong runc path":       bytes.Replace(valid, []byte(realRuncPath), []byte(`/tmp/runc`), 1),
		"wrong runc version":    bytes.Replace(valid, []byte(`"version": "1.3.4"`), []byte(`"version": "1.3.5"`), 1),
		"writable runc backing": bytes.Replace(valid, []byte(`"requiresEffectiveReadOnly": true`), []byte(`"requiresEffectiveReadOnly": false`), 1),
		"fractional size":       bytes.Replace(valid, []byte(`"size": 8`), []byte(`"size": 8.5`), 1),
		"wrong runc link count": bytes.Replace(valid, []byte(`"nlink": 1`), []byte(`"nlink": 2`), 1),
		"unsafe runc mode":      bytes.Replace(valid, []byte(`"mode": "0755"`), []byte(`"mode": "0775"`), 1),
		"unsafe source mode":    bytes.Replace(valid, []byte(`"mode": "0444"`), []byte(`"mode": "0644"`), 1),
		"source owner authority": bytes.Replace(
			valid,
			[]byte(`"size": 8,`),
			[]byte(`"size": 8, "uid": 0, "gid": 0,`),
			1,
		),
		"wrong source order": bytes.Replace(valid, []byte(`/ironcurtain-build-trust/ca-cert.pem`), []byte(`/ironcurtain-build-trust/apt.conf`), 1),
	}
	for name, input := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := parseTrustContract(input, productionPolicy()); err == nil {
				t.Fatal("invalid trust contract was accepted")
			}
		})
	}
}

func readContractFixture(t *testing.T) []byte {
	t.Helper()
	contents, err := os.ReadFile(testPackagePath("testdata/synthetic-build-trust-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	return contents
}
