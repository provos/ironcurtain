package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxConfigBytes  = 2 << 20
	maxJSONDepth    = 64
	maxObjectFields = 4096
	maxArrayItems   = 8192
	maxStringBytes  = 256 << 10
	maxEnvEntries   = 1024
	maxMounts       = 512
)

type trustSource struct {
	Source      string
	Destination string
	MaxBytes    int64
}

var productionTrustSources = []trustSource{
	{Source: "/opt/ironcurtain-build-trust/ca-cert.pem", Destination: "/dev/ironcurtain/ca-cert.pem", MaxBytes: 64 << 10},
	{Source: "/opt/ironcurtain-build-trust/ca-bundle.pem", Destination: "/dev/ironcurtain/ca-bundle.pem", MaxBytes: 2 << 20},
	{Source: "/opt/ironcurtain-build-trust/apt.conf", Destination: "/dev/ironcurtain/apt.conf", MaxBytes: 64 << 10},
}

var injectedEnvironment = []string{
	"NODE_EXTRA_CA_CERTS=/dev/ironcurtain/ca-cert.pem",
	"SSL_CERT_FILE=/dev/ironcurtain/ca-bundle.pem",
	"CURL_CA_BUNDLE=/dev/ironcurtain/ca-bundle.pem",
	"GIT_SSL_CAINFO=/dev/ironcurtain/ca-bundle.pem",
	"npm_config_cafile=/dev/ironcurtain/ca-bundle.pem",
	"PIP_CERT=/dev/ironcurtain/ca-bundle.pem",
	"REQUESTS_CA_BUNDLE=/dev/ironcurtain/ca-bundle.pem",
	"CARGO_HTTP_CAINFO=/dev/ironcurtain/ca-bundle.pem",
	"APT_CONFIG=/dev/ironcurtain/apt.conf",
	"npm_config_audit=false",
	"PIP_DISABLE_PIP_VERSION_CHECK=1",
	"UV_NATIVE_TLS=1",
}

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const qualifiedOCIVersion = "1.3.0"

var qualifiedCapabilities = []string{
	"CAP_CHOWN",
	"CAP_DAC_OVERRIDE",
	"CAP_FSETID",
	"CAP_FOWNER",
	"CAP_MKNOD",
	"CAP_NET_RAW",
	"CAP_SETGID",
	"CAP_SETUID",
	"CAP_SETFCAP",
	"CAP_SETPCAP",
	"CAP_NET_BIND_SERVICE",
	"CAP_SYS_CHROOT",
	"CAP_KILL",
	"CAP_AUDIT_WRITE",
}

var qualifiedNoNetworkNamespaceTypes = []string{"pid", "ipc", "uts", "mount", "network", "cgroup"}
var qualifiedHostNetworkNamespaceTypes = []string{"pid", "ipc", "uts", "mount", "cgroup"}

var qualifiedReadonlyPaths = []string{
	"/proc/bus",
	"/proc/fs",
	"/proc/irq",
	"/proc/sys",
	"/proc/sysrq-trigger",
}

var qualifiedMaskedPaths = []string{
	"/proc/acpi",
	"/proc/asound",
	"/proc/kcore",
	"/proc/keys",
	"/proc/latency_stats",
	"/proc/timer_list",
	"/proc/timer_stats",
	"/proc/sched_debug",
	"/sys/firmware",
	"/sys/devices/virtual/powercap",
	"/proc/scsi",
}

