package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

const syntheticBundlePath = buildkitExecutorRoot + "/aaaaaaaaaaaaaaaaaaaaaaaaa"
const noNetworkEnvelopeEvidenceSHA256 = "af0bcffb2c05a9648a31c383d6110d9db5d7c35550c216a38ada7663f6669a21"
const hostNetworkEnvelopeEvidenceSHA256 = "128b830f4ab83823f0e3c6229e8af913b5d989c7480040d726ac8d750bfa6a58"
const envelopeComparisonEvidenceSHA256 = "36e5779065479b0aaecbbc7f859f8a9f5ae16a66665a4b8bcac318f4fbcbebf1"

func TestQualifiedEnvelopeConstantsMatchCheckedEvidence(t *testing.T) {
	cases := []struct {
		name              string
		path              string
		digest            string
		namespaceTypes    []string
		qualificationMode string
	}{
		{
			name:              "no network",
			path:              "ca-injection-buildkit-oci-envelope.fixture.json",
			digest:            noNetworkEnvelopeEvidenceSHA256,
			namespaceTypes:    qualifiedNoNetworkNamespaceTypes,
			qualificationMode: "none",
		},
		{
			name:              "host network",
			path:              "ca-injection-buildkit-oci-envelope-host.fixture.json",
			digest:            hostNetworkEnvelopeEvidenceSHA256,
			namespaceTypes:    qualifiedHostNetworkNamespaceTypes,
			qualificationMode: "host",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := readEnvelopeEvidence(t, test.path, test.digest)
			assertEvidenceMatchesQualifiedPolicy(t, fixture, test.namespaceTypes, test.qualificationMode)
			assertExecutableFixtureRepresentsEvidence(t, fixture, test.namespaceTypes)
		})
	}

	comparison := readEvidenceBytes(t, "ca-injection-buildkit-oci-envelope-comparison.json")
	requireEvidenceDigest(t, comparison, envelopeComparisonEvidenceSHA256)
	var delta struct {
		Baseline struct {
			NetworkMode   string `json:"networkMode"`
			FixtureSHA256 string `json:"fixtureSha256"`
		} `json:"baseline"`
		Candidate struct {
			NetworkMode   string `json:"networkMode"`
			FixtureSHA256 string `json:"fixtureSha256"`
		} `json:"candidate"`
		StructuralDelta struct {
			LinuxNamespaces struct {
				Removed []evidenceNamespace `json:"removed"`
				Added   []evidenceNamespace `json:"added"`
			} `json:"linuxNamespaces"`
			DevMounts struct {
				Changed bool `json:"changed"`
			} `json:"devMounts"`
			Unexpected []any `json:"unexpectedStructuralDeltas"`
		} `json:"structuralDelta"`
	}
	if err := json.Unmarshal(comparison, &delta); err != nil {
		t.Fatal(err)
	}
	if delta.Baseline.NetworkMode != "none" || delta.Baseline.FixtureSHA256 != noNetworkEnvelopeEvidenceSHA256 || delta.Candidate.NetworkMode != "host" || delta.Candidate.FixtureSHA256 != hostNetworkEnvelopeEvidenceSHA256 || delta.StructuralDelta.DevMounts.Changed || len(delta.StructuralDelta.Unexpected) != 0 || len(delta.StructuralDelta.LinuxNamespaces.Added) != 0 || !reflect.DeepEqual(delta.StructuralDelta.LinuxNamespaces.Removed, []evidenceNamespace{{Keys: []string{"type"}, Type: "network"}}) {
		t.Fatal("checked structural comparison is not the exact network-namespace-only delta")
	}
}

