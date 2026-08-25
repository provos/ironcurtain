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
	if contract.RealRunc != (integrityRecord{
		SHA256:            "0b1f028a76a7d5e773754e99882df0be1c1be153da33ada862b7defdd62367d0",
		Size:              13,
		UID:               0,
		GID:               0,
		Mode:              0o755,
		AlternateOwner:    ownerPair{UID: 65534, GID: 65534},
		HasAlternateOwner: true,
	}) {
		t.Fatalf("unexpected real runc record %#v", contract.RealRunc)
	}
	if len(contract.PublicSources) != len(productionTrustSources) {
		t.Fatalf("public source count = %d", len(contract.PublicSources))
	}
	for index, source := range contract.PublicSources {
		if source.trustSource != productionTrustSources[index] || source.Size != 8 || source.Mode != 0o444 || source.SHA256 == "" {
			t.Fatalf("public source %d = %#v", index, source)
		}
	}
}

func TestParseTrustContractRejectsUnknownDuplicateAndNonQualifiedValues(t *testing.T) {
	valid := readContractFixture(t)
	tests := map[string][]byte{
		"unknown root key":   bytes.Replace(valid, []byte(`"schemaVersion": 1,`), []byte(`"schemaVersion": 1, "unknown": true,`), 1),
		"duplicate key":      bytes.Replace(valid, []byte(`"schemaVersion": 1,`), []byte(`"schemaVersion": 1, "schemaVersion": 1,`), 1),
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
		"wrong runc path":    bytes.Replace(valid, []byte(realRuncPath), []byte(`/tmp/runc`), 1),
		"wrong runc version": bytes.Replace(valid, []byte(`"version": "1.3.4"`), []byte(`"version": "1.3.5"`), 1),
		"uppercase digest":   bytes.Replace(valid, []byte(`0b1f028a`), []byte(`0B1F028A`), 1),
		"fractional size":    bytes.Replace(valid, []byte(`"size": 8`), []byte(`"size": 8.5`), 1),
		"unqualified outer owner": bytes.Replace(
			valid,
			[]byte(`"ownerPairs": [
      {
        "uid": 0,
        "gid": 0`),
			[]byte(`"ownerPairs": [
      {
        "uid": 1000,
        "gid": 1000`),
			1,
		),
		"mixed overflow owner": bytes.Replace(
			valid,
			[]byte(`"uid": 65534,
        "gid": 65534`),
			[]byte(`"uid": 0,
        "gid": 65534`),
			1,
		),
		"reversed owner order": bytes.Replace(
			valid,
			[]byte(`"ownerPairs": [
      {
        "uid": 0,
        "gid": 0
      },
      {
        "uid": 65534,
        "gid": 65534
      }
    ]`),
			[]byte(`"ownerPairs": [
      {
        "uid": 65534,
        "gid": 65534
      },
      {
        "uid": 0,
        "gid": 0
      }
    ]`),
			1,
		),
		"wrong runc link count": bytes.Replace(valid, []byte(`"nlink": 1`), []byte(`"nlink": 2`), 1),
		"unsafe runc mode":      bytes.Replace(valid, []byte(`"mode": "0755"`), []byte(`"mode": "0775"`), 1),
		"unsafe source mode":    bytes.Replace(valid, []byte(`"mode": "0444"`), []byte(`"mode": "0644"`), 1),
		"source owner authority": bytes.Replace(
			valid,
			[]byte(`"size": 8,`),
			[]byte(`"size": 8, "uid": 0, "gid": 0,`),
			1,
		),
		"wrong source order": bytes.Replace(valid, []byte(`/opt/ironcurtain-build-trust/ca-cert.pem`), []byte(`/opt/ironcurtain-build-trust/apt.conf`), 1),
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