var qualifiedDevMounts = []map[string]any{
	{
		"destination": "/dev",
		"type":        "tmpfs",
		"source":      "tmpfs",
		"options":     stringSliceToAny([]string{"nosuid", "strictatime", "mode=755", "size=65536k"}),
	},
	{
		"destination": "/dev/pts",
		"type":        "devpts",
		"source":      "devpts",
		"options":     stringSliceToAny([]string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"}),
	},
	{
		"destination": "/dev/shm",
		"type":        "tmpfs",
		"source":      "shm",
		"options":     stringSliceToAny([]string{"nosuid", "noexec", "nodev", "mode=1777", "size=65536k"}),
	},
	{
		"destination": "/dev/mqueue",
		"type":        "mqueue",
		"source":      "mqueue",
		"options":     stringSliceToAny([]string{"nosuid", "noexec", "nodev"}),
	},
}

func patchOCIConfig(input []byte, sources []trustSource, bundlePath string) ([]byte, error) {
	spec, err := decodeQualifiedOCIConfig(input, bundlePath)
	if err != nil {
		return nil, withDiagnosticCode(diagnosticConfigStrictEnvelope, err)
	}
	output, err := patchQualifiedOCIConfig(spec, sources)
	return output, withDiagnosticCode(diagnosticConfigPatch, err)
}

func decodeQualifiedOCIConfig(input []byte, bundlePath string) (map[string]any, error) {
	if len(input) == 0 || len(input) > maxConfigBytes {
		return nil, fmt.Errorf("config size %d is outside bounds", len(input))
	}
	if !utf8.Valid(input) {
		return nil, errors.New("config is not valid UTF-8")
	}
	value, err := decodeStrictJSON(input)
	if err != nil {
		return nil, fmt.Errorf("strict config decode: %w", err)
	}
	spec, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("config root must be an object")
	}
	if err := validateSpecEnvelope(spec, bundlePath); err != nil {
		return nil, err
	}
	return spec, nil
}

func patchQualifiedOCIConfig(spec map[string]any, sources []trustSource) ([]byte, error) {
	process, err := requiredObject(spec, "process")
	if err != nil {
		return nil, err
	}
	if err := injectEnvironment(process); err != nil {
		return nil, err
	}
	if err := injectMounts(spec, sources); err != nil {
		return nil, err
	}
	output, err := json.Marshal(spec)
	if err != nil {
		return nil, fmt.Errorf("encode patched config: %w", err)
	}
	if len(output) > maxConfigBytes {
		return nil, errors.New("patched config exceeds size bound")
	}
	return append(output, '\n'), nil
}

func decodeStrictJSON(input []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	value, err := decodeJSONValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON token %v", token)
		}
		return nil, fmt.Errorf("trailing JSON: %w", err)
	}
	return value, nil
}

func decodeJSONValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > maxJSONDepth {
		return nil, errors.New("JSON nesting exceeds bound")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		if text, ok := token.(string); ok && len(text) > maxStringBytes {
			return nil, errors.New("JSON string exceeds bound")
		}
		return token, nil
	}
	switch delim {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			if len(object) >= maxObjectFields {
				return nil, errors.New("JSON object field count exceeds bound")
			}
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok || len(key) > maxStringBytes {
				return nil, errors.New("invalid JSON object key")
			}
			if _, exists := object[key]; exists {
				return nil, fmt.Errorf("duplicate JSON key %q", key)
			}
			child, err := decodeJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = child
		}
		if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
			return nil, errors.New("unterminated JSON object")
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			if len(array) >= maxArrayItems {
				return nil, errors.New("JSON array length exceeds bound")
			}
			child, err := decodeJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, child)
		}
		if token, err := decoder.Token(); err != nil || token != json.Delim(']') {
			return nil, errors.New("unterminated JSON array")
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
}