type envelopeEvidence struct {
	OCIVersion string `json:"ociVersion"`
	TopLevel   struct {
		Keys     []string          `json:"keys"`
		Kinds    map[string]string `json:"kinds"`
		Presence map[string]bool   `json:"presence"`
	} `json:"topLevel"`
	Root struct {
		Keys     []string `json:"keys"`
		Path     string   `json:"path"`
		Readonly any      `json:"readonly"`
	} `json:"root"`
	Process struct {
		Keys         []string            `json:"keys"`
		Capabilities map[string][]string `json:"capabilities"`
		ArgCount     int                 `json:"argCount"`
		Args         []string            `json:"args"`
		Cwd          string              `json:"cwd"`
		EnvNames     []string            `json:"envNames"`
		User         struct {
			UID            int   `json:"uid"`
			GID            int   `json:"gid"`
			AdditionalGIDs []int `json:"additionalGids"`
		} `json:"user"`
	} `json:"process"`
	Linux struct {
		Keys          []string            `json:"keys"`
		MaskedPaths   []string            `json:"maskedPaths"`
		ReadonlyPaths []string            `json:"readonlyPaths"`
		Namespaces    []evidenceNamespace `json:"namespaces"`
		UIDMappings   any                 `json:"uidMappings"`
		GIDMappings   any                 `json:"gidMappings"`
	} `json:"linux"`
	DevMounts []evidenceDevMount `json:"devMounts"`
	Ownership struct {
		Bundle     evidenceOwnership `json:"bundle"`
		ConfigJSON evidenceOwnership `json:"configJson"`
		RealRunc   evidenceOwnership `json:"realRunc"`
		Rootfs     evidenceOwnership `json:"rootfs"`
	} `json:"ownership"`
	Qualification struct {
		Builder string `json:"builder"`
		Command string `json:"command"`
		Docker  string `json:"docker"`
		Runc    string `json:"runc"`
	} `json:"qualification"`
	RuncArgv []string `json:"runcArgvAfterExecutable"`
}

type evidenceNamespace struct {
	Keys        []string `json:"keys"`
	PathPresent bool     `json:"pathPresent"`
	Type        string   `json:"type"`
}

type evidenceDevMount struct {
	Destination string   `json:"destination"`
	Keys        []string `json:"keys"`
	Options     []string `json:"options"`
	Source      string   `json:"source"`
	Type        string   `json:"type"`
}

type evidenceOwnership struct {
	UID  int    `json:"uid"`
	GID  int    `json:"gid"`
	Mode string `json:"mode"`
}

func assertEvidenceMatchesQualifiedPolicy(t *testing.T, fixture envelopeEvidence, namespaceTypes []string, networkMode string) {
	t.Helper()
	if fixture.OCIVersion != qualifiedOCIVersion || !reflect.DeepEqual(fixture.TopLevel.Keys, []string{"hostname", "linux", "mounts", "ociVersion", "process", "root"}) || !reflect.DeepEqual(fixture.Process.Keys, []string{"args", "capabilities", "cwd", "env", "user"}) || !reflect.DeepEqual(fixture.Root.Keys, []string{"path"}) || fixture.Root.Readonly != nil || fixture.Root.Path != buildkitExecutorRoot+"/<executor-id>/rootfs" {
		t.Fatal("qualified top-level, process, or root shape differs from checked evidence")
	}
	if !reflect.DeepEqual(fixture.TopLevel.Kinds, map[string]string{"hostname": "string", "linux": "object", "mounts": "array", "ociVersion": "string", "process": "object", "root": "object"}) || !reflect.DeepEqual(fixture.TopLevel.Presence, map[string]bool{"annotations": false, "domainname": false, "hooks": false, "hostname": true, "linux": true, "mounts": true, "ociVersion": true, "process": true, "root": true, "solaris": false, "vm": false, "windows": false, "zos": false}) {
		t.Fatal("qualified top-level kinds differ from checked evidence")
	}
	for _, set := range []string{"bounding", "effective", "permitted"} {
		if !reflect.DeepEqual(fixture.Process.Capabilities[set], qualifiedCapabilities) {
			t.Fatalf("qualified capability set %s differs from checked evidence", set)
		}
	}
	if fixture.Process.ArgCount != 3 || len(fixture.Process.Args) != 3 || !reflect.DeepEqual(fixture.Process.Args[:2], []string{"/bin/sh", "-c"}) || fixture.Process.Cwd != "/workspace" || fixture.Process.User.UID != 1000 || fixture.Process.User.GID != 1000 || !reflect.DeepEqual(fixture.Process.User.AdditionalGIDs, []int{1000}) {
		t.Fatal("qualified process summary differs from checked evidence")
	}
	if !reflect.DeepEqual(fixture.Linux.Keys, []string{"maskedPaths", "namespaces", "readonlyPaths", "seccomp"}) || fixture.Linux.UIDMappings != nil || fixture.Linux.GIDMappings != nil || !reflect.DeepEqual(fixture.Linux.MaskedPaths, qualifiedMaskedPaths) || !reflect.DeepEqual(fixture.Linux.ReadonlyPaths, qualifiedReadonlyPaths) || len(fixture.Linux.Namespaces) != len(namespaceTypes) {
		t.Fatal("qualified Linux shape differs from checked evidence")
	}
	for index, namespace := range fixture.Linux.Namespaces {
		if namespace.PathPresent || !reflect.DeepEqual(namespace.Keys, []string{"type"}) || namespace.Type != namespaceTypes[index] {
			t.Fatalf("qualified namespace %d differs from checked evidence", index)
		}
	}
	if len(fixture.DevMounts) != len(qualifiedDevMounts) {
		t.Fatal("qualified /dev mount count differs from checked evidence")
	}
	for index, mount := range fixture.DevMounts {
		expected := qualifiedDevMounts[index]
		if !reflect.DeepEqual(mount.Keys, []string{"destination", "options", "source", "type"}) || mount.Destination != expected["destination"] || mount.Source != expected["source"] || mount.Type != expected["type"] || !reflect.DeepEqual(mount.Options, anySliceToStrings(expected["options"].([]any))) {
			t.Fatalf("qualified /dev mount %d differs from checked evidence", index)
		}
	}
	policy := productionPolicy()
	for name, values := range map[string]struct {
		observed evidenceOwnership
		uid      int
		gid      int
		mode     uint32
	}{
		"bundle": {fixture.Ownership.Bundle, policy.bundleUID, policy.bundleGID, policy.bundleMode},
		"config": {fixture.Ownership.ConfigJSON, policy.configUID, policy.configGID, policy.configMode},
		"rootfs": {fixture.Ownership.Rootfs, policy.rootfsUID, policy.rootfsGID, policy.rootfsMode},
		"runc":   {fixture.Ownership.RealRunc, 65534, 65534, 0o755},
	} {
		if values.observed.UID != values.uid || values.observed.GID != values.gid || values.observed.Mode != modeString(values.mode) {
			t.Fatalf("qualified %s metadata differs from checked evidence", name)
		}
	}
	if fixture.Qualification.Builder != "embedded-buildkit" || fixture.Qualification.Docker != "29.2.1" || fixture.Qualification.Runc != qualifiedRuncVersion || fixture.Qualification.Command != "docker build --pull=false --network="+networkMode+" --no-cache" || !reflect.DeepEqual(fixture.RuncArgv, []string{"--log", buildkitLogPath, "--log-format", "json", "run", "--bundle", buildkitExecutorRoot + "/<executor-id>", "--keep", "<executor-id>"}) {
		t.Fatal("qualified version, command, or runc argv differs from checked evidence")
	}
}

func assertExecutableFixtureRepresentsEvidence(t *testing.T, fixture envelopeEvidence, namespaceTypes []string) {
	t.Helper()
	spec := decodeObjectForTest(t, readConfigFixture(t))
	linux := spec["linux"].(map[string]any)
	if reflect.DeepEqual(namespaceTypes, qualifiedHostNetworkNamespaceTypes) {
		rawNamespaces := linux["namespaces"].([]any)
		namespaces := make([]any, 0, len(rawNamespaces)-1)
		for _, raw := range rawNamespaces {
			if raw.(map[string]any)["type"] != "network" {
				namespaces = append(namespaces, raw)
			}
		}
		linux["namespaces"] = namespaces
	}
	process := spec["process"].(map[string]any)
	root := spec["root"].(map[string]any)
	if spec["ociVersion"] != fixture.OCIVersion || !reflect.DeepEqual(sortedObjectKeys(spec), fixture.TopLevel.Keys) || !reflect.DeepEqual(sortedObjectKeys(process), fixture.Process.Keys) || process["cwd"] != fixture.Process.Cwd || root["path"] != syntheticBundlePath+"/rootfs" || !reflect.DeepEqual(sortedObjectKeys(root), fixture.Root.Keys) || !reflect.DeepEqual(sortedObjectKeys(linux), fixture.Linux.Keys) {
		t.Fatal("executable OCI fixture does not represent the checked structural shape")
	}
	actualNamespaces := make([]string, 0, len(namespaceTypes))
	for _, raw := range linux["namespaces"].([]any) {
		actualNamespaces = append(actualNamespaces, raw.(map[string]any)["type"].(string))
	}
	if !reflect.DeepEqual(actualNamespaces, namespaceTypes) || !reflect.DeepEqual(environmentNames(process["env"].([]any)), fixture.Process.EnvNames) {
		t.Fatal("executable OCI fixture namespaces or environment names differ from checked evidence")
	}
	input, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath); err != nil {
		t.Fatalf("executable fixture for checked namespace shape was rejected: %v", err)
	}
}

func sortedObjectKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func environmentNames(entries []any) []string {
	names := make([]string, len(entries))
	for index, raw := range entries {
		name, _, _ := strings.Cut(raw.(string), "=")
		names[index] = name
	}
	return names
}

func TestPatchOCIConfigInjectsExactTrustContract(t *testing.T) {
	input := readConfigFixture(t)
	output, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath)
	if err != nil {
		t.Fatal(err)
	}
	spec := decodeObjectForTest(t, output)
	process := spec["process"].(map[string]any)
	env := stringsForTest(t, process["env"])
	for _, expected := range injectedEnvironment {
		if countString(env, expected) != 1 {
			t.Fatalf("environment assignment %q count = %d", expected, countString(env, expected))
		}
	}
	mounts := spec["mounts"].([]any)
	for _, source := range productionTrustSources {
		mount := mountForDestination(t, mounts, source.Destination)
		if mount["source"] != source.Source || mount["type"] != "bind" {
			t.Fatalf("mount %s = %#v", source.Destination, mount)
		}
		if got := stringsForTest(t, mount["options"]); !equalStrings(got, []string{"rbind", "ro", "rprivate", "nosuid", "nodev", "noexec"}) {
			t.Fatalf("mount options = %#v", got)
		}
	}
	if bytes.Contains(output, []byte("ca-key")) {
		t.Fatal("patched config mentions a private key")
	}
}

func TestPatchOCIConfigIsIdempotent(t *testing.T) {
	first, err := patchOCIConfig(readConfigFixture(t), productionTrustSources, syntheticBundlePath)
	if err != nil {
		t.Fatal(err)
	}
	second, err := patchOCIConfig(first, productionTrustSources, syntheticBundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("second patch changed the config")
	}
}

func TestPatchOCIConfigAcceptsIdenticalExistingEntries(t *testing.T) {
	first, err := patchOCIConfig(readConfigFixture(t), productionTrustSources, syntheticBundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := patchOCIConfig(first, productionTrustSources, syntheticBundlePath); err != nil {
		t.Fatalf("identical entries rejected: %v", err)
	}
}

func TestPatchOCIConfigRejectsEnvironmentCollisions(t *testing.T) {
	tests := []string{
		`"env":["PATH=/usr/bin:/bin","SSL_CERT_FILE=/attacker"]`,
		`"env":["PATH=/usr/bin:/bin","PATH=/other"]`,
	}
	for _, replacement := range tests {
		input := replaceConfigEnv(t, replacement)
		if _, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath); err == nil {
			t.Fatalf("environment collision accepted: %s", replacement)
		}
	}
}

func TestPatchOCIConfigRejectsMountCollisions(t *testing.T) {
	input := readConfigFixture(t)
	injected := []byte(`,{"destination":"/dev/ironcurtain/ca-cert.pem","type":"bind","source":"/attacker","options":["rbind","ro","rprivate","nosuid","nodev","noexec"]}`)
	input = bytes.Replace(input, []byte("\n  ],\n  \"linux\""), append(injected, []byte("\n  ],\n  \"linux\"")...), 1)
	if _, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath); err == nil {
		t.Fatal("conflicting trust mount was accepted")
	}

	duplicateDev := bytes.Replace(readConfigFixture(t), []byte("\n  ],\n  \"linux\""), []byte(`,
    {"destination":"/dev","type":"tmpfs","source":"tmpfs","options":["nosuid","strictatime","mode=755","size=65536k"]}
  ],
  "linux"`), 1)
	if _, err := patchOCIConfig(duplicateDev, productionTrustSources, syntheticBundlePath); err == nil {
		t.Fatal("duplicate /dev mount was accepted")
	}
}