func validateSpecEnvelope(spec map[string]any, bundlePath string) error {
	if !hasExactKeys(spec, "hostname", "linux", "mounts", "ociVersion", "process", "root") {
		return errors.New("config has an unsupported top-level shape")
	}
	version, ok := spec["ociVersion"].(string)
	if !ok || version != qualifiedOCIVersion {
		return errors.New("config has invalid ociVersion")
	}
	hostname, ok := spec["hostname"].(string)
	if !ok || hostname == "" || len(hostname) > 255 || strings.ContainsRune(hostname, 0) {
		return errors.New("config has an invalid hostname")
	}
	process, err := requiredObject(spec, "process")
	if err != nil {
		return err
	}
	if !hasExactKeys(process, "args", "capabilities", "cwd", "env", "user") {
		return errors.New("BuildKit process has an unsupported shape")
	}
	args, err := requiredArray(process, "args")
	if err != nil || len(args) == 0 || len(args) > 4096 {
		return errors.New("config process.args is outside bounds")
	}
	for _, arg := range args {
		text, ok := arg.(string)
		if !ok || len(text) > maxStringBytes || strings.ContainsRune(text, 0) {
			return errors.New("config process.args contains an invalid entry")
		}
	}
	if cwd, ok := process["cwd"].(string); !ok || !strings.HasPrefix(cwd, "/") || path.Clean(cwd) != cwd || len(cwd) > 4096 || strings.ContainsRune(cwd, 0) {
		return errors.New("config process.cwd must be a bounded absolute path")
	}
	capabilities, err := requiredObject(process, "capabilities")
	if err != nil || !hasExactKeys(capabilities, "bounding", "effective", "permitted") {
		return errors.New("BuildKit capabilities have an unsupported shape")
	}
	for _, set := range []string{"bounding", "effective", "permitted"} {
		if !exactStringArray(capabilities[set], qualifiedCapabilities) {
			return fmt.Errorf("BuildKit capability set %s is not qualified", set)
		}
	}
	user, err := requiredObject(process, "user")
	if err != nil || !hasExactKeys(user, "additionalGids", "gid", "uid") {
		return errors.New("BuildKit process.user has an unsupported shape")
	}
	for _, key := range []string{"uid", "gid"} {
		if _, err := exactNonNegativeInteger(user[key], 1<<31-1); err != nil {
			return fmt.Errorf("BuildKit process.user.%s is invalid", key)
		}
	}
	additionalGIDs, err := requiredArray(user, "additionalGids")
	if err != nil || len(additionalGIDs) > 256 {
		return errors.New("BuildKit process.user.additionalGids is invalid")
	}
	for _, gid := range additionalGIDs {
		if _, err := exactNonNegativeInteger(gid, 1<<31-1); err != nil {
			return errors.New("BuildKit process.user.additionalGids contains an invalid gid")
		}
	}
	root, err := requiredObject(spec, "root")
	if err != nil {
		return err
	}
	if !hasExactKeys(root, "path") {
		return errors.New("BuildKit root contains an unsupported key")
	}
	if !path.IsAbs(bundlePath) || path.Clean(bundlePath) != bundlePath || !buildkitIDPattern.MatchString(path.Base(bundlePath)) {
		return errors.New("BuildKit bundle path is not canonical")
	}
	expectedRootfs := bundlePath + "/rootfs"
	if rootPath, ok := root["path"].(string); !ok || rootPath != expectedRootfs {
		return errors.New("BuildKit root.path is not the canonical bundle rootfs")
	}
	linux, err := requiredObject(spec, "linux")
	if err != nil {
		return err
	}
	if !hasExactKeys(linux, "maskedPaths", "namespaces", "readonlyPaths", "seccomp") {
		return errors.New("BuildKit linux config has an unsupported shape")
	}
	namespaces, err := requiredArray(linux, "namespaces")
	if err != nil || !matchesQualifiedNamespaceShape(namespaces) {
		return errors.New("config linux.namespaces is outside the qualified shape")
	}
	if !exactStringArray(linux["readonlyPaths"], qualifiedReadonlyPaths) || !exactStringArray(linux["maskedPaths"], qualifiedMaskedPaths) {
		return errors.New("BuildKit masked or read-only paths are not qualified")
	}
	if _, ok := linux["seccomp"].(map[string]any); !ok {
		return errors.New("BuildKit seccomp profile is missing or malformed")
	}
	return nil
}