func TestPatchOCIConfigRejectsUnqualifiedDevAndNamespaces(t *testing.T) {
	tests := [][]byte{
		bytes.Replace(readConfigFixture(t), []byte(`"ociVersion": "1.3.0"`), []byte(`"ociVersion": "1.2.1"`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`"root": {`), []byte(`"root": { "unknown": true,`), 1),
		bytes.Replace(readConfigFixture(t), []byte(syntheticBundlePath+`/rootfs`), []byte(syntheticBundlePath+`/other`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`"size=65536k"`), []byte(`"size=1k"`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`{ "type": "pid" },`), nil, 1),
		bytes.Replace(readConfigFixture(t), []byte(`{ "type": "mount" }`), []byte(`{ "type": "unknown" }`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`{ "type": "mount" }`), []byte(`{ "type": "mount", "path": "/proc/1/ns/mnt" }`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`{ "type": "mount" }`), []byte(`{ "type": "mount", "unknown": true }`), 1),
		bytes.Replace(readConfigFixture(t), []byte(`{ "destination": "/proc", "type": "proc", "source": "proc" }`), []byte(`{ "destination": "/proc", "type": "proc", "source": "proc", "unknown": true }`), 1),
	}
	for _, input := range tests {
		if _, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath); err == nil {
			t.Fatal("unqualified envelope was accepted")
		}
	}
}

func TestPatchOCIConfigRejectsStrictJSONFailures(t *testing.T) {
	valid := readConfigFixture(t)
	tests := [][]byte{
		bytes.Replace(valid, []byte(`"ociVersion": "1.3.0"`), []byte(`"ociVersion":"1.3.0","ociVersion":"1.3.0"`), 1),
		append(append([]byte(nil), valid...), []byte(` {}`)...),
		append([]byte(`{"invalid":"`), 0xff, '"', '}'),
		bytes.Repeat([]byte(" "), maxConfigBytes+1),
	}
	for _, input := range tests {
		if _, err := patchOCIConfig(input, productionTrustSources, syntheticBundlePath); err == nil {
			t.Fatal("invalid JSON was accepted")
		}
	}
}

func readConfigFixture(t *testing.T) []byte {
	t.Helper()
	contents, err := os.ReadFile(testPackagePath("testdata/synthetic-buildkit-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func readEnvelopeEvidence(t *testing.T, name, expectedDigest string) envelopeEvidence {
	t.Helper()
	contents := readEvidenceBytes(t, name)
	requireEvidenceDigest(t, contents, expectedDigest)
	var fixture envelopeEvidence
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func readEvidenceBytes(t *testing.T, name string) []byte {
	t.Helper()
	contents, err := os.ReadFile(testPackagePath(filepath.Join("testdata", name)))
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func requireEvidenceDigest(t *testing.T, contents []byte, expected string) {
	t.Helper()
	digest := sha256.Sum256(contents)
	if actual := hex.EncodeToString(digest[:]); actual != expected {
		t.Fatalf("checked OCI evidence digest = %s, want %s", actual, expected)
	}
}

func modeString(mode uint32) string {
	return string([]byte{'0', byte('0' + mode/64%8), byte('0' + mode/8%8), byte('0' + mode%8)})
}

func replaceConfigEnv(t *testing.T, replacement string) []byte {
	t.Helper()
	spec := decodeObjectForTest(t, readConfigFixture(t))
	var fragment map[string]any
	if err := json.Unmarshal([]byte("{"+replacement+"}"), &fragment); err != nil {
		t.Fatal(err)
	}
	spec["process"].(map[string]any)["env"] = fragment["env"]
	contents, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func decodeObjectForTest(t *testing.T, input []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(input, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func stringsForTest(t *testing.T, raw any) []string {
	t.Helper()
	values, ok := raw.([]any)
	if !ok {
		t.Fatalf("value is not an array: %#v", raw)
	}
	result := make([]string, len(values))
	for index, value := range values {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("value is not a string: %#v", value)
		}
		result[index] = text
	}
	return result
}

func mountForDestination(t *testing.T, mounts []any, destination string) map[string]any {
	t.Helper()
	for _, raw := range mounts {
		mount := raw.(map[string]any)
		if mount["destination"] == destination {
			return mount
		}
	}
	t.Fatalf("mount %s not found", destination)
	return nil
}

func countString(values []string, expected string) int {
	count := 0
	for _, value := range values {
		if value == expected {
			count++
		}
	}
	return count
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