func matchesQualifiedNamespaceShape(namespaces []any) bool {
	for _, expected := range [][]string{qualifiedNoNetworkNamespaceTypes, qualifiedHostNetworkNamespaceTypes} {
		if len(namespaces) != len(expected) {
			continue
		}
		matches := true
		for index, raw := range namespaces {
			namespace, ok := raw.(map[string]any)
			if !ok || !hasExactKeys(namespace, "type") || namespace["type"] != expected[index] {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}

func injectEnvironment(process map[string]any) error {
	env, err := requiredArray(process, "env")
	if err != nil || len(env) > maxEnvEntries {
		return errors.New("config process.env is outside bounds")
	}
	seen := make(map[string]string, len(env))
	for _, raw := range env {
		entry, ok := raw.(string)
		if !ok || len(entry) > maxStringBytes {
			return errors.New("config process.env contains an invalid entry")
		}
		name, value, found := strings.Cut(entry, "=")
		if !found || !envNamePattern.MatchString(name) || strings.ContainsRune(value, 0) {
			return errors.New("config process.env contains a malformed assignment")
		}
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("config process.env duplicates %s", name)
		}
		seen[name] = value
	}
	for _, assignment := range injectedEnvironment {
		name, value, _ := strings.Cut(assignment, "=")
		if existing, found := seen[name]; found {
			if existing != value {
				return fmt.Errorf("config process.env conflicts with required %s", name)
			}
			continue
		}
		if len(env) >= maxEnvEntries {
			return errors.New("injected process.env would exceed bounds")
		}
		env = append(env, assignment)
		seen[name] = value
	}
	process["env"] = env
	return nil
}

func injectMounts(spec map[string]any, sources []trustSource) error {
	mounts, err := requiredArray(spec, "mounts")
	if err != nil || len(mounts) > maxMounts {
		return errors.New("config mounts is outside bounds")
	}
	destinations := make(map[string]map[string]any, len(mounts))
	for _, raw := range mounts {
		mount, ok := raw.(map[string]any)
		if !ok {
			return errors.New("config contains a malformed mount")
		}
		if !hasOnlyKeys(mount, "destination", "type", "source", "options", "uidMappings", "gidMappings") {
			return errors.New("config mount contains an unsupported key")
		}
		destination, ok := mount["destination"].(string)
		if !ok || !strings.HasPrefix(destination, "/") || path.Clean(destination) != destination || len(destination) > 4096 || strings.ContainsRune(destination, 0) {
			return errors.New("config contains an invalid mount destination")
		}
		if mountType, ok := mount["type"].(string); !ok || mountType == "" || len(mountType) > 128 {
			return errors.New("config contains an invalid mount type")
		}
		if source, ok := mount["source"].(string); !ok || len(source) > 4096 || strings.ContainsRune(source, 0) {
			return errors.New("config contains an invalid mount source")
		}
		if options, found := mount["options"]; found {
			values, ok := options.([]any)
			if !ok || len(values) > 128 {
				return errors.New("config contains invalid mount options")
			}
			for _, rawOption := range values {
				option, ok := rawOption.(string)
				if !ok || option == "" || len(option) > 4096 || strings.ContainsRune(option, 0) {
					return errors.New("config contains an invalid mount option")
				}
			}
		}
		if _, duplicate := destinations[destination]; duplicate {
			return fmt.Errorf("config duplicates mount destination %s", destination)
		}
		destinations[destination] = mount
	}
	for _, expected := range qualifiedDevMounts {
		destination := expected["destination"].(string)
		actual, ok := destinations[destination]
		if !ok || !exactMount(actual, expected) {
			return fmt.Errorf("config does not contain the qualified %s mount", destination)
		}
	}
	for _, source := range sources {
		expected := map[string]any{
			"destination": source.Destination,
			"type":        "bind",
			"source":      source.Source,
			"options":     stringSliceToAny([]string{"rbind", "ro", "rprivate", "nosuid", "nodev", "noexec"}),
		}
		if existing, found := destinations[source.Destination]; found {
			if !exactMount(existing, expected) {
				return fmt.Errorf("config mount conflicts at %s", source.Destination)
			}
			continue
		}
		if len(mounts) >= maxMounts {
			return errors.New("injected mounts would exceed bounds")
		}
		mounts = append(mounts, expected)
		destinations[source.Destination] = expected
	}
	spec["mounts"] = mounts
	return nil
}

func requiredObject(object map[string]any, key string) (map[string]any, error) {
	value, ok := object[key].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("config %s must be an object", key)
	}
	return value, nil
}

func requiredArray(object map[string]any, key string) ([]any, error) {
	value, ok := object[key].([]any)
	if !ok {
		return nil, fmt.Errorf("config %s must be an array", key)
	}
	return value, nil
}

func exactString(object map[string]any, key, expected string) bool {
	actual, ok := object[key].(string)
	return ok && actual == expected
}

func exactStringArray(raw any, expected []string) bool {
	actual, ok := raw.([]any)
	if !ok || len(actual) != len(expected) {
		return false
	}
	for index, value := range actual {
		if value != expected[index] {
			return false
		}
	}
	return true
}

func exactMount(actual, expected map[string]any) bool {
	if len(actual) != len(expected) {
		return false
	}
	return exactString(actual, "destination", expected["destination"].(string)) &&
		exactString(actual, "type", expected["type"].(string)) &&
		exactString(actual, "source", expected["source"].(string)) &&
		exactStringArray(actual["options"], anySliceToStrings(expected["options"].([]any)))
}

func stringSliceToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func anySliceToStrings(values []any) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = value.(string)
	}
	return result
}
