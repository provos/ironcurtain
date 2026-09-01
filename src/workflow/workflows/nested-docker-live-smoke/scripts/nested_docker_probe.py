#!/usr/bin/env python3
"""Deterministic nested-Docker acceptance executed inside a workflow container."""

from __future__ import annotations

import base64
import errno
import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Literal, Sequence


WORKSPACE = Path("/workspace")
TASK_PATH = WORKSPACE / ".workflow" / "task" / "description.md"
RESULT_PATH = WORKSPACE / ".workflow" / "nested-docker-result.json"
FIXTURE_DIR = Path("/workflow-scripts/fixtures/package-build")

PUBLIC_IMAGES = (
    "node:22-bookworm-slim",
    "python:3.13-slim-bookworm",
    "rust:1.85-slim-bookworm",
)
PRIMARY_PUBLIC_IMAGE = PUBLIC_IMAGES[0]
DENIED_IMAGE = "example.invalid/ironcurtain/denied:latest"
EXPECTED_NETWORK = "ironcurtain"
EXPECTED_DOCKER_HOST = "unix:///run/ironcurtain-docker/docker.sock"
DAEMON_DATA_ROOT = Path("/home/codespace/.local/share/docker")

REGISTRY_SOCKET = Path("/tmp/ironcurtain-registry-egress.sock")
PACKAGE_SOCKET = Path("/tmp/ironcurtain-package-egress.sock")
REGISTRY_PROXY = "http://127.0.0.1:18081"
PACKAGE_PROXY = "http://127.0.0.1:18082"
OUTER_RELAY_REFUSAL_TIMEOUT_SECONDS = 3
HOST_RELAY_PROBE_TIMEOUT_SECONDS = 30
HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS = 5
HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS = 60
HOST_PACKAGE_CONNECT_EXIT_OUTCOMES = {
    0: "exact-eof",
    70: "dial-failure",
    71: "send-failure",
    72: "timeout-empty",
    73: "timeout-partial",
    74: "exact-bytes-no-eof",
    75: "transport-reset",
    76: "overflow",
    77: "clean-nonexact-eof",
    78: "unexpected-internal",
}
OUTER_PACKAGE_RESPONSE_LIMIT = 512 * 1024
PACKAGE_SHIM = Path("/usr/local/sbin/docker")
PACKAGE_RUNC = Path("/usr/local/sbin/runc")
REAL_RUNC = Path("/usr/local/lib/ironcurtain-docker/bin/runc")
PACKAGE_CONFIG = Path("/run/ironcurtain-package-build/client/config.json")
PACKAGE_BUILDX_STATE = Path("/run/ironcurtain-package-build/buildx")
PACKAGE_CONTRACT_PARENT = Path("/opt/ironcurtain-build-trust")
PACKAGE_CONTRACT = Path("/opt/ironcurtain-build-trust/build-trust-contract.json")
PACKAGE_APT_CONFIG = Path("/opt/ironcurtain-build-trust/apt.conf")
AGENT_CA_CERT = Path("/opt/ironcurtain-build-trust/ca-cert.pem")
AGENT_CA_BUNDLE = Path("/opt/ironcurtain-build-trust/ca-bundle.pem")
PACKAGE_RUNC_SHA256 = "34be777c92032e4bb63f7c467e396e0b9c35d4bf981f3b54a434d09b608c370d"
REAL_RUNC_SHA256 = "f0ed2d355945fe2697f11f89773e07b48de0ef239962c4a0e0ae900161a23b12"
REAL_RUNC_SIZE = 16_641_104

IMMUTABLE_ID = re.compile(r"sha256:[a-f0-9]{64}")
CONTAINER_ID = re.compile(r"[a-f0-9]{64}")
SELECTED_LOCAL_REFERENCE = re.compile(
    r"(?=.{1,255}\Z)"
    r"[a-z0-9]+(?:[._-]+[a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*:"
    r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}"
)
CONNECTIVITY_FAILURE = re.compile(
    r"no such host|network is unreachable|connection refused|timed? out|i/o timeout|"
    r"context deadline|fetch failed|enotfound|eai_again|etimedout",
    re.IGNORECASE,
)
POLICY_DENIAL = re.compile(r"(?:\b403\b|forbidden)", re.IGNORECASE)
BUILD_NETWORK_ABSENCE = re.compile(r"network bridge not found", re.IGNORECASE)

HOST_RELAY_SPECS = (
    (18081, "/__ironcurtain/health", "IRONCURTAIN_OK/1\n"),
    (
        18082,
        "/__ironcurtain/package-egress/health",
        "IRONCURTAIN_PACKAGE_EGRESS_OK/1\n",
    ),
)
HOST_RELAY_PROBE_SCRIPT = r"""
import errno
import json
import socket
import sys

MAX_RESPONSE = 64 * 1024


def decode_chunked(encoded):
    decoded = bytearray()
    cursor = 0
    while True:
        line_end = encoded.find(b"\r\n", cursor)
        if line_end < 0:
            raise ValueError("missing chunk-size delimiter")
        size_line = encoded[cursor:line_end]
        if (
            not size_line
            or any(byte not in b"0123456789abcdefABCDEF" for byte in size_line)
            or (len(size_line) > 1 and size_line.startswith(b"0"))
        ):
            raise ValueError("noncanonical chunk size")
        size = int(size_line, 16)
        cursor = line_end + 2
        if size == 0:
            if encoded[cursor:] != b"\r\n":
                raise ValueError("chunked response has trailers or residue")
            return bytes(decoded)
        if size > MAX_RESPONSE - len(decoded):
            raise ValueError("decoded body exceeds bound")
        chunk_end = cursor + size
        if chunk_end + 2 > len(encoded):
            raise ValueError("truncated chunk")
        if encoded[chunk_end : chunk_end + 2] != b"\r\n":
            raise ValueError("missing chunk delimiter")
        decoded.extend(encoded[cursor:chunk_end])
        cursor = chunk_end + 2


def parse_http_response(response):
    if len(response) > MAX_RESPONSE:
        raise ValueError("response exceeds bound")
    headers, separator, encoded_body = response.partition(b"\r\n\r\n")
    if not separator or not headers:
        raise ValueError("incomplete headers")
    lines = headers.split(b"\r\n")
    status = lines[0].decode("ascii", "strict")
    if not status.startswith("HTTP/1.1 "):
        raise ValueError("unsupported status line")
    framing = {}
    for line in lines[1:]:
        if any((byte < 32 and byte != 9) or byte == 127 for byte in line):
            raise ValueError("control byte in header")
        name, separator, value = line.partition(b":")
        if not separator or not name.strip():
            raise ValueError("malformed header")
        lowered = name.strip().lower()
        if lowered in {b"content-length", b"transfer-encoding", b"connection"}:
            if lowered in framing:
                raise ValueError("duplicate framing header")
            framing[lowered] = value.strip().lower()
    if framing.get(b"connection") != b"close":
        raise ValueError("response does not require connection close")
    content_length = framing.get(b"content-length")
    transfer_encoding = framing.get(b"transfer-encoding")
    if content_length is not None and transfer_encoding is not None:
        raise ValueError("ambiguous response framing")
    if transfer_encoding is not None:
        if transfer_encoding != b"chunked":
            raise ValueError("unsupported transfer encoding")
        return status, decode_chunked(encoded_body)
    if content_length is None:
        raise ValueError("identity response lacks content length")
    if (
        not content_length
        or any(byte not in b"0123456789" for byte in content_length)
        or (len(content_length) > 1 and content_length.startswith(b"0"))
    ):
        raise ValueError("noncanonical content length")
    expected_length = int(content_length)
    if expected_length > MAX_RESPONSE or len(encoded_body) != expected_length:
        raise ValueError("content length mismatch")
    return status, encoded_body


def response_observation(port, marker, status, body):
    decoded_body = body.decode("ascii", "strict")
    return {
        "body": decoded_body,
        "outcome": (
            "response"
            if status == "HTTP/1.1 200 OK" and decoded_body == marker
            else "wrong-response"
        ),
        "port": port,
        "status": status,
    }


def probe(port, path, marker):
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(3)
    try:
        try:
            connection.connect(("127.0.0.1", port))
        except ConnectionRefusedError:
            return {"outcome": "refused", "port": port}
        except socket.timeout:
            return {"outcome": "timeout", "port": port}
        except OSError as error:
            if error.errno == errno.ECONNREFUSED:
                return {"outcome": "refused", "port": port}
            return {"errno": error.errno, "outcome": "error", "port": port}
        request = (
            f"GET http://ironcurtain.invalid{path} HTTP/1.1\r\n"
            "Host: ironcurtain.invalid\r\nConnection: close\r\n\r\n"
        ).encode("ascii")
        connection.sendall(request)
        response = b""
        while True:
            chunk = connection.recv(min(4096, MAX_RESPONSE + 1 - len(response)))
            if not chunk:
                break
            response += chunk
            if len(response) > MAX_RESPONSE:
                return {"outcome": "malformed", "port": port}
        status, body = parse_http_response(response)
        return response_observation(port, marker, status, body)
    except socket.timeout:
        return {"outcome": "timeout", "port": port}
    except (UnicodeError, ValueError):
        return {"outcome": "malformed", "port": port}
    except OSError as error:
        return {"errno": getattr(error, "errno", None), "outcome": "error", "port": port}
    finally:
        connection.close()


if __name__ == "__main__":
    specs = json.loads(sys.argv[1])
    print(
        json.dumps(
            [probe(port, path, marker) for port, path, marker in specs],
            separators=(",", ":"),
            sort_keys=True,
        )
    )
""".strip()

HOST_PACKAGE_CONNECT_DENIAL_SCRIPT = r"""
import socket
import sys
import time

MAX_RESPONSE = 64 * 1024
SOCKET_TIMEOUT_SECONDS = 5
EXIT_EXACT_EOF = 0
EXIT_DIAL_FAILURE = 70
EXIT_SEND_FAILURE = 71
EXIT_TIMEOUT_EMPTY = 72
EXIT_TIMEOUT_PARTIAL = 73
EXIT_EXACT_BYTES_NO_EOF = 74
EXIT_TRANSPORT_RESET = 75
EXIT_OVERFLOW = 76
EXIT_CLEAN_NONEXACT_EOF = 77
EXIT_UNEXPECTED_INTERNAL = 78
REQUEST = b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"
EXPECTED_RESPONSE = (
    b"HTTP/1.1 403 package egress CONNECT authority is not a fixed package host on port 443\r\n"
    b"Connection: close\r\n"
    b"Content-Length: 0\r\n\r\n"
)


def remaining_seconds(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise socket.timeout("absolute network deadline elapsed")
    return remaining


def timeout_outcome(response):
    if not response:
        return EXIT_TIMEOUT_EMPTY
    if bytes(response) == EXPECTED_RESPONSE:
        return EXIT_EXACT_BYTES_NO_EOF
    return EXIT_TIMEOUT_PARTIAL


def read_connect_denial_outcome(connection, deadline):
    response = bytearray()
    while True:
        try:
            connection.settimeout(remaining_seconds(deadline))
            chunk = connection.recv(min(4096, MAX_RESPONSE + 1 - len(response)))
        except socket.timeout:
            return timeout_outcome(response)
        except OSError:
            return EXIT_TRANSPORT_RESET
        if not chunk:
            return (
                EXIT_EXACT_EOF
                if bytes(response) == EXPECTED_RESPONSE
                else EXIT_CLEAN_NONEXACT_EOF
            )
        response.extend(chunk)
        if len(response) > MAX_RESPONSE:
            return EXIT_OVERFLOW


def main():
    deadline = time.monotonic() + SOCKET_TIMEOUT_SECONDS
    try:
        connection = socket.create_connection(
            ("127.0.0.1", 18082), timeout=remaining_seconds(deadline)
        )
    except OSError:
        return EXIT_DIAL_FAILURE
    try:
        try:
            connection.settimeout(remaining_seconds(deadline))
        except OSError:
            return EXIT_DIAL_FAILURE
        try:
            connection.sendall(REQUEST)
        except OSError:
            return EXIT_SEND_FAILURE
        return read_connect_denial_outcome(connection, deadline)
    finally:
        try:
            connection.close()
        except OSError:
            pass


def guarded_main():
    try:
        return main()
    except Exception:
        return EXIT_UNEXPECTED_INTERNAL


if __name__ == "__main__":
    sys.exit(guarded_main())
""".strip()

PACKAGE_BUILD_FORMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("image-build", ("image", "build")),
    ("builder-build", ("builder", "build")),
    ("buildx-build", ("buildx", "build", "--load")),
)
PACKAGE_IMAGE_PULL_TIMEOUT_SECONDS = 180
PACKAGE_NETWORK_BUILD_TIMEOUT_SECONDS = 900
PACKAGE_FORM_BUILD_TIMEOUT_SECONDS = 90
PACKAGE_CACHE_BUILD_TIMEOUT_SECONDS = 180
PACKAGE_DIRECT_DENIAL_BUILD_TIMEOUT_SECONDS = 90
PACKAGE_IMAGE_SCAN_TIMEOUT_SECONDS = 300
PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS = 300
SNAPSHOT_SCAN_PREFLIGHT_COMMAND_TIMEOUT_SECONDS = 5
PACKAGE_SNAPSHOT_SCAN_PREFLIGHT_TIMEOUT_SECONDS = (
    2 * SNAPSHOT_SCAN_PREFLIGHT_COMMAND_TIMEOUT_SECONDS
)
PRIVILEGED_SNAPSHOT_SCAN_TIMEOUT_SECONDS = PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS + 15
PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT = 128
PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT = 256
SNAPSHOT_SCAN_HOSTNAME = re.compile(r"ic-dw-agent-[a-f0-9]{16}")
SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_OUTPUT_LIMIT = 4096
SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_AGGREGATE_OUTPUT_LIMIT = 8192
SNAPSHOT_SCAN_SAFE_OUTPUT = re.compile(rb"[\x09\x0a\x20-\x7e]+")
CANONICAL_EMPTY_LAYER_DIFF_ID = (
    "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef"
)
CANONICAL_EMPTY_LAYER_SIZE = 1024
MAX_SAVED_IMAGE_METADATA_BYTES = 1024 * 1024
MAX_RESIDUE_SCAN_BYTES = 4 * 1024 * 1024 * 1024
# VFS stores a complete rootfs snapshot for every layer. The retained qualified
# selected image alone replays to 85,986,117,228 logical bytes and 1,489,147
# entries, so snapshot traversal needs independent finite capacity ceilings.
MAX_SNAPSHOT_SCAN_LOGICAL_BYTES = 256 * 1024 * 1024 * 1024
MAX_SNAPSHOT_SCAN_ENTRIES = 4_000_000
MAX_SNAPSHOT_DIRECTORY_DEPTH = 256
MAX_BUILDKIT_SNAPSHOT_METADATA_BYTES = 64 * 1024 * 1024
# Docker 29.2.1 embeds BuildKit 0.27.1. Its runc executor removes each bundle
# after Run and leaves only these fixed top-level files in the supported modes.
BUILDKIT_EXECUTOR_ARTIFACT_LIMITS = {
    "hosts": 64 * 1024,
    "resolv.conf": 64 * 1024,
    "resolv-host.conf": 64 * 1024,
    "runc-log.json": 1024 * 1024,
}
# Keep the qualification candidate ceiling aligned with ca.ts MAX_CA_FILE_BYTES.
MAX_PRIVATE_KEY_PEM_BYTES = 128 * 1024
MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN = 256
MAX_PUBLIC_SPKI_PEM_BYTES = 16 * 1024
MAX_FORM_CHECK_SCRIPT_BYTES = 64 * 1024
MAX_LINK_TARGET_BYTES = 4096
PRIVATE_KEY_PARSE_TIMEOUT_SECONDS = 2
PRIVATE_KEY_PEM_BOUNDARIES = (
    (b"-----BEGIN PRIVATE KEY-----", b"-----END PRIVATE KEY-----"),
    (b"-----BEGIN RSA PRIVATE KEY-----", b"-----END RSA PRIVATE KEY-----"),
)
PACKAGE_CRITICAL_OPERATION_BUDGET_SECONDS = (
    len(PUBLIC_IMAGES) * PACKAGE_IMAGE_PULL_TIMEOUT_SECONDS
    + PACKAGE_NETWORK_BUILD_TIMEOUT_SECONDS
    + len(PACKAGE_BUILD_FORMS) * PACKAGE_FORM_BUILD_TIMEOUT_SECONDS
    + PACKAGE_CACHE_BUILD_TIMEOUT_SECONDS
    + PACKAGE_DIRECT_DENIAL_BUILD_TIMEOUT_SECONDS
    + HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS
    + PACKAGE_IMAGE_SCAN_TIMEOUT_SECONDS
    + PACKAGE_SNAPSHOT_SCAN_PREFLIGHT_TIMEOUT_SECONDS
    + PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS
)
PACKAGE_WORKFLOW_RESERVE_SECONDS = 27 * 60
HttpRequestMethod = Literal["CONNECT", "GET", "HEAD", "POST"]
SnapshotRootClass = Literal["vfs"]
DaemonIdentity = tuple[str, str, str, tuple[str, ...]]
SNAPSHOT_ENTRY_PHASES = (
    "root-open",
    "enumerate",
    "metadata",
    "directory-open",
    "directory-close",
    "symlink-read",
    "file-pin",
    "file-open",
    "file-read",
    "file-close",
)
SNAPSHOT_ERRNO_CLASSES = ("eacces", "enoent", "estale", "other")

INTERNAL_SNAPSHOT_SCAN_ARG = "--internal-snapshot-scan-v1"
INTERNAL_SNAPSHOT_SCAN_BEGIN = "IRONCURTAIN_SNAPSHOT_SCAN_BEGIN/1"
INTERNAL_SNAPSHOT_SCAN_SUCCESS = "IRONCURTAIN_SNAPSHOT_SCAN_OK/1"
INTERNAL_SNAPSHOT_SCAN_ERROR = "IRONCURTAIN_SNAPSHOT_SCAN_ERROR/1"
INTERNAL_SNAPSHOT_SCAN_COMMAND = (
    "/usr/bin/sudo",
    "-n",
    "--",
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LC_ALL=C",
    "/usr/bin/python3",
    "-I",
    "-B",
    "/workflow-scripts/nested_docker_probe.py",
    INTERNAL_SNAPSHOT_SCAN_ARG,
)
SNAPSHOT_SCAN_FAILURE_CODES = frozenset(
    {
        "snapshot-scan:argv",
        "snapshot-scan:euid",
        "snapshot-scan:authority-input",
        "snapshot-scan:capability",
        "snapshot-scan:entry-name",
        "snapshot-scan:special-entry",
        "snapshot-scan:timeout",
        "snapshot-scan:archive-byte-bound",
        "snapshot-scan:logical-byte-bound",
        "snapshot-scan:entry-bound",
        "snapshot-scan:depth-bound",
        "snapshot-scan:pem-candidate-bound",
        "snapshot-scan:link",
        "snapshot-scan:pem-parser",
        "snapshot-scan:residue",
        "snapshot-scan:unstable",
        "snapshot-scan:internal",
        *(
            f"snapshot-entry:{phase}:{errno_class}"
            for phase in SNAPSHOT_ENTRY_PHASES
            for errno_class in SNAPSHOT_ERRNO_CLASSES
        ),
        *(
            f"snapshot-root:vfs:{failure_class}"
            for failure_class in ("missing", "inspect", "symlink", "type", "empty")
        ),
        *(
            f"snapshot-root:buildkit:{failure_class}"
            for failure_class in ("missing", "inspect", "symlink", "type")
        ),
        "buildkit-layout:snapshots-inspect",
        "buildkit-layout:snapshots-present",
        *(
            f"buildkit-metadata:{failure_class}"
            for failure_class in (
                "missing",
                "inspect",
                "symlink",
                "type",
                "links",
                "empty",
                "bounds",
                "unstable",
            )
        ),
        *(
            f"buildkit-executor:{failure_class}"
            for failure_class in (
                "missing",
                "inspect",
                "symlink",
                "type",
                "entry",
            )
        ),
        *(
            f"buildkit-executor:artifact:{failure_class}"
            for failure_class in (
                "missing",
                "inspect",
                "symlink",
                "type",
                "links",
                "empty",
                "bounds",
                "unstable",
            )
        ),
    }
)

COMMON_CHECK_IDS = (
    "common.endpoint",
    "common.daemon-profile",
    "common.managed-network",
    "common.fresh-inventory",
)
FINAL_CHECK_IDS = (
    "cleanup.tracked-ids",
    "cleanup.initial-image-inventory",
    "cleanup.empty-container-network",
)
MODE_CHECK_IDS: dict[str, tuple[str, ...]] = {
    "packages": (
        "packages.outer-tcp-absent",
        "packages.host-relay-matrix",
        "packages.relay-probe-inventory",
        "packages.artifacts",
        "packages.registry-pulls",
        "packages.registry-denial",
        "packages.authoritative-build",
        "packages.exact-results",
        "packages.sibling-network",
        "packages.compose-denial",
        "packages.selector-denials",
        "packages.direct-route-denial",
        "packages.outer-package-request",
        "packages.policy-denials",
        "packages.host-child-scope",
        "packages.supported-build-forms",
        "packages.cached-repeat",
        "packages.image-residue",
        "packages.snapshot-preflight",
        "packages.snapshot-residue",
    ),
    "images": (
        "images.outer-tcp-absent",
        "images.host-relay-matrix",
        "images.relay-probe-inventory",
        "images.artifacts",
        "images.registry-pull",
        "images.registry-denial",
        "images.package-build-denied",
    ),
    "offline": (
        "offline.outer-tcp-absent",
        "offline.host-relay-matrix",
        "offline.relay-probe-inventory",
        "offline.artifacts",
        "offline.registry-pull-denied",
        "offline.package-build-denied",
        "offline.hermetic-build",
    ),
    "admission": (
        "admission.outer-tcp-absent",
        "admission.host-relay-matrix",
        "admission.relay-probe-inventory",
        "admission.artifacts",
        "admission.fresh-state",
    ),
}


class ProbeFailure(RuntimeError):
    pass


@dataclass
class PrivateKeyScanBudget:
    remaining_candidates: int
    deadline: float


def form_check_run_command() -> str:
    try:
        script = (FIXTURE_DIR / "form-check.sh").read_bytes()
    except OSError:
        raise ProbeFailure("form-check fixture is unavailable") from None
    if (
        not script.startswith(b"#!/bin/sh\n")
        or len(script) == 0
        or len(script) > MAX_FORM_CHECK_SCRIPT_BYTES
    ):
        raise ProbeFailure("form-check fixture is outside its exact byte contract")
    encoded = base64.b64encode(script).decode("ascii", "strict")
    return f"RUN printf '%s' '{encoded}' | /usr/bin/base64 --decode | /bin/sh"


def expected_check_ids(mode: str) -> tuple[str, ...]:
    try:
        return (*COMMON_CHECK_IDS, *MODE_CHECK_IDS[mode], *FINAL_CHECK_IDS)
    except KeyError as error:
        raise ProbeFailure(f"unsupported probe mode: {mode}") from error


def assert_registry_policy_denied(completed: subprocess.CompletedProcess[str]) -> None:
    output = f"{completed.stdout}\n{completed.stderr}"
    if CONNECTIVITY_FAILURE.search(output):
        raise ProbeFailure(
            f"denied registry probe failed for connectivity: {output.strip()}"
        )
    if not POLICY_DENIAL.search(output):
        raise ProbeFailure(
            f"denied registry probe lacks an explicit 403/Forbidden result: {output.strip()}"
        )


def snapshot_errno_class(error: OSError) -> str:
    if error.errno in {errno.EACCES, errno.EPERM}:
        return "eacces"
    if error.errno == errno.ENOENT:
        return "enoent"
    if error.errno == errno.ESTALE:
        return "estale"
    return "other"


def raise_snapshot_entry_failure(phase: str, error: OSError) -> None:
    if phase not in SNAPSHOT_ENTRY_PHASES:
        raise ProbeFailure("snapshot-scan:internal") from None
    raise ProbeFailure(
        f"snapshot-entry:{phase}:{snapshot_errno_class(error)}"
    ) from None


def snapshot_scan_failure_code(error: BaseException) -> str:
    message = str(error)
    if message in SNAPSHOT_SCAN_FAILURE_CODES:
        return message
    if message in {
        "agent CA is PEM",
        "snapshot authority input is unavailable",
        "public CA SPKI extraction failed closed",
        "public CA certificate has no bounded canonical SPKI",
    }:
        return "snapshot-scan:authority-input"
    if message in {
        "BuildKit/VFS snapshot residue scan timed out",
        "private-key residue scan exceeded its deadline",
        "residue scan exceeded its aggregate deadline",
    }:
        return "snapshot-scan:timeout"
    if message in {
        "snapshot symlink inspection failed closed",
        "snapshot link reaches an IronCurtain trust mount",
        "link target is not bounded canonical UTF-8",
        "link target is empty or outside its bound",
    }:
        return "snapshot-scan:link"
    if message in {
        "snapshot contains an IronCurtain trust mount stub",
        "snapshot contains the IronCurtain CA private key",
        "snapshot contains exact IronCurtain public trust residue",
    }:
        return "snapshot-scan:residue"
    if message in {
        "private-key candidate validation failed closed",
        "private-key candidate produced an invalid public SPKI",
    }:
        return "snapshot-scan:pem-parser"
    if message in {
        "residue scan exceeded its byte bound",
        "snapshot entry changed during residue scan",
    } or message.startswith("snapshot file has stable exact size during residue scan"):
        return "snapshot-scan:unstable"
    return "snapshot-scan:internal"


def run_bounded_snapshot_subprocess(
    argv: Sequence[str],
    timeout_seconds: float,
    per_stream_output_limit: int,
    aggregate_output_limit: int,
) -> subprocess.CompletedProcess[bytes]:
    try:
        process = subprocess.Popen(
            tuple(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        raise ProbeFailure("snapshot-scan:launch") from None
    if process.stdout is None or process.stderr is None:
        process.kill()
        process.wait()
        raise ProbeFailure("snapshot-scan:launch")

    streams = {"stdout": process.stdout, "stderr": process.stderr}
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout_seconds

    def kill_process_group() -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        finally:
            process.wait()

    try:
        for name, stream in streams.items():
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                kill_process_group()
                raise ProbeFailure("snapshot-scan:timeout")
            events = selector.select(remaining_seconds)
            if not events:
                kill_process_group()
                raise ProbeFailure("snapshot-scan:timeout")
            for key, _mask in events:
                try:
                    chunk = os.read(key.fd, 4096)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                output = captured[key.data]
                if len(output) + len(chunk) > per_stream_output_limit:
                    kill_process_group()
                    raise ProbeFailure(f"snapshot-scan:{key.data}-overflow")
                if (
                    sum(len(value) for value in captured.values()) + len(chunk)
                    > aggregate_output_limit
                ):
                    kill_process_group()
                    raise ProbeFailure("snapshot-scan:output-overflow")
                output.extend(chunk)
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            kill_process_group()
            raise ProbeFailure("snapshot-scan:timeout")
        try:
            returncode = process.wait(timeout=remaining_seconds)
        except subprocess.TimeoutExpired:
            kill_process_group()
            raise ProbeFailure("snapshot-scan:timeout") from None
    except ProbeFailure:
        raise
    except (OSError, ValueError):
        raise ProbeFailure("snapshot-scan:protocol") from None
    finally:
        selector.close()
        for stream in streams.values():
            if not stream.closed:
                stream.close()
        if process.poll() is None:
            kill_process_group()

    return subprocess.CompletedProcess(
        tuple(argv), returncode, bytes(captured["stdout"]), bytes(captured["stderr"])
    )


class Probe:
    def __init__(self, mode: str = "packages") -> None:
        self.mode = mode
        self.checks: list[str] = []
        suffix = uuid.uuid4().hex[:12]
        self.nonce = uuid.uuid4().hex
        self.tag_prefix = f"ic-wf-{mode}-{suffix}"
        self.server_name = f"{self.tag_prefix}-server"
        self.cleanup_armed = False
        self.container_ids: list[str] = []
        self.image_ids: list[str] = []
        self.fixture_image_ids: list[str] = []
        self.initial_image_ids: tuple[str, ...] = ()
        self.cache_audit_sentinels: dict[str, str] | None = None
        self.inspected_layers: dict[str, tuple[str, ...]] = {}
        self.form_image_layers: dict[str, tuple[str, tuple[str, ...]]] = {}
        self.build_base_layers: tuple[str, ...] | None = None
        self.ca_public_spki_cache: bytes | None = None
        self.authority_marker_cache: tuple[bytes, ...] | None = None
        self.admitted_daemon_identity: DaemonIdentity | None = None

    def require(self, condition: bool, check_id: str, detail: str = "") -> None:
        if not condition:
            suffix = f": {detail}" if detail else ""
            raise ProbeFailure(f"{check_id}{suffix}")
        self.complete(check_id)

    def complete(self, check_id: str) -> None:
        if check_id in self.checks:
            raise ProbeFailure(f"duplicate deterministic check ID: {check_id}")
        self.checks.append(check_id)

    @staticmethod
    def assert_true(condition: bool, label: str, detail: str = "") -> None:
        if not condition:
            suffix = f": {detail}" if detail else ""
            raise ProbeFailure(f"{label}{suffix}")

    def run(
        self,
        argv: Sequence[str],
        *,
        expect_success: bool | None = True,
        timeout: float = 180,
    ) -> subprocess.CompletedProcess[str]:
        try:
            completed = subprocess.run(
                list(argv),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise ProbeFailure(
                f"command timed out after {timeout}s: {list(argv)!r}"
            ) from error

        succeeded = completed.returncode == 0
        if expect_success is not None and succeeded != expect_success:
            expectation = "succeed" if expect_success else "fail"
            raise ProbeFailure(
                f"command was expected to {expectation}: {list(argv)!r}\n"
                f"exit={completed.returncode}\nstdout={completed.stdout[-4096:]}\n"
                f"stderr={completed.stderr[-4096:]}"
            )
        return completed

    def docker(
        self,
        *args: str,
        expect_success: bool | None = True,
        timeout: float = 180,
    ) -> subprocess.CompletedProcess[str]:
        return self.run(
            ["docker", *args], expect_success=expect_success, timeout=timeout
        )

    @staticmethod
    def _daemon_identity(info: object) -> DaemonIdentity:
        if not isinstance(info, dict):
            raise ProbeFailure("nested Docker daemon identity is not exact")
        security_options = info.get("SecurityOptions")
        if (
            info.get("Driver") != "vfs"
            or not isinstance(info.get("ID"), str)
            or not info["ID"]
            or info.get("DockerRootDir") != str(DAEMON_DATA_ROOT)
            or not isinstance(security_options, list)
            or not security_options
            or any(not isinstance(option, str) for option in security_options)
            or not any("rootless" in option.lower() for option in security_options)
        ):
            raise ProbeFailure("nested Docker daemon identity is not exact")
        return (
            info["ID"],
            info["DockerRootDir"],
            info["Driver"],
            tuple(security_options),
        )

    def validate_common(self) -> str:
        docker_host = os.environ.get("DOCKER_HOST")
        self.require(
            docker_host == EXPECTED_DOCKER_HOST
            and os.environ.get("IRONCURTAIN_DOCKER_NETWORK") == EXPECTED_NETWORK,
            "common.endpoint",
            repr((docker_host, os.environ.get("IRONCURTAIN_DOCKER_NETWORK"))),
        )

        server_version = self.docker(
            "version", "--format", "{{.Server.Version}}"
        ).stdout.strip()
        info = json.loads(self.docker("info", "--format", "{{json .}}").stdout)
        try:
            daemon_identity = self._daemon_identity(info)
        except ProbeFailure:
            daemon_identity = None
        daemon_detail = (
            tuple(
                info.get(key)
                for key in ("ID", "DockerRootDir", "Driver", "SecurityOptions")
            )
            if isinstance(info, dict)
            else type(info).__name__
        )
        self.require(
            bool(server_version) and daemon_identity is not None,
            "common.daemon-profile",
            repr((server_version, daemon_detail)),
        )
        self.admitted_daemon_identity = daemon_identity

        networks = json.loads(
            self.docker("network", "inspect", EXPECTED_NETWORK).stdout
        )
        network = (
            networks[0] if isinstance(networks, list) and len(networks) == 1 else {}
        )
        self.require(
            network.get("Name") == EXPECTED_NETWORK
            and network.get("Driver") == "bridge"
            and network.get("Internal") is True
            and not (network.get("Containers") or {}),
            "common.managed-network",
            repr(network),
        )

        containers = self.docker("container", "ls", "--all", "--quiet").stdout.strip()
        image_ids = self._all_image_ids()
        self.require(
            containers == ""
            and len(image_ids) == 1
            and IMMUTABLE_ID.fullmatch(image_ids[0]) is not None,
            "common.fresh-inventory",
            repr((containers, image_ids)),
        )
        self.initial_image_ids = tuple(image_ids)
        self.cleanup_armed = True
        return image_ids[0]

    def validate_relay_topology(self, selected_image_id: str) -> None:
        self.assert_true(
            self.initial_image_ids == (selected_image_id,)
            and IMMUTABLE_ID.fullmatch(selected_image_id) is not None,
            "relay probe uses exact initial immutable image ID",
            repr((selected_image_id, self.initial_image_ids)),
        )
        registry_expected = self.mode in {"packages", "images"}
        package_expected = self.mode == "packages"
        for port, _path, _marker in HOST_RELAY_SPECS:
            self._assert_outer_tcp_refused(port)
        self.complete(f"{self.mode}.outer-tcp-absent")

        completed = self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "host",
            "--entrypoint",
            "/usr/bin/python3",
            selected_image_id,
            "-c",
            HOST_RELAY_PROBE_SCRIPT,
            json.dumps(HOST_RELAY_SPECS, separators=(",", ":")),
            timeout=HOST_RELAY_PROBE_TIMEOUT_SECONDS,
        )
        self.assert_true(
            completed.stderr == "" and len(completed.stdout.encode("utf-8")) <= 4096,
            "host relay probe output is bounded and clean",
            repr((completed.stdout[-1024:], completed.stderr[-1024:])),
        )
        try:
            observations = json.loads(completed.stdout)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise ProbeFailure("host relay probe returned malformed JSON") from error
        self._validate_host_relay_observations(
            observations,
            {18081: registry_expected, 18082: package_expected},
        )
        self.complete(f"{self.mode}.host-relay-matrix")

        containers = self.docker("container", "ls", "--all", "--quiet").stdout.strip()
        image_ids = self._all_image_ids()
        self.require(
            containers == "" and image_ids == list(self.initial_image_ids),
            f"{self.mode}.relay-probe-inventory",
            repr((containers, self.initial_image_ids, image_ids)),
        )

    def validate_artifacts(self, network_access: str) -> None:
        registry_expected = network_access in {"packages", "images"}
        package_expected = network_access == "packages"
        self.assert_true(
            self._is_socket(REGISTRY_SOCKET) is registry_expected,
            f"registry UDS matches {network_access}",
        )
        self.assert_true(
            self._is_socket(PACKAGE_SOCKET) is package_expected,
            f"package UDS matches {network_access}",
        )
        package_paths = (
            PACKAGE_SHIM,
            PACKAGE_RUNC,
            PACKAGE_CONFIG,
            PACKAGE_BUILDX_STATE,
            PACKAGE_CONTRACT,
            AGENT_CA_CERT,
            AGENT_CA_BUNDLE,
            PACKAGE_APT_CONFIG,
        )
        observed = tuple(path.exists() for path in package_paths)
        self.assert_true(
            observed
            == (
                (True,) * len(package_paths)
                if package_expected
                else (False,) * len(package_paths)
            ),
            f"package artifact presence matches {network_access}",
            repr(dict(zip(map(str, package_paths), observed, strict=True))),
        )

        resolved = shutil.which("docker")
        if package_expected:
            self.assert_true(
                resolved == str(PACKAGE_SHIM),
                "packages resolves exact Docker shim",
                repr(resolved),
            )
            expected_modes = {
                PACKAGE_SHIM: 0o555,
                PACKAGE_RUNC: 0o555,
                PACKAGE_CONFIG: 0o444,
                PACKAGE_BUILDX_STATE: 0o700,
                PACKAGE_CONTRACT: 0o444,
                AGENT_CA_CERT: 0o444,
                AGENT_CA_BUNDLE: 0o444,
                PACKAGE_APT_CONFIG: 0o444,
            }
            for path, mode in expected_modes.items():
                self.assert_true(
                    stat.S_IMODE(path.stat().st_mode) == mode, f"exact mode for {path}"
                )
            contract_parent_stat = PACKAGE_CONTRACT_PARENT.stat()
            self.assert_true(
                contract_parent_stat.st_uid == 0
                and contract_parent_stat.st_gid == 0
                and stat.S_IMODE(contract_parent_stat.st_mode) == 0o755,
                "Apple contract parent is exact root-owned trusted infrastructure",
                repr(
                    (
                        contract_parent_stat.st_uid,
                        contract_parent_stat.st_gid,
                        stat.S_IMODE(contract_parent_stat.st_mode),
                    )
                ),
            )
            contract_stat = PACKAGE_CONTRACT.stat()
            self.assert_true(
                0 <= contract_stat.st_uid <= 0xFFFFFFFF
                and 0 <= contract_stat.st_gid <= 0xFFFFFFFF
                and contract_stat.st_nlink == 1,
                "Apple contract mount owner is bounded diagnostic metadata and has one link",
                repr(
                    (
                        contract_stat.st_uid,
                        contract_stat.st_gid,
                        contract_stat.st_nlink,
                    )
                ),
            )
            for trusted_path in (
                PACKAGE_CONTRACT,
                AGENT_CA_CERT,
                AGENT_CA_BUNDLE,
                PACKAGE_APT_CONFIG,
            ):
                filesystem = os.statvfs(trusted_path)
                self.assert_true(
                    bool(filesystem.f_flag & os.ST_RDONLY),
                    "package trust input has effective read-only backing",
                    str(trusted_path),
                )
            self.assert_true(
                hashlib.sha256(PACKAGE_RUNC.read_bytes()).hexdigest()
                == PACKAGE_RUNC_SHA256,
                "pinned package runc wrapper digest",
            )
            real_runc_stat = REAL_RUNC.stat()
            self.assert_true(
                stat.S_ISREG(real_runc_stat.st_mode)
                and real_runc_stat.st_uid == 0
                and real_runc_stat.st_gid == 0
                and stat.S_IMODE(real_runc_stat.st_mode) == 0o755
                and real_runc_stat.st_nlink == 1
                and real_runc_stat.st_size == REAL_RUNC_SIZE
                and hashlib.sha256(REAL_RUNC.read_bytes()).hexdigest()
                == REAL_RUNC_SHA256,
                "selected-image real runc has exact outer identity",
                repr(real_runc_stat),
            )
            real_runc_version = self.run([str(REAL_RUNC), "--version"]).stdout
            self.assert_true(
                "runc version 1.3.4" in real_runc_version
                and "commit: v1.3.4-0-gd6d73eb" in real_runc_version
                and "spec: 1.2.1" in real_runc_version,
                "selected-image real runc has exact version identity",
                real_runc_version,
            )
            config = json.loads(PACKAGE_CONFIG.read_text(encoding="utf-8"))
            self.assert_true(
                config
                == {
                    "proxies": {
                        "default": {
                            "httpProxy": PACKAGE_PROXY,
                            "httpsProxy": PACKAGE_PROXY,
                        }
                    }
                },
                "credential-free Docker package config is exact",
                repr(config),
            )
            lowered = json.dumps(config).lower()
            self.assert_true(
                not any(
                    token in lowered
                    for token in ("auth", "credential", "password", "token", "username")
                ),
                "Docker package config contains no credential field",
            )
            self._validate_trust_contract()
        else:
            self.assert_true(
                resolved != str(PACKAGE_SHIM), f"{network_access} excludes package shim"
            )

        self.complete(
            f"{network_access}.artifacts"
            if network_access != "admission"
            else "admission.artifacts"
        )

    def validate_packages(self) -> None:
        self.validate_artifacts("packages")
        self._pull_public_images(PUBLIC_IMAGES, "packages.registry-pulls")
        self._validate_registry_denial("packages.registry-denial")
        build_base_layers = self._inspect_image(PRIMARY_PUBLIC_IMAGE)

        authoritative_tag = f"{self.tag_prefix}-authoritative:latest"
        build_args = (
            "build",
            "--pull=false",
            "--no-cache",
            "--progress=plain",
            "--build-arg",
            f"IRONCURTAIN_NONCE={self.nonce}",
            "--tag",
            authoritative_tag,
            str(FIXTURE_DIR),
        )
        self.docker(*build_args, timeout=PACKAGE_NETWORK_BUILD_TIMEOUT_SECONDS)
        authoritative_id = self._track_image(authoritative_tag, fixture=True)
        self.complete("packages.authoritative-build")
        self._validate_built_result(authoritative_id)
        self._validate_sibling_dns(authoritative_id)
        self._validate_compose_rejection()
        self._validate_selector_denials()
        self._validate_direct_build_denial()
        self._validate_outer_package_proxy()
        self._validate_policy_denials()
        self._validate_host_network_child(authoritative_id)

        authoritative_layers = self._inspect_image(authoritative_id)
        self.assert_true(
            len(authoritative_layers) > len(build_base_layers)
            and authoritative_layers[: len(build_base_layers)] == build_base_layers,
            "authoritative build extends the exact inspected public base",
            repr(
                {
                    "base": build_base_layers,
                    "authoritative": authoritative_layers,
                }
            ),
        )
        self.build_base_layers = build_base_layers
        for label, prefix in PACKAGE_BUILD_FORMS:
            context = self._write_form_context(label, authoritative_tag)
            tag = f"{self.tag_prefix}-{label}:latest"
            completed = self.docker(
                *prefix,
                "--pull=false",
                "--no-cache",
                "--progress=plain",
                "--tag",
                tag,
                str(context),
                timeout=PACKAGE_FORM_BUILD_TIMEOUT_SECONDS,
            )
            self._assert_form_check_executed(completed, label)
            image_id = self._track_image(tag, fixture=True)
            self._validate_form_result(image_id, label)
            self._record_form_layer_inventory(authoritative_layers, image_id, label)
        self.complete("packages.supported-build-forms")

        cached_tag = f"{self.tag_prefix}-cached:latest"
        cache_args = (
            "build",
            "--pull=false",
            "--progress=plain",
            "--build-arg",
            f"IRONCURTAIN_NONCE={self.nonce}",
            "--tag",
            cached_tag,
            str(FIXTURE_DIR),
        )
        before_sentinel = self._record_cache_audit_sentinel("before")
        cached = self.docker(*cache_args, timeout=PACKAGE_CACHE_BUILD_TIMEOUT_SECONDS)
        after_sentinel = self._record_cache_audit_sentinel("after")
        cached_output = f"{cached.stdout}\n{cached.stderr}"
        self.assert_true(
            cached_output.count("CACHED") >= 5,
            "package repeat reports BuildKit cache hits",
        )
        cached_id = self._track_image(cached_tag, fixture=True)
        self.assert_true(
            cached_id == authoritative_id,
            "cached repeat resolves the authoritative image ID",
        )
        self.cache_audit_sentinels = {
            "beforePath": before_sentinel,
            "afterPath": after_sentinel,
        }
        self.complete("packages.cached-repeat")

        self._scan_fixture_images()
        self._scan_snapshot_filesystems()

    def validate_images(self) -> None:
        self.validate_artifacts("images")
        self._pull_public_images((PRIMARY_PUBLIC_IMAGE,), "images.registry-pull")
        self._validate_registry_denial("images.registry-denial")
        self._validate_fixed_package_build_failure(
            PRIMARY_PUBLIC_IMAGE, "images.package-build-denied"
        )

    def validate_offline(self, selected_image_id: str) -> None:
        self.validate_artifacts("offline")
        denied = self.docker(
            "image",
            "pull",
            PRIMARY_PUBLIC_IMAGE,
            expect_success=False,
            timeout=60,
        )
        self.assert_true(denied.returncode != 0, "offline public pull fails")
        retained = self.docker(
            "image", "inspect", PRIMARY_PUBLIC_IMAGE, expect_success=None
        )
        self.require(retained.returncode != 0, "offline.registry-pull-denied")
        selected_reference = self._selected_image_reference(selected_image_id)
        self._validate_fixed_package_build_failure(
            selected_reference, "offline.package-build-denied"
        )

        context = self._write_generated_context(
            "offline-hermetic",
            f"FROM {selected_reference}\n"
            "RUN node -e \"require('node:fs').writeFileSync('/tmp/ironcurtain-hermetic', 'hermetic-ok')\"\n",
        )
        tag = f"{self.tag_prefix}-hermetic:latest"
        self.docker("build", "--network=none", "--tag", tag, str(context), timeout=300)
        image_id = self._track_image(tag, fixture=True)
        output = self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--entrypoint",
            "node",
            image_id,
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/tmp/ironcurtain-hermetic','utf8'))",
        ).stdout
        self.require(output == "hermetic-ok", "offline.hermetic-build", repr(output))

    def validate_next_admission(self) -> None:
        self.validate_artifacts("admission")
        tags = self.docker(
            "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"
        ).stdout.splitlines()
        self.require(
            not any(tag.startswith("ic-wf-") for tag in tags)
            and not PACKAGE_BUILDX_STATE.exists()
            and self._all_image_ids() == list(self.initial_image_ids),
            "admission.fresh-state",
            repr(tags),
        )

    def _validate_trust_contract(self) -> None:
        contract = json.loads(PACKAGE_CONTRACT.read_text(encoding="utf-8"))
        self.assert_true(
            contract.get("schemaVersion") == 1, "build trust contract schema"
        )
        self.assert_true(
            re.fullmatch(
                r"gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                str(contract.get("caGeneration", "")),
            )
            is not None,
            "build trust contract carries an authenticated CA generation",
        )
        real_runc = contract.get("realRunc")
        self.assert_true(
            isinstance(real_runc, dict)
            and real_runc.get("path") == "/usr/local/lib/ironcurtain-docker/bin/runc"
            and real_runc.get("version") == "1.3.4"
            and real_runc.get("ownerPairs")
            == [{"uid": 0, "gid": 0}, {"uid": 65534, "gid": 65534}]
            and real_runc.get("nlink") == 1
            and real_runc.get("mode") == "0755",
            "build trust real-runc identity",
            repr(real_runc),
        )
        sources = contract.get("publicSources")
        self.assert_true(
            isinstance(sources, list) and len(sources) == 3,
            "three public trust sources",
        )
        expected = {
            "/dev/ironcurtain/ca-cert.pem": AGENT_CA_CERT,
            "/dev/ironcurtain/ca-bundle.pem": AGENT_CA_BUNDLE,
            "/dev/ironcurtain/apt.conf": PACKAGE_APT_CONFIG,
        }
        observed: dict[str, str] = {}
        for source in sources:
            self.assert_true(isinstance(source, dict), "public trust source shape")
            self.assert_true(
                set(source) == {"path", "destination", "sha256", "size", "mode"},
                "public trust source has exact owner-free schema",
                repr(source),
            )
            target = source.get("destination")
            self.assert_true(
                target in expected, "public trust source target", repr(target)
            )
            self.assert_true(
                source.get("path") == str(expected[str(target)])
                and source.get("mode") == "0444"
                and source.get("size") == expected[str(target)].stat().st_size,
                "public trust source exact path, mode, and size",
                repr(source),
            )
            observed[str(target)] = str(source.get("sha256"))
        self.assert_true(
            set(observed) == set(expected), "public trust targets are exact"
        )
        for target, source_path in expected.items():
            digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
            self.assert_true(
                observed[target] == digest, f"public trust digest for {target}"
            )
        lowered = json.dumps(contract).lower()
        self.assert_true(
            "private" not in lowered
            and "ca-key" not in lowered
            and "begin rsa private" not in lowered,
            "build trust contract excludes private key authority",
        )

    def _pull_public_images(self, references: Sequence[str], check_id: str) -> None:
        for reference in references:
            preexisting = self.docker(
                "image", "inspect", reference, expect_success=None
            )
            self.assert_true(
                preexisting.returncode != 0, f"public image starts absent: {reference}"
            )
            self.docker(
                "image",
                "pull",
                reference,
                timeout=PACKAGE_IMAGE_PULL_TIMEOUT_SECONDS,
            )
            self._track_image(reference)
        self.complete(check_id)

    def _validate_registry_denial(self, check_id: str) -> None:
        denied = self.docker(
            "image", "pull", DENIED_IMAGE, expect_success=False, timeout=60
        )
        assert_registry_policy_denied(denied)
        retained = self.docker("image", "inspect", DENIED_IMAGE, expect_success=None)
        self.require(retained.returncode != 0, check_id)

    def _validate_built_result(self, image_id: str) -> None:
        completed = self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            EXPECTED_NETWORK,
            image_id,
        )
        payload = json.loads(completed.stdout)
        self.require(
            payload.get("nonce") == self.nonce
            and payload.get("npm") == "is-number@7.0.0"
            and payload.get("pypi") == "idna@3.15"
            and payload.get("aptCurlVersion") == "7.88.1-10+deb12u15"
            and payload.get("cargo") == "itoa@1.0.15"
            and payload.get("cargoOutput") == "37",
            "packages.exact-results",
            repr(payload),
        )

    def _validate_sibling_dns(self, image_id: str) -> None:
        server_code = (
            "require('node:http').createServer((request,response)=>response.end(process.env.NONCE))"
            ".listen(8080,'0.0.0.0')"
        )
        created = self.docker(
            "container",
            "run",
            "--detach",
            "--name",
            self.server_name,
            "--network",
            EXPECTED_NETWORK,
            "--network-alias",
            "target",
            "--pull",
            "never",
            "--env",
            f"NONCE={self.nonce}",
            image_id,
            "node",
            "-e",
            server_code,
        )
        self.container_ids.append(self._container_id(created, self.server_name))
        last_error = ""
        for _ in range(10):
            sibling = self.docker(
                "container",
                "run",
                "--rm",
                "--network",
                EXPECTED_NETWORK,
                "--pull",
                "never",
                image_id,
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
                "http://target:8080/",
                expect_success=None,
                timeout=15,
            )
            if sibling.returncode == 0 and sibling.stdout == self.nonce:
                self.complete("packages.sibling-network")
                return
            last_error = f"{sibling.stdout}\n{sibling.stderr}"
            time.sleep(1)
        raise ProbeFailure(f"managed-network sibling failed: {last_error[-2048:]}")

    def _validate_compose_rejection(self) -> None:
        project_name = f"{self.tag_prefix}-compose"
        compose_image = f"{project_name}-fixture"
        compose_prefix = (
            "compose",
            "--project-name",
            project_name,
            "-f",
            str(FIXTURE_DIR / "compose.yaml"),
        )
        preexisting = self.docker(
            "image", "inspect", compose_image, expect_success=None, timeout=30
        )
        self.assert_true(
            preexisting.returncode != 0,
            "clean build-only Compose image starts absent",
            compose_image,
        )
        for suffix, marker in (
            (("build",), "Compose builds are unsupported"),
            (("up",), "Compose builds are unsupported"),
            (("up", "--build"), "Compose builds are unsupported"),
            (("create",), "Compose builds are unsupported"),
            (("run", "fixture"), "Compose builds are unsupported"),
            (("watch",), "Compose watch is unsupported"),
            (("up", "--no-build", "--watch"), "Compose watch is unsupported"),
            (
                ("up", "--no-build", "--menu"),
                "Compose navigation menus are unsupported",
            ),
            (
                ("create", "--no-build", "--watch"),
                "Compose watch is unsupported",
            ),
            (
                ("create", "--no-build", "--menu"),
                "Compose navigation menus are unsupported",
            ),
        ):
            argv = (*compose_prefix, *suffix)
            denied = self.docker(*argv, expect_success=False, timeout=30)
            output = f"{denied.stdout}\n{denied.stderr}"
            self.assert_true(
                denied.returncode == 64 and marker in output,
                f"documented Compose denial for {argv}",
                output[-2048:],
            )
        absent = self.docker(
            "image", "inspect", compose_image, expect_success=None, timeout=30
        )
        self.assert_true(
            absent.returncode != 0,
            "denied build-only Compose forms leave no image",
            compose_image,
        )
        self.complete("packages.compose-denial")

    def _validate_selector_denials(self) -> None:
        context = str(FIXTURE_DIR)
        commands = (
            ("--context", "default", "build", context),
            ("build", "--builder", "custom", context),
            ("build", "--network", "bridge", context),
            ("buildx", "--builder", "custom", "build", context),
        )
        for argv in commands:
            denied = self.docker(*argv, expect_success=False, timeout=30)
            output = f"{denied.stdout}\n{denied.stderr}"
            self.assert_true(
                denied.returncode == 64 and "unsupported" in output,
                f"selector denial for {argv}",
            )
        self.assert_true(
            shutil.which("docker-buildx") is None,
            "direct docker-buildx is absent from PATH",
        )
        self.assert_true(
            shutil.which("docker-compose") is None,
            "direct docker-compose is absent from PATH",
        )
        self.complete("packages.selector-denials")

    def _validate_direct_build_denial(self) -> None:
        tag = f"{self.tag_prefix}-direct-denied:latest"
        empty_proxy_args = [
            value
            for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
            for value in ("--build-arg", f"{name}=")
        ]
        self.docker(
            "build",
            "--pull=false",
            "--file",
            str(FIXTURE_DIR / "direct-denied.Dockerfile"),
            *empty_proxy_args,
            "--tag",
            tag,
            str(FIXTURE_DIR),
            timeout=PACKAGE_DIRECT_DENIAL_BUILD_TIMEOUT_SECONDS,
        )
        self._track_image(tag, fixture=True)
        self.complete("packages.direct-route-denial")

    def _validate_outer_package_proxy(self) -> None:
        response = self._tls_package_request(
            "GET",
            "registry.npmjs.org",
            "registry.npmjs.org",
            b"GET /is-number HTTP/1.1\r\n"
            b"Host: registry.npmjs.org\r\n"
            b"Connection: close\r\n\r\n",
        )
        payload = json.loads(self._exact_http_body(response, "GET", "HTTP/1.1 200 OK"))
        self.require(
            "7.0.0" in (payload.get("versions") or {}), "packages.outer-package-request"
        )

    def _validate_policy_denials(self) -> None:
        outer_requests: tuple[tuple[HttpRequestMethod, bytes], ...] = (
            (
                "CONNECT",
                b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
            ),
            (
                "CONNECT",
                b"CONNECT npm.pkg.github.com:443 HTTP/1.1\r\nHost: npm.pkg.github.com:443\r\n\r\n",
            ),
            (
                "CONNECT",
                b"CONNECT registry.npmjs.org:444 HTTP/1.1\r\nHost: registry.npmjs.org:444\r\n\r\n",
            ),
            (
                "GET",
                b"GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
            ),
            ("GET", b"GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
        )
        for method, request in outer_requests:
            self._require_403(
                self._raw_package_proxy(method, request),
                request[:80].decode("ascii"),
            )

        inner_requests: tuple[tuple[HttpRequestMethod, bytes], ...] = (
            (
                "GET",
                b"GET /is-odd/-/is-odd-3.0.1.tgz HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
            ),
            (
                "POST",
                b"POST /is-number HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 1\r\n\r\nx",
            ),
            (
                "GET",
                b"GET /is-number HTTP/1.1\r\nHost: registry.npmjs.org\r\nAuthorization: Bearer forbidden\r\n\r\n",
            ),
            (
                "GET",
                b"GET /-/npm/v1/security/audits/quick HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
            ),
            (
                "GET",
                b"GET /is-number?private=1 HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
            ),
            (
                "GET",
                b"GET /is-number HTTP/1.1\r\nHost: pypi.org\r\n\r\n",
            ),
        )
        for method, request in inner_requests:
            self._require_403(
                self._tls_package_request(
                    method, "registry.npmjs.org", "registry.npmjs.org", request
                ),
                request[:100].decode("ascii"),
            )

        tunnel = self._open_connect("registry.npmjs.org", 443)
        try:
            context = ssl._create_unverified_context()
            try:
                wrapped = context.wrap_socket(tunnel, server_hostname="pypi.org")
            except (OSError, ssl.SSLError):
                pass
            else:
                wrapped.close()
                raise ProbeFailure(
                    "mismatched package CONNECT and SNI unexpectedly completed"
                )
        finally:
            tunnel.close()

        self.complete("packages.policy-denials")

    def _validate_host_network_child(self, image_id: str) -> None:
        tracked_containers = tuple(self.container_ids)
        self.assert_true(
            len(tracked_containers) == len(set(tracked_containers))
            and all(
                CONTAINER_ID.fullmatch(value) is not None
                for value in tracked_containers
            ),
            "host child tracked container inventory is unique and immutable",
            repr(tracked_containers),
        )
        expected_containers = tuple(sorted(tracked_containers))
        all_containers_before = tuple(self._full_container_ids(all_containers=True))
        running_containers_before = tuple(
            self._full_container_ids(all_containers=False)
        )
        self.assert_true(
            all_containers_before == expected_containers
            and running_containers_before == expected_containers,
            "host child baseline contains every and only running tracked container",
            repr(
                (expected_containers, all_containers_before, running_containers_before)
            ),
        )
        tracked_images = (*self.initial_image_ids, *self.image_ids)
        self.assert_true(
            len(tracked_images) == len(set(tracked_images))
            and all(
                IMMUTABLE_ID.fullmatch(value) is not None for value in tracked_images
            ),
            "host child tracked image inventory is unique and immutable",
            repr(tracked_images),
        )
        expected_images = tuple(sorted(tracked_images))
        images_before = tuple(self._all_image_ids())
        self.assert_true(
            images_before == expected_images,
            "host child baseline contains every and only tracked image",
            repr((expected_images, images_before)),
        )
        allowed = self.docker(
            "container",
            "run",
            "--rm",
            "--network",
            "host",
            "--pull",
            "never",
            image_id,
            "curl",
            "--insecure",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--proxy",
            PACKAGE_PROXY,
            "--noproxy",
            "",
            "https://registry.npmjs.org/is-number",
            timeout=60,
        )
        self.assert_true('"7.0.0"' in allowed.stdout, "host child fixed npm response")
        denied = self.docker(
            "container",
            "run",
            "--rm",
            "--network",
            "host",
            "--pull",
            "never",
            image_id,
            "curl",
            "--insecure",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "20",
            "--proxy",
            PACKAGE_PROXY,
            "--noproxy",
            "",
            "https://example.com/",
            expect_success=False,
            timeout=30,
        )
        self.assert_true(
            POLICY_DENIAL.search(f"{denied.stdout}\n{denied.stderr}") is not None,
            "host child curl denial",
        )
        connect_denial = self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "host",
            "--entrypoint",
            "/usr/bin/python3",
            self.initial_image_ids[0],
            "-c",
            HOST_PACKAGE_CONNECT_DENIAL_SCRIPT,
            expect_success=None,
            timeout=HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS,
        )
        if connect_denial.stdout != "" or connect_denial.stderr != "":
            raise ProbeFailure("host child held-open CONNECT denial emitted output")
        connect_outcome = HOST_PACKAGE_CONNECT_EXIT_OUTCOMES.get(
            connect_denial.returncode
        )
        if connect_outcome is None:
            raise ProbeFailure(
                "host child held-open CONNECT denial returned an unknown status"
            )
        if connect_outcome != "exact-eof":
            raise ProbeFailure(
                f"host child held-open CONNECT denial outcome: {connect_outcome}"
            )
        all_containers_after = tuple(self._full_container_ids(all_containers=True))
        running_containers_after = tuple(self._full_container_ids(all_containers=False))
        image_ids_after = tuple(self._all_image_ids())
        self.assert_true(
            all_containers_after == all_containers_before
            and running_containers_after == running_containers_before
            and image_ids_after == images_before,
            "host child package probes preserve exact inventory",
            repr(
                (
                    all_containers_before,
                    all_containers_after,
                    running_containers_before,
                    running_containers_after,
                    images_before,
                    image_ids_after,
                )
            ),
        )
        self.complete("packages.host-child-scope")

    def _validate_fixed_package_build_failure(self, image: str, check_id: str) -> None:
        run_command = (
            "RUN node -e \"fetch('https://registry.npmjs.org/is-number', "
            "{signal: AbortSignal.timeout(5000)})"
            '.then(() => process.exit(8)).catch(() => process.exit(7))"\n'
        )
        context = self._write_generated_context(
            f"{self.mode}-package-required",
            f"FROM {image}\n{run_command}",
        )
        tag = f"{self.tag_prefix}-must-not-build:latest"
        build_args = (
            "build",
            "--no-cache",
            "--progress=plain",
            "--tag",
            tag,
            str(context),
        )
        denied = self.docker(
            *build_args,
            expect_success=False,
            timeout=120,
        )
        output = f"{denied.stdout}\n{denied.stderr}"
        self.assert_true(
            BUILD_NETWORK_ABSENCE.search(output) is not None,
            f"{self.mode} fixed-package build lacks exact network absence",
        )
        retained = self.docker("image", "inspect", tag, expect_success=None)
        self.require(retained.returncode != 0, check_id)

    def _validate_form_result(self, image_id: str, label: str) -> None:
        completed = self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            EXPECTED_NETWORK,
            image_id,
        )
        self.assert_true(
            json.loads(completed.stdout) == {"form": label}, f"exact output for {label}"
        )

    def _assert_form_check_executed(
        self, completed: subprocess.CompletedProcess[str], label: str
    ) -> None:
        output = f"{completed.stdout}\n{completed.stderr}"
        expected_command = re.escape(form_check_run_command())
        step_ids = re.findall(
            rf"^(#\d+) .*{expected_command}\s*$",
            output,
            re.MULTILINE,
        )
        self.assert_true(
            len(step_ids) == 1,
            f"{label} reports exactly one form-check BuildKit step",
            repr(step_ids),
        )
        step_id = step_ids[0]
        self.assert_true(
            re.search(rf"^{re.escape(step_id)} CACHED\s*$", output, re.MULTILINE)
            is None
            and re.search(
                rf"^{re.escape(step_id)} DONE(?:\s+\S+)?\s*$", output, re.MULTILINE
            )
            is not None,
            f"{label} form-check executes without cache",
            output[-4096:],
        )

    def _record_form_layer_inventory(
        self, authoritative_layers: tuple[str, ...], image_id: str, label: str
    ) -> None:
        form_layers = self._inspect_image(image_id)
        expected_layers = (*authoritative_layers, CANONICAL_EMPTY_LAYER_DIFF_ID)
        self.assert_true(
            form_layers == expected_layers,
            f"{label} adds only the canonical empty form-check layer",
            repr(
                {
                    "authoritative": authoritative_layers,
                    "expected": expected_layers,
                    "observed": form_layers,
                }
            ),
        )
        self.assert_true(
            image_id not in self.form_image_layers,
            f"{label} produced a distinct form image",
            image_id,
        )
        self.form_image_layers[image_id] = (label, form_layers)

    def _inspect_image(self, image_id: str) -> tuple[str, ...]:
        cached = self.inspected_layers.get(image_id)
        if cached is not None:
            return cached
        forbidden = self._exact_authority_markers()
        inspect = self.docker("image", "inspect", image_id).stdout
        history = self.docker("image", "history", "--no-trunc", image_id).stdout
        config = json.loads(inspect)[0]
        env = config.get("Config", {}).get("Env") or []
        injected_names = tuple(f"{name}=" for name in self._injected_env_names())
        self.assert_true(
            not any(str(value).startswith(injected_names) for value in env),
            "built image persists no injected environment",
            repr(env),
        )
        joined = f"{inspect}\n{history}".encode()
        self.assert_true(
            not any(token in joined for token in forbidden),
            "image metadata contains no authority",
        )
        layers = config.get("RootFS", {}).get("Layers")
        self.assert_true(
            isinstance(layers, list)
            and all(isinstance(layer, str) and layer for layer in layers),
            "image has concrete layer inventory",
            repr(layers),
        )
        result = tuple(layers)
        self.inspected_layers[image_id] = result
        return result

    def _scan_fixture_images(self) -> None:
        unique = tuple(dict.fromkeys(self.fixture_image_ids))
        self.assert_true(bool(unique), "fixture output inventory is nonempty")
        for image_id in unique:
            self._inspect_image(image_id)
        deadline = time.monotonic() + PACKAGE_IMAGE_SCAN_TIMEOUT_SECONDS
        archive = Path(tempfile.gettempdir()) / f"{self.tag_prefix}-images.tar"
        try:
            self.docker(
                "image",
                "save",
                "--output",
                str(archive),
                *unique,
                timeout=self._remaining_residue_scan_seconds(deadline),
            )
            self._validate_saved_form_layers(archive, unique, deadline)
            self._scan_file(
                archive,
                self._exact_authority_markers(),
                MAX_RESIDUE_SCAN_BYTES,
                deadline=deadline,
            )
        finally:
            archive.unlink(missing_ok=True)
        self.complete("packages.image-residue")

    def _validate_saved_form_layers(
        self,
        archive: Path,
        expected_image_ids: Sequence[str],
        deadline: float,
    ) -> None:
        self._remaining_residue_scan_seconds(deadline)
        expected_labels = {label for label, _prefix in PACKAGE_BUILD_FORMS}
        self.assert_true(
            len(self.form_image_layers) == len(expected_labels)
            and {label for label, _layers in self.form_image_layers.values()}
            == expected_labels,
            "saved form-layer proof covers every supported form exactly once",
            repr(self.form_image_layers),
        )
        build_base_layers = self.build_base_layers
        self.assert_true(
            build_base_layers is not None and bool(build_base_layers),
            "saved image residue proof has an exact inspected base-layer boundary",
        )

        try:
            with tarfile.open(archive, mode="r:*") as saved:
                members_by_name: dict[str, list[tarfile.TarInfo]] = {}
                for member in saved:
                    self._remaining_residue_scan_seconds(deadline)
                    members_by_name.setdefault(member.name, []).append(member)

                def read_member(name: str, maximum: int, label: str) -> bytes:
                    normalized = Path(name)
                    self.assert_true(
                        bool(name)
                        and not normalized.is_absolute()
                        and ".." not in normalized.parts,
                        f"{label} has safe archive path",
                        repr(name),
                    )
                    matches = members_by_name.get(name, [])
                    self.assert_true(
                        len(matches) == 1
                        and matches[0].isfile()
                        and 0 < matches[0].size <= maximum,
                        f"{label} is one bounded regular archive member",
                        repr(
                            [
                                (candidate.name, candidate.size, candidate.type)
                                for candidate in matches
                            ]
                        ),
                    )
                    extracted = saved.extractfile(matches[0])
                    self.assert_true(extracted is not None, f"{label} can be read")
                    self._remaining_residue_scan_seconds(deadline)
                    contents = extracted.read(maximum + 1)
                    self._remaining_residue_scan_seconds(deadline)
                    self.assert_true(
                        len(contents) == matches[0].size,
                        f"{label} has exact bounded bytes",
                        repr((matches[0].size, len(contents))),
                    )
                    return contents

                validated_layers: dict[str, tuple[str, bool]] = {}
                validated_base_diff_ids: set[str] = set()
                scanned_layer_bytes = 0
                ca_public_spki = self._ca_public_spki(deadline)
                key_scan_budget = PrivateKeyScanBudget(
                    remaining_candidates=MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN,
                    deadline=deadline,
                )

                def layer_member(name: str, label: str) -> tarfile.TarInfo:
                    self._remaining_residue_scan_seconds(deadline)
                    normalized = Path(name)
                    self.assert_true(
                        bool(name)
                        and not normalized.is_absolute()
                        and ".." not in normalized.parts,
                        f"{label} has safe archive path",
                        repr(name),
                    )
                    matches = members_by_name.get(name, [])
                    self.assert_true(
                        len(matches) == 1
                        and matches[0].isfile()
                        and 0 < matches[0].size,
                        f"{label} is one bounded regular archive member",
                        repr(
                            [
                                (candidate.name, candidate.size, candidate.type)
                                for candidate in matches
                            ]
                        ),
                    )
                    if matches[0].size > MAX_RESIDUE_SCAN_BYTES:
                        raise ProbeFailure("snapshot-scan:archive-byte-bound")
                    return matches[0]

                def validate_layer(
                    name: str, diff_id: str, is_base: bool, label: str
                ) -> None:
                    nonlocal scanned_layer_bytes
                    prior = validated_layers.get(name)
                    if prior is not None:
                        self.assert_true(
                            prior == (diff_id, is_base),
                            "saved layer has one provenance and diff ID",
                            repr((name, prior, (diff_id, is_base))),
                        )
                        return
                    member = layer_member(name, label)
                    scanned_layer_bytes += member.size
                    if scanned_layer_bytes > MAX_RESIDUE_SCAN_BYTES:
                        raise ProbeFailure("snapshot-scan:archive-byte-bound")
                    extracted = saved.extractfile(member)
                    self.assert_true(extracted is not None, f"{label} can be read")
                    size, digest, _found, contains_ca_key = self._fingerprint_stream(
                        extracted,
                        (),
                        member.size,
                        deadline=deadline,
                    )
                    self.assert_true(
                        not contains_ca_key,
                        "raw layer digest pass performs no cross-file key scan",
                    )
                    self.assert_true(
                        size == member.size and f"sha256:{digest}" == diff_id,
                        f"{label} bytes match the config diff ID",
                        repr((member.size, size, diff_id, f"sha256:{digest}")),
                    )
                    if not is_base:
                        layer_contents = saved.extractfile(member)
                        self.assert_true(
                            layer_contents is not None,
                            "build-produced layer can be structurally inspected",
                        )
                        with tarfile.open(fileobj=layer_contents, mode="r|*") as layer:
                            for entry in layer:
                                self._remaining_residue_scan_seconds(deadline)
                                parts = tuple(
                                    part
                                    for part in PurePosixPath(entry.name).parts
                                    if part != "."
                                )
                                self.assert_true(
                                    bool(parts)
                                    and not PurePosixPath(entry.name).is_absolute()
                                    and ".." not in parts,
                                    "build-produced layer has safe entry names",
                                )
                                if parts[:2] == ("dev", "ironcurtain"):
                                    raise ProbeFailure(
                                        "build-produced layer contains an IronCurtain trust mount stub"
                                    )
                                if entry.isfile():
                                    self.assert_true(
                                        0 <= entry.size <= member.size,
                                        "build-produced layer regular entry stays within its layer bound",
                                    )
                                    entry_contents = layer.extractfile(entry)
                                    self.assert_true(
                                        entry_contents is not None,
                                        "build-produced layer regular entry can be read",
                                    )
                                    (
                                        entry_size,
                                        _entry_digest,
                                        _entry_found,
                                        entry_contains_ca_key,
                                    ) = self._fingerprint_stream(
                                        entry_contents,
                                        (),
                                        entry.size,
                                        ca_public_spki=ca_public_spki,
                                        key_scan_budget=key_scan_budget,
                                        deadline=deadline,
                                        compute_digest=False,
                                    )
                                    self.assert_true(
                                        entry_size == entry.size,
                                        "build-produced layer regular entry has exact bytes",
                                    )
                                    if entry_contains_ca_key:
                                        raise ProbeFailure(
                                            "build-produced layer contains the IronCurtain CA private key"
                                        )
                                if entry.issym():
                                    normalized_target = self._normalize_symlink_target(
                                        parts[:-1], entry.linkname
                                    )
                                elif entry.islnk():
                                    normalized_target = self._normalize_hardlink_target(
                                        entry.linkname
                                    )
                                else:
                                    normalized_target = None
                                if normalized_target is not None:
                                    if any(
                                        normalized_target[index : index + 2]
                                        == ("dev", "ironcurtain")
                                        for index in range(len(normalized_target) - 1)
                                    ):
                                        raise ProbeFailure(
                                            "build-produced layer link reaches an IronCurtain trust mount"
                                        )
                    validated_layers[name] = (diff_id, is_base)
                    if is_base:
                        validated_base_diff_ids.add(diff_id)

                manifest_bytes = read_member(
                    "manifest.json",
                    MAX_SAVED_IMAGE_METADATA_BYTES,
                    "Docker save manifest",
                )
                manifest = json.loads(manifest_bytes)
                self.assert_true(
                    isinstance(manifest, list) and bool(manifest),
                    "Docker save manifest is a nonempty list",
                    repr(manifest),
                )
                observed_image_ids: set[str] = set()
                validated_form_ids: set[str] = set()
                for entry in manifest:
                    self._remaining_residue_scan_seconds(deadline)
                    self.assert_true(
                        isinstance(entry, dict)
                        and isinstance(entry.get("Config"), str)
                        and isinstance(entry.get("Layers"), list)
                        and all(
                            isinstance(layer, str) and layer
                            for layer in entry.get("Layers", [])
                        ),
                        "Docker save image entry has exact config/layer references",
                        repr(entry),
                    )
                    config_bytes = read_member(
                        entry["Config"],
                        MAX_SAVED_IMAGE_METADATA_BYTES,
                        "Docker save image config",
                    )
                    image_id = f"sha256:{hashlib.sha256(config_bytes).hexdigest()}"
                    self.assert_true(
                        image_id not in observed_image_ids,
                        "Docker save contains each selected image once",
                        image_id,
                    )
                    observed_image_ids.add(image_id)
                    config = json.loads(config_bytes)
                    diff_ids = config.get("rootfs", {}).get("diff_ids")
                    layers = entry["Layers"]
                    self.assert_true(
                        isinstance(diff_ids, list)
                        and all(
                            isinstance(diff_id, str) and diff_id for diff_id in diff_ids
                        )
                        and len(layers) == len(diff_ids),
                        "Docker save config and layer archive have equal concrete inventories",
                        repr((image_id, diff_ids, layers)),
                    )
                    inspected_layers = self.inspected_layers.get(image_id)
                    self.assert_true(
                        inspected_layers is not None
                        and tuple(diff_ids) == inspected_layers,
                        "saved config preserves the exact inspected image layer inventory",
                        repr((image_id, inspected_layers, diff_ids)),
                    )
                    self.assert_true(
                        len(diff_ids) > len(build_base_layers)
                        and tuple(diff_ids[: len(build_base_layers)])
                        == build_base_layers,
                        "saved fixture extends the exact inspected public base prefix",
                        repr((image_id, build_base_layers, diff_ids)),
                    )
                    for index, (layer_name, diff_id) in enumerate(
                        zip(layers, diff_ids, strict=True)
                    ):
                        validate_layer(
                            layer_name,
                            diff_id,
                            index < len(build_base_layers),
                            f"Docker save layer {index} for {image_id}",
                        )
                    expectation = self.form_image_layers.get(image_id)
                    if expectation is None:
                        continue
                    label, expected_layers = expectation
                    self.assert_true(
                        tuple(diff_ids) == expected_layers
                        and expected_layers[-1] == CANONICAL_EMPTY_LAYER_DIFF_ID,
                        f"{label} saved config preserves exact inspected layer inventory",
                        repr((expected_layers, diff_ids)),
                    )
                    empty_layer = read_member(
                        layers[-1],
                        CANONICAL_EMPTY_LAYER_SIZE,
                        f"{label} canonical empty layer",
                    )
                    self.assert_true(
                        empty_layer == b"\0" * CANONICAL_EMPTY_LAYER_SIZE
                        and f"sha256:{hashlib.sha256(empty_layer).hexdigest()}"
                        == CANONICAL_EMPTY_LAYER_DIFF_ID,
                        f"{label} added layer is the canonical two-zero-block tar",
                    )
                    validated_form_ids.add(image_id)

                self.assert_true(
                    observed_image_ids == set(expected_image_ids)
                    and validated_form_ids == set(self.form_image_layers),
                    "Docker save structurally proves every and only selected form image",
                    repr(
                        {
                            "expectedImages": sorted(expected_image_ids),
                            "observedImages": sorted(observed_image_ids),
                            "expectedForms": sorted(self.form_image_layers),
                            "validatedForms": sorted(validated_form_ids),
                        }
                    ),
                )
                self.assert_true(
                    validated_base_diff_ids == set(build_base_layers),
                    "saved archive proves every inspected base layer",
                    repr((build_base_layers, validated_base_diff_ids)),
                )
                self._remaining_residue_scan_seconds(deadline)
        except (json.JSONDecodeError, KeyError, OSError, tarfile.TarError) as error:
            raise ProbeFailure("saved form-layer proof is malformed") from error

    def _snapshot_scan_state(
        self,
    ) -> tuple[DaemonIdentity, tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
        info = json.loads(
            self.docker("info", "--format", "{{json .}}", timeout=30).stdout
        )
        daemon_identity = self._daemon_identity(info)
        self.assert_true(
            self.admitted_daemon_identity is not None
            and daemon_identity == self.admitted_daemon_identity,
            "privileged snapshot scan retains the admitted daemon identity",
        )

        tracked_containers = tuple(self.container_ids)
        self.assert_true(
            len(tracked_containers) == len(set(tracked_containers))
            and all(
                CONTAINER_ID.fullmatch(identifier) is not None
                for identifier in tracked_containers
            ),
            "privileged snapshot scan tracked container inventory is exact",
        )
        expected_containers = tuple(sorted(tracked_containers))
        all_containers = tuple(self._full_container_ids(all_containers=True))
        running_containers = tuple(self._full_container_ids(all_containers=False))
        self.assert_true(
            all_containers == expected_containers
            and running_containers == expected_containers,
            "privileged snapshot scan contains every and only running tracked container",
            repr((expected_containers, all_containers, running_containers)),
        )

        tracked_images = (*self.initial_image_ids, *self.image_ids)
        self.assert_true(
            len(tracked_images) == len(set(tracked_images))
            and all(
                IMMUTABLE_ID.fullmatch(identifier) is not None
                for identifier in tracked_images
            ),
            "privileged snapshot scan tracked image inventory is exact",
        )
        expected_images = tuple(sorted(tracked_images))
        images = tuple(self._all_image_ids())
        self.assert_true(
            images == expected_images,
            "privileged snapshot scan contains every and only tracked image",
            repr((expected_images, images)),
        )
        return daemon_identity, all_containers, running_containers, images

    @staticmethod
    def _validate_privileged_snapshot_scan_preflight() -> None:
        try:
            hostname = socket.gethostname()
        except OSError:
            raise ProbeFailure("snapshot-scan:hostname") from None
        if SNAPSHOT_SCAN_HOSTNAME.fullmatch(hostname) is None:
            raise ProbeFailure("snapshot-scan:hostname")

        try:
            resolution = run_bounded_snapshot_subprocess(
                ("/usr/bin/getent", "ahosts", hostname),
                SNAPSHOT_SCAN_PREFLIGHT_COMMAND_TIMEOUT_SECONDS,
                SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_OUTPUT_LIMIT,
                SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_AGGREGATE_OUTPUT_LIMIT,
            )
        except ProbeFailure:
            raise ProbeFailure("snapshot-scan:hostname-resolution") from None
        if (
            resolution.returncode != 0
            or not resolution.stdout
            or not resolution.stdout.strip()
            or len(resolution.stdout) > SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_OUTPUT_LIMIT
            or SNAPSHOT_SCAN_SAFE_OUTPUT.fullmatch(resolution.stdout) is None
            or resolution.stderr
        ):
            raise ProbeFailure("snapshot-scan:hostname-resolution")

        try:
            sudo = run_bounded_snapshot_subprocess(
                (
                    "/usr/bin/sudo",
                    "-n",
                    "--",
                    "/usr/bin/env",
                    "-i",
                    "PATH=/usr/bin:/bin",
                    "LC_ALL=C",
                    "/usr/bin/true",
                ),
                SNAPSHOT_SCAN_PREFLIGHT_COMMAND_TIMEOUT_SECONDS,
                PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT,
                PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT,
            )
        except ProbeFailure:
            raise ProbeFailure("snapshot-scan:sudo") from None
        if sudo.returncode != 0 or sudo.stdout or sudo.stderr:
            raise ProbeFailure("snapshot-scan:sudo")

    @staticmethod
    def _invoke_privileged_snapshot_scan() -> None:
        completed = run_bounded_snapshot_subprocess(
            INTERNAL_SNAPSHOT_SCAN_COMMAND,
            PRIVILEGED_SNAPSHOT_SCAN_TIMEOUT_SECONDS,
            PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT,
            PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT,
        )

        stdout = completed.stdout
        stderr = completed.stderr
        if not isinstance(stdout, bytes) or not isinstance(stderr, bytes):
            raise ProbeFailure("snapshot-scan:protocol")
        if len(stdout) > PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT:
            raise ProbeFailure("snapshot-scan:stdout-overflow")
        if len(stderr) > PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT:
            raise ProbeFailure("snapshot-scan:stderr-overflow")
        if len(stdout) + len(stderr) > PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT:
            raise ProbeFailure("snapshot-scan:output-overflow")
        if completed.returncode < 0:
            raise ProbeFailure("snapshot-scan:aborted")
        if completed.returncode not in {0, 1}:
            raise ProbeFailure("snapshot-scan:unexpected-exit")
        begin = f"{INTERNAL_SNAPSHOT_SCAN_BEGIN}\n".encode("ascii")
        if not stdout.startswith(begin):
            raise ProbeFailure("snapshot-scan:bootstrap")
        if stderr:
            raise ProbeFailure("snapshot-scan:stderr")
        success = begin + f"{INTERNAL_SNAPSHOT_SCAN_SUCCESS}\n".encode("ascii")
        if completed.returncode == 0:
            if stdout != success:
                raise ProbeFailure("snapshot-scan:protocol")
            return
        error_prefix = begin + f"{INTERNAL_SNAPSHOT_SCAN_ERROR} ".encode("ascii")
        if not stdout.startswith(error_prefix) or not stdout.endswith(b"\n"):
            raise ProbeFailure("snapshot-scan:protocol")
        encoded_failure_code = stdout[len(error_prefix) : -1]
        if not encoded_failure_code or b"\n" in encoded_failure_code:
            raise ProbeFailure("snapshot-scan:protocol")
        try:
            failure_code = encoded_failure_code.decode("ascii", "strict")
        except UnicodeError:
            raise ProbeFailure("snapshot-scan:protocol") from None
        if failure_code not in SNAPSHOT_SCAN_FAILURE_CODES:
            raise ProbeFailure("snapshot-scan:unknown-code")
        raise ProbeFailure(failure_code)

    def _scan_snapshot_filesystems(self) -> None:
        self._validate_privileged_snapshot_scan_preflight()
        self.complete("packages.snapshot-preflight")
        before = self._snapshot_scan_state()
        scan_error: Exception | None = None
        try:
            self._invoke_privileged_snapshot_scan()
        except Exception as error:
            scan_error = error

        state_error: Exception | None = None
        try:
            after = self._snapshot_scan_state()
            self.assert_true(
                after == before,
                "privileged snapshot scan preserves exact daemon and inventory state",
                repr((before, after)),
            )
        except Exception as error:
            state_error = error

        if scan_error is not None:
            if state_error is not None:
                raise ProbeFailure(
                    f"{scan_error}; privileged snapshot scan postcondition also failed"
                ) from None
            raise scan_error
        if state_error is not None:
            raise state_error
        self.complete("packages.snapshot-residue")

    @staticmethod
    def _require_real_directory(path: Path, failure_prefix: str) -> os.stat_result:
        try:
            observed = path.lstat()
        except FileNotFoundError:
            raise ProbeFailure(f"{failure_prefix}:missing") from None
        except OSError:
            raise ProbeFailure(f"{failure_prefix}:inspect") from None
        if stat.S_ISLNK(observed.st_mode):
            raise ProbeFailure(f"{failure_prefix}:symlink")
        if not stat.S_ISDIR(observed.st_mode):
            raise ProbeFailure(f"{failure_prefix}:type")
        return observed

    @staticmethod
    def _stable_file_identity(observed: os.stat_result) -> tuple[int, ...]:
        return (
            observed.st_dev,
            observed.st_ino,
            observed.st_mode,
            observed.st_nlink,
            observed.st_uid,
            observed.st_gid,
            observed.st_size,
            observed.st_mtime_ns,
            observed.st_ctime_ns,
        )

    @classmethod
    def _validate_stable_bounded_regular_file(
        cls,
        path: Path,
        *,
        failure_prefix: str,
        maximum_size: int,
        require_nonempty: bool,
        deadline: float,
    ) -> None:
        try:
            initial = path.lstat()
        except FileNotFoundError:
            raise ProbeFailure(f"{failure_prefix}:missing") from None
        except OSError:
            raise ProbeFailure(f"{failure_prefix}:inspect") from None
        if stat.S_ISLNK(initial.st_mode):
            raise ProbeFailure(f"{failure_prefix}:symlink")
        if not stat.S_ISREG(initial.st_mode):
            raise ProbeFailure(f"{failure_prefix}:type")
        if initial.st_nlink != 1:
            raise ProbeFailure(f"{failure_prefix}:links")
        if require_nonempty and initial.st_size == 0:
            raise ProbeFailure(f"{failure_prefix}:empty")
        if initial.st_size < 0 or initial.st_size > maximum_size:
            raise ProbeFailure(f"{failure_prefix}:bounds")

        flags = os.O_RDONLY | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = -1
        close_failed = False
        try:
            descriptor = os.open(path, flags)
            opened = os.fstat(descriptor)
            if cls._stable_file_identity(opened) != cls._stable_file_identity(initial):
                raise ProbeFailure(f"{failure_prefix}:unstable")
            observed_size = 0
            while True:
                if time.monotonic() > deadline:
                    raise ProbeFailure("BuildKit/VFS snapshot residue scan timed out")
                chunk = os.read(
                    descriptor, min(64 * 1024, maximum_size + 1 - observed_size)
                )
                if not chunk:
                    break
                observed_size += len(chunk)
                if observed_size > maximum_size:
                    raise ProbeFailure(f"{failure_prefix}:bounds")
            final = os.fstat(descriptor)
        except ProbeFailure:
            raise
        except OSError:
            raise ProbeFailure(f"{failure_prefix}:inspect") from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    close_failed = True

        if close_failed:
            raise ProbeFailure(f"{failure_prefix}:inspect")
        try:
            final_path = path.lstat()
        except OSError:
            raise ProbeFailure(f"{failure_prefix}:unstable") from None

        if (
            observed_size != initial.st_size
            or cls._stable_file_identity(final) != cls._stable_file_identity(initial)
            or cls._stable_file_identity(final_path)
            != cls._stable_file_identity(initial)
        ):
            raise ProbeFailure(f"{failure_prefix}:unstable")

    @classmethod
    def _validate_buildkit_graphdriver_state(cls, deadline: float) -> None:
        buildkit_root = DAEMON_DATA_ROOT / "buildkit"
        cls._require_real_directory(buildkit_root, "snapshot-root:buildkit")

        unsupported_snapshot_root = buildkit_root / "snapshots"
        try:
            unsupported_snapshot_root.lstat()
        except FileNotFoundError:
            pass
        except OSError:
            raise ProbeFailure("buildkit-layout:snapshots-inspect") from None
        else:
            raise ProbeFailure("buildkit-layout:snapshots-present")

        cls._validate_stable_bounded_regular_file(
            buildkit_root / "snapshots.db",
            failure_prefix="buildkit-metadata",
            maximum_size=MAX_BUILDKIT_SNAPSHOT_METADATA_BYTES,
            require_nonempty=True,
            deadline=deadline,
        )

        executor_root = buildkit_root / "executor"
        cls._require_real_directory(executor_root, "buildkit-executor")
        try:
            entries = tuple(
                sorted(executor_root.iterdir(), key=lambda entry: entry.name)
            )
        except OSError:
            raise ProbeFailure("buildkit-executor:inspect") from None
        for entry in entries:
            try:
                maximum_size = BUILDKIT_EXECUTOR_ARTIFACT_LIMITS[entry.name]
            except KeyError:
                raise ProbeFailure("buildkit-executor:entry") from None
            cls._validate_stable_bounded_regular_file(
                entry,
                failure_prefix="buildkit-executor:artifact",
                maximum_size=maximum_size,
                require_nonempty=entry.name != "runc-log.json",
                deadline=deadline,
            )

    @classmethod
    def _validated_snapshot_roots(
        cls, deadline: float
    ) -> tuple[tuple[SnapshotRootClass, Path], ...]:
        roots: tuple[tuple[SnapshotRootClass, Path], ...] = (
            ("vfs", DAEMON_DATA_ROOT / "vfs" / "dir"),
        )
        for root_class, root in roots:
            cls._require_real_directory(root, f"snapshot-root:{root_class}")
        cls._validate_buildkit_graphdriver_state(deadline)
        return roots

    @staticmethod
    def _require_snapshot_scan_capabilities() -> None:
        required_flags = (
            "O_CLOEXEC",
            "O_DIRECTORY",
            "O_NOFOLLOW",
            "O_NONBLOCK",
            "O_PATH",
        )
        if (
            sys.platform != "linux"
            or any(not hasattr(os, flag) for flag in required_flags)
            or os.open not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd
            or os.readlink not in os.supports_dir_fd
            or os.scandir not in os.supports_fd
            or os.stat not in os.supports_follow_symlinks
        ):
            raise ProbeFailure("snapshot-scan:capability")

        descriptor = -1
        try:
            descriptor = os.open(
                "/proc/self/fd",
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            )
        except OSError:
            raise ProbeFailure("snapshot-scan:capability") from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    raise ProbeFailure("snapshot-scan:capability") from None

    @staticmethod
    def _snapshot_component_bytes(name: str) -> bytes:
        if (
            not isinstance(name, str)
            or not name
            or name in {".", ".."}
            or name.startswith("/")
            or "/" in name
            or "\0" in name
        ):
            raise ProbeFailure("snapshot-scan:entry-name")
        try:
            encoded = name.encode("utf-8", "strict")
        except UnicodeError:
            raise ProbeFailure("snapshot-scan:entry-name") from None
        if (
            not encoded
            or encoded.startswith(b"/")
            or b"/" in encoded
            or b"\0" in encoded
        ):
            raise ProbeFailure("snapshot-scan:entry-name")
        return encoded

    @classmethod
    def _snapshot_identity_is_exact(
        cls, observed: os.stat_result, expected: os.stat_result
    ) -> bool:
        return cls._stable_file_identity(observed) == cls._stable_file_identity(
            expected
        )

    @staticmethod
    def _raise_snapshot_operation_failure(
        phase: str, error: OSError, *, replacement_possible: bool
    ) -> None:
        replacement_errnos = {
            errno.ENOENT,
            errno.ESTALE,
            errno.ELOOP,
            errno.ENOTDIR,
            errno.EINVAL,
        }
        if replacement_possible and error.errno in replacement_errnos:
            raise ProbeFailure("snapshot-scan:unstable") from None
        raise_snapshot_entry_failure(phase, error)

    @classmethod
    def _close_snapshot_descriptors(
        cls,
        descriptors: Sequence[int],
        *,
        phase: str,
        primary_error: BaseException | None,
    ) -> None:
        close_error: OSError | None = None
        for descriptor in reversed(descriptors):
            if descriptor < 0:
                continue
            try:
                os.close(descriptor)
            except OSError as error:
                if close_error is None:
                    close_error = error
        if primary_error is None and close_error is not None:
            cls._raise_snapshot_operation_failure(
                phase, close_error, replacement_possible=False
            )

    @classmethod
    def _open_snapshot_directory(
        cls,
        parent_descriptor: int,
        component: bytes,
        expected: os.stat_result,
    ) -> int:
        descriptor = -1
        primary_error: BaseException | None = None
        try:
            try:
                descriptor = os.open(
                    component,
                    os.O_RDONLY
                    | os.O_DIRECTORY
                    | os.O_NONBLOCK
                    | os.O_NOFOLLOW
                    | os.O_CLOEXEC,
                    dir_fd=parent_descriptor,
                )
                opened = os.fstat(descriptor)
            except OSError as error:
                cls._raise_snapshot_operation_failure(
                    "directory-open", error, replacement_possible=True
                )
            if not stat.S_ISDIR(opened.st_mode) or not cls._snapshot_identity_is_exact(
                opened, expected
            ):
                raise ProbeFailure("snapshot-scan:unstable")
            return descriptor
        except BaseException as error:
            primary_error = error
            raise
        finally:
            if primary_error is not None:
                cls._close_snapshot_descriptors(
                    (descriptor,),
                    phase="directory-close",
                    primary_error=primary_error,
                )

    @classmethod
    def _open_pinned_snapshot_regular_file(
        cls,
        parent_descriptor: int,
        component: bytes,
        expected: os.stat_result,
    ) -> tuple[int, int]:
        pin_descriptor = -1
        read_descriptor = -1
        primary_error: BaseException | None = None
        try:
            try:
                pin_descriptor = os.open(
                    component,
                    os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=parent_descriptor,
                )
                pinned = os.fstat(pin_descriptor)
            except OSError as error:
                cls._raise_snapshot_operation_failure(
                    "file-pin", error, replacement_possible=True
                )
            if not stat.S_ISREG(pinned.st_mode) or not cls._snapshot_identity_is_exact(
                pinned, expected
            ):
                raise ProbeFailure("snapshot-scan:unstable")

            try:
                read_descriptor = os.open(
                    f"/proc/self/fd/{pin_descriptor}",
                    os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC,
                )
                opened = os.fstat(read_descriptor)
            except OSError as error:
                cls._raise_snapshot_operation_failure(
                    "file-open", error, replacement_possible=False
                )
            if not stat.S_ISREG(opened.st_mode) or not cls._snapshot_identity_is_exact(
                opened, pinned
            ):
                raise ProbeFailure("snapshot-scan:unstable")
            return pin_descriptor, read_descriptor
        except BaseException as error:
            primary_error = error
            raise
        finally:
            if primary_error is not None:
                cls._close_snapshot_descriptors(
                    (pin_descriptor, read_descriptor),
                    phase="file-close",
                    primary_error=primary_error,
                )

    def _scan_snapshot_filesystems_core(self) -> None:
        self._require_snapshot_scan_capabilities()
        deadline = time.monotonic() + PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS
        roots = self._validated_snapshot_roots(deadline)
        exact_forbidden = self._snapshot_authority_contents()
        scanned_files = {root_class: 0 for root_class, _root in roots}
        scanned_bytes = 0
        scanned_entries = 0
        ca_public_spki = self._ca_public_spki(deadline)
        key_scan_budget = PrivateKeyScanBudget(
            remaining_candidates=MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN,
            deadline=deadline,
        )

        for root_class, root in roots:
            try:
                root_expected = root.lstat()
            except OSError as error:
                self._raise_snapshot_operation_failure(
                    "metadata", error, replacement_possible=True
                )
            root_descriptor = -1
            root_error: BaseException | None = None
            try:
                try:
                    root_descriptor = os.open(
                        root,
                        os.O_RDONLY
                        | os.O_DIRECTORY
                        | os.O_NONBLOCK
                        | os.O_NOFOLLOW
                        | os.O_CLOEXEC,
                    )
                    root_opened = os.fstat(root_descriptor)
                except OSError as error:
                    self._raise_snapshot_operation_failure(
                        "root-open", error, replacement_possible=True
                    )
                if not stat.S_ISDIR(
                    root_opened.st_mode
                ) or not self._snapshot_identity_is_exact(root_opened, root_expected):
                    raise ProbeFailure("snapshot-scan:unstable")

                def scan_directory(
                    directory_descriptor: int,
                    relative_parts: tuple[str, ...],
                    expected: os.stat_result,
                    *,
                    parent_descriptor: int | None,
                    component: bytes | None,
                    depth: int,
                ) -> None:
                    nonlocal scanned_bytes, scanned_entries
                    if depth > MAX_SNAPSHOT_DIRECTORY_DEPTH:
                        raise ProbeFailure("snapshot-scan:depth-bound")
                    try:
                        opened_before = os.fstat(directory_descriptor)
                    except OSError as error:
                        self._raise_snapshot_operation_failure(
                            "metadata", error, replacement_possible=False
                        )
                    if not stat.S_ISDIR(
                        opened_before.st_mode
                    ) or not self._snapshot_identity_is_exact(opened_before, expected):
                        raise ProbeFailure("snapshot-scan:unstable")

                    def scan_entry(encoded_name: bytes, name: str) -> None:
                        nonlocal scanned_bytes
                        if time.monotonic() > deadline:
                            raise ProbeFailure(
                                "BuildKit/VFS snapshot residue scan timed out"
                            )
                        entry_parts = (*relative_parts, name)
                        if any(
                            entry_parts[index : index + 2] == ("dev", "ironcurtain")
                            for index in range(len(entry_parts) - 1)
                        ):
                            raise ProbeFailure(
                                "snapshot contains an IronCurtain trust mount stub"
                            )
                        try:
                            entry_expected = os.stat(
                                encoded_name,
                                dir_fd=directory_descriptor,
                                follow_symlinks=False,
                            )
                        except OSError as error:
                            self._raise_snapshot_operation_failure(
                                "metadata", error, replacement_possible=True
                            )

                        if stat.S_ISLNK(entry_expected.st_mode):
                            try:
                                link_target = os.readlink(
                                    encoded_name, dir_fd=directory_descriptor
                                )
                                entry_final = os.stat(
                                    encoded_name,
                                    dir_fd=directory_descriptor,
                                    follow_symlinks=False,
                                )
                            except OSError as error:
                                self._raise_snapshot_operation_failure(
                                    "symlink-read", error, replacement_possible=True
                                )
                            if not self._snapshot_identity_is_exact(
                                entry_final, entry_expected
                            ):
                                raise ProbeFailure("snapshot-scan:unstable")
                            normalized_target = self._normalize_symlink_target(
                                relative_parts, link_target
                            )
                            if any(
                                normalized_target[index : index + 2]
                                == ("dev", "ironcurtain")
                                for index in range(len(normalized_target) - 1)
                            ):
                                raise ProbeFailure(
                                    "snapshot link reaches an IronCurtain trust mount"
                                )
                            return

                        if stat.S_ISDIR(entry_expected.st_mode):
                            child_descriptor = -1
                            child_error: BaseException | None = None
                            try:
                                child_descriptor = self._open_snapshot_directory(
                                    directory_descriptor,
                                    encoded_name,
                                    entry_expected,
                                )
                                scan_directory(
                                    child_descriptor,
                                    entry_parts,
                                    entry_expected,
                                    parent_descriptor=directory_descriptor,
                                    component=encoded_name,
                                    depth=depth + 1,
                                )
                            except BaseException as error:
                                child_error = error
                                raise
                            finally:
                                self._close_snapshot_descriptors(
                                    (child_descriptor,),
                                    phase="directory-close",
                                    primary_error=child_error,
                                )
                            return

                        if not stat.S_ISREG(entry_expected.st_mode):
                            raise ProbeFailure("snapshot-scan:special-entry")

                        if entry_expected.st_size < 0:
                            raise ProbeFailure("snapshot-scan:unstable")
                        scanned_bytes += entry_expected.st_size
                        if scanned_bytes > MAX_SNAPSHOT_SCAN_LOGICAL_BYTES:
                            raise ProbeFailure("snapshot-scan:logical-byte-bound")
                        pin_descriptor = -1
                        read_descriptor = -1
                        file_error: BaseException | None = None
                        try:
                            pin_descriptor, read_descriptor = (
                                self._open_pinned_snapshot_regular_file(
                                    directory_descriptor,
                                    encoded_name,
                                    entry_expected,
                                )
                            )
                            try:
                                with os.fdopen(
                                    read_descriptor, "rb", closefd=False
                                ) as handle:
                                    observed_size, _digest, found, contains_ca_key = (
                                        self._fingerprint_stream(
                                            handle,
                                            exact_forbidden,
                                            entry_expected.st_size,
                                            ca_public_spki=ca_public_spki,
                                            key_scan_budget=key_scan_budget,
                                            deadline=deadline,
                                            compute_digest=False,
                                        )
                                    )
                            except OSError as error:
                                self._raise_snapshot_operation_failure(
                                    "file-read", error, replacement_possible=True
                                )
                            try:
                                read_final = os.fstat(read_descriptor)
                                pin_final = os.fstat(pin_descriptor)
                                path_final = os.stat(
                                    encoded_name,
                                    dir_fd=directory_descriptor,
                                    follow_symlinks=False,
                                )
                            except OSError:
                                raise ProbeFailure("snapshot-scan:unstable") from None
                            if any(
                                not self._snapshot_identity_is_exact(
                                    observed, entry_expected
                                )
                                for observed in (read_final, pin_final, path_final)
                            ):
                                raise ProbeFailure("snapshot-scan:unstable")
                            if observed_size != entry_expected.st_size:
                                raise ProbeFailure("snapshot-scan:unstable")
                            if contains_ca_key:
                                raise ProbeFailure(
                                    "snapshot contains the IronCurtain CA private key"
                                )
                            if any(marker in exact_forbidden for marker in found):
                                raise ProbeFailure(
                                    "snapshot contains exact IronCurtain public trust residue"
                                )
                            scanned_files[root_class] += 1
                        except BaseException as error:
                            file_error = error
                            raise
                        finally:
                            self._close_snapshot_descriptors(
                                (pin_descriptor, read_descriptor),
                                phase="file-close",
                                primary_error=file_error,
                            )

                    try:
                        with os.scandir(directory_descriptor) as entries:
                            for entry in entries:
                                if time.monotonic() > deadline:
                                    raise ProbeFailure(
                                        "BuildKit/VFS snapshot residue scan timed out"
                                    )
                                encoded_name = self._snapshot_component_bytes(
                                    entry.name
                                )
                                scanned_entries += 1
                                if scanned_entries > MAX_SNAPSHOT_SCAN_ENTRIES:
                                    raise ProbeFailure("snapshot-scan:entry-bound")
                                scan_entry(encoded_name, entry.name)
                    except ProbeFailure:
                        raise
                    except OSError as error:
                        self._raise_snapshot_operation_failure(
                            "enumerate", error, replacement_possible=True
                        )
                    try:
                        opened_after_enumeration = os.fstat(directory_descriptor)
                    except OSError as error:
                        self._raise_snapshot_operation_failure(
                            "metadata", error, replacement_possible=False
                        )
                    if not self._snapshot_identity_is_exact(
                        opened_after_enumeration, expected
                    ):
                        raise ProbeFailure("snapshot-scan:unstable")

                    try:
                        opened_final = os.fstat(directory_descriptor)
                        path_final = (
                            root.lstat()
                            if parent_descriptor is None
                            else os.stat(
                                component,
                                dir_fd=parent_descriptor,
                                follow_symlinks=False,
                            )
                        )
                    except OSError:
                        raise ProbeFailure("snapshot-scan:unstable") from None
                    if not self._snapshot_identity_is_exact(
                        opened_final, expected
                    ) or not self._snapshot_identity_is_exact(path_final, expected):
                        raise ProbeFailure("snapshot-scan:unstable")

                scan_directory(
                    root_descriptor,
                    (),
                    root_expected,
                    parent_descriptor=None,
                    component=None,
                    depth=0,
                )
            except BaseException as error:
                root_error = error
                raise
            finally:
                self._close_snapshot_descriptors(
                    (root_descriptor,),
                    phase="directory-close",
                    primary_error=root_error,
                )

            if scanned_files[root_class] <= 0:
                raise ProbeFailure(f"snapshot-root:{root_class}:empty")

    def _snapshot_authority_contents(self) -> tuple[bytes, ...]:
        """Return the per-session authority contents that cannot persist in VFS."""
        return self._exact_authority_markers()[:3]

    def _exact_authority_markers(self) -> tuple[bytes, ...]:
        if self.authority_marker_cache is not None:
            return self.authority_marker_cache
        try:
            certificate = AGENT_CA_CERT.read_bytes().strip()
            apt_config = PACKAGE_APT_CONFIG.read_bytes().strip()
            contract = PACKAGE_CONTRACT.read_bytes().strip()
        except OSError:
            raise ProbeFailure("snapshot authority input is unavailable") from None
        self.assert_true(
            certificate.startswith(b"-----BEGIN CERTIFICATE-----"), "agent CA is PEM"
        )
        paths = (
            PACKAGE_PROXY,
            "/dev/ironcurtain/ca-cert.pem",
            "/dev/ironcurtain/ca-bundle.pem",
            "/dev/ironcurtain/apt.conf",
            "/dev/ironcurtain/ca-key.pem",
            str(PACKAGE_CONFIG),
            str(PACKAGE_CONTRACT),
            str(PACKAGE_RUNC),
        )
        self.authority_marker_cache = (
            certificate,
            apt_config,
            contract,
            *(path.encode() for path in paths),
            b"IRONCURTAIN_API_KEY",
            b"sk-ant-api03-IRONCURTAIN-WORKFLOW-SMOKE-FAKE-ONLY",
        )
        return self.authority_marker_cache

    @staticmethod
    def _injected_env_names() -> tuple[str, ...]:
        return (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "CURL_CA_BUNDLE",
            "GIT_SSL_CAINFO",
            "npm_config_cafile",
            "PIP_CERT",
            "REQUESTS_CA_BUNDLE",
            "CARGO_HTTP_CAINFO",
            "APT_CONFIG",
            "npm_config_audit",
            "PIP_DISABLE_PIP_VERSION_CHECK",
            "UV_NATIVE_TLS",
        )

    def _assert_outer_tcp_refused(self, port: int) -> None:
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        connection.settimeout(OUTER_RELAY_REFUSAL_TIMEOUT_SECONDS)
        try:
            try:
                connection.connect(("127.0.0.1", port))
            except ConnectionRefusedError:
                return
            except socket.timeout as error:
                raise ProbeFailure(
                    f"outer relay {port} timed out instead of refusing"
                ) from error
            except OSError as error:
                if error.errno == errno.ECONNREFUSED:
                    return
                raise ProbeFailure(
                    f"outer relay {port} failed with errno {error.errno} instead of refusing"
                ) from error
            raise ProbeFailure(f"outer relay {port} is unexpectedly reachable")
        finally:
            connection.close()

    def _validate_host_relay_observations(
        self, observations: object, expected: dict[int, bool]
    ) -> None:
        self.assert_true(
            isinstance(observations, list)
            and len(observations) == len(HOST_RELAY_SPECS),
            "host relay probe returned exact observation count",
            repr(observations),
        )
        for observation, (port, _path, marker) in zip(
            observations, HOST_RELAY_SPECS, strict=True
        ):
            wanted = (
                {
                    "body": marker,
                    "outcome": "response",
                    "port": port,
                    "status": "HTTP/1.1 200 OK",
                }
                if expected[port]
                else {"outcome": "refused", "port": port}
            )
            self.assert_true(
                observation == wanted,
                f"host relay {port} matches expected topology",
                repr((wanted, observation)),
            )

    def _raw_package_proxy(
        self, request_method: HttpRequestMethod, request: bytes
    ) -> bytes:
        self._validate_request_method(request_method, request)
        connection = self._open_package_socket()
        try:
            connection.sendall(request)
            return self._read_response(connection, request_method)
        finally:
            connection.close()

    def _open_connect(self, host: str, port: int) -> socket.socket:
        connection = self._open_package_socket()
        request = (
            f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode(
                "ascii"
            )
        )
        connection.sendall(request)
        response = self._read_headers(connection)
        if not response.startswith(b"HTTP/1.1 200"):
            connection.close()
            raise ProbeFailure(f"package CONNECT failed: {response[:1024]!r}")
        return connection

    @staticmethod
    def _open_package_socket() -> socket.socket:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(10)
        try:
            connection.connect(str(PACKAGE_SOCKET))
        except OSError:
            connection.close()
            raise
        return connection

    def _tls_package_request(
        self,
        request_method: HttpRequestMethod,
        connect_host: str,
        sni: str,
        request: bytes,
    ) -> bytes:
        self._validate_request_method(request_method, request)
        connection = self._open_connect(connect_host, 443)
        context = ssl.create_default_context(cafile=str(AGENT_CA_CERT))
        wrapped = context.wrap_socket(connection, server_hostname=sni)
        try:
            wrapped.sendall(request)
            return self._read_response(wrapped, request_method)
        finally:
            wrapped.close()

    def _record_cache_audit_sentinel(self, label: Literal["before", "after"]) -> str:
        path = f"/ironcurtain-cache-{label}-{self.nonce}"
        response = self._tls_package_request(
            "HEAD",
            "registry.npmjs.org",
            "registry.npmjs.org",
            (
                f"HEAD {path} HTTP/1.1\r\n"
                "Host: registry.npmjs.org\r\n"
                "Connection: close\r\n\r\n"
            ).encode("ascii"),
        )
        status, body = self._decode_exact_http_response(response, "HEAD")
        self.assert_true(
            status == "HTTP/1.1 404 Not Found" and body == b"",
            f"cache {label} audit sentinel completed with exact bodyless 404",
            repr(response[:1024]),
        )
        return path

    @staticmethod
    def _validate_request_method(
        request_method: HttpRequestMethod, request: bytes
    ) -> None:
        request_line, separator, _remainder = request.partition(b"\r\n")
        parts = request_line.split(b" ")
        if (
            not separator
            or len(parts) != 3
            or parts[0] != request_method.encode("ascii")
            or not parts[1]
            or parts[2] != b"HTTP/1.1"
        ):
            raise ProbeFailure(
                f"explicit request method {request_method!r} does not match exact HTTP/1.1 request line"
            )

    @staticmethod
    def _read_headers(connection: socket.socket) -> bytes:
        connection.settimeout(10)
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 32 * 1024:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
        return response

    @classmethod
    def _read_response(
        cls, connection: socket.socket, request_method: HttpRequestMethod
    ) -> bytes:
        connection.settimeout(10)
        response = b""
        while True:
            try:
                chunk = connection.recv(
                    min(16 * 1024, OUTER_PACKAGE_RESPONSE_LIMIT + 1 - len(response))
                )
            except OSError as error:
                raise ProbeFailure("package response failed before peer EOF") from error
            if not chunk:
                cls._decode_exact_http_response(response, request_method)
                return response
            response += chunk
            if len(response) > OUTER_PACKAGE_RESPONSE_LIMIT:
                raise ProbeFailure("package response exceeds its exact byte limit")

    @classmethod
    def _exact_http_body(
        cls,
        response: bytes,
        request_method: HttpRequestMethod,
        expected_status: str,
    ) -> bytes:
        status, body = cls._decode_exact_http_response(response, request_method)
        if status != expected_status:
            raise ProbeFailure(f"HTTP status {status!r}, expected {expected_status!r}")
        return body

    @staticmethod
    def _decode_exact_http_response(
        response: bytes, request_method: HttpRequestMethod
    ) -> tuple[str, bytes]:
        if request_method not in {"CONNECT", "GET", "HEAD", "POST"}:
            raise ProbeFailure(f"unsupported HTTP request method: {request_method!r}")
        if len(response) > OUTER_PACKAGE_RESPONSE_LIMIT:
            raise ProbeFailure("package response exceeds its exact byte limit")
        headers, separator, body = response.partition(b"\r\n\r\n")
        if separator == b"" or not headers:
            raise ProbeFailure(
                f"HTTP response lacks complete headers: {response[:1024]!r}"
            )
        lines = headers.split(b"\r\n")
        try:
            status = lines[0].decode("ascii", "strict")
        except UnicodeError as error:
            raise ProbeFailure("HTTP status is not ASCII") from error
        status_match = re.fullmatch(
            r"HTTP/1\.1 ([1-5][0-9]{2})(?: [\x20-\x7e]*)?", status
        )
        if status_match is None or int(status_match.group(1)) < 200:
            raise ProbeFailure("HTTP response lacks one final HTTP/1.1 status")
        parsed_headers: dict[bytes, bytes] = {}
        for line in lines[1:]:
            name, found, value = line.partition(b":")
            if not found:
                raise ProbeFailure(f"malformed HTTP header: {line[:256]!r}")
            lowered = name.strip().lower()
            if lowered in {b"content-length", b"transfer-encoding", b"connection"}:
                if lowered in parsed_headers:
                    raise ProbeFailure(f"duplicate framing header: {lowered!r}")
                parsed_headers[lowered] = value.strip().lower()
        if parsed_headers.get(b"connection") != b"close":
            raise ProbeFailure("HTTP response does not require connection close")
        transfer_encoding = parsed_headers.get(b"transfer-encoding")
        content_length = parsed_headers.get(b"content-length")
        if transfer_encoding is not None and content_length is not None:
            raise ProbeFailure("HTTP response has ambiguous framing")
        if request_method == "HEAD":
            if status != "HTTP/1.1 404 Not Found":
                raise ProbeFailure("HEAD sentinel response is not exact HTTP/1.1 404")
            if content_length is not None or transfer_encoding is not None:
                raise ProbeFailure("HEAD sentinel response must not use CL or TE")
            if body:
                raise ProbeFailure("HEAD response contains a body or EOF residue")
            return status, b""
        parsed_content_length: int | None = None
        if content_length is not None:
            if (
                not content_length
                or len(content_length) > 20
                or any(byte not in b"0123456789" for byte in content_length)
                or (len(content_length) > 1 and content_length.startswith(b"0"))
            ):
                raise ProbeFailure("invalid HTTP content length")
            parsed_content_length = int(content_length)
            if parsed_content_length > 0x7FFF_FFFF_FFFF_FFFF:
                raise ProbeFailure("HTTP content length exceeds its numeric bound")
        if transfer_encoding not in {None, b"chunked"}:
            raise ProbeFailure(
                f"unsupported HTTP transfer encoding: {transfer_encoding!r}"
            )
        if transfer_encoding == b"chunked":
            decoded = b""
            remaining = body
            while True:
                size_line, found, remaining = remaining.partition(b"\r\n")
                if (
                    not found
                    or not size_line
                    or any(byte not in b"0123456789abcdefABCDEF" for byte in size_line)
                    or (len(size_line) > 1 and size_line.startswith(b"0"))
                ):
                    raise ProbeFailure("malformed chunked HTTP response")
                size = int(size_line, 16)
                if size == 0:
                    if remaining != b"\r\n":
                        raise ProbeFailure(
                            "chunked HTTP response has trailers or residue"
                        )
                    return status, decoded
                if (
                    size > OUTER_PACKAGE_RESPONSE_LIMIT - len(decoded)
                    or len(remaining) < size + 2
                ):
                    raise ProbeFailure(
                        "chunked HTTP response exceeds bounds or is truncated"
                    )
                decoded += remaining[:size]
                if remaining[size : size + 2] != b"\r\n":
                    raise ProbeFailure("chunked HTTP response lacks delimiter")
                remaining = remaining[size + 2 :]
        if parsed_content_length is None:
            raise ProbeFailure("identity HTTP response lacks content length")
        if (
            parsed_content_length > OUTER_PACKAGE_RESPONSE_LIMIT
            or len(body) != parsed_content_length
        ):
            raise ProbeFailure(
                "HTTP body length does not match exact bounded content length"
            )
        return status, body

    @staticmethod
    def _require_403(response: bytes, label: str) -> None:
        if not response.startswith(b"HTTP/1.1 403"):
            raise ProbeFailure(
                f"{label} lacked exact package-policy 403: {response[:1024]!r}"
            )

    def _write_generated_context(self, name: str, dockerfile: str) -> Path:
        directory = WORKSPACE / ".workflow" / "generated" / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "Dockerfile").write_text(dockerfile, encoding="utf-8")
        return directory

    def _write_form_context(self, label: str, base_reference: str) -> Path:
        payload = json.dumps({"form": label}, sort_keys=True) + "\n"
        command = json.dumps(
            ["node", "-e", f"process.stdout.write({json.dumps(payload)})"]
        )
        context = self._write_generated_context(
            f"packages-{label}",
            f"FROM {base_reference}\n"
            f"{form_check_run_command()}\n"
            f'LABEL org.ironcurtain.workflow.build-form="{label}"\n'
            f"CMD {command}\n",
        )
        return context

    def _selected_image_reference(self, image_id: str) -> str:
        self.assert_true(
            self.initial_image_ids == (image_id,),
            "offline selected image identity is exact",
        )
        try:
            tags = json.loads(
                self.docker(
                    "image", "inspect", "--format", "{{json .RepoTags}}", image_id
                ).stdout
            )
        except json.JSONDecodeError:
            raise ProbeFailure("offline selected image tags are malformed") from None
        self.assert_true(
            isinstance(tags, list)
            and len(tags) == 1
            and isinstance(tags[0], str)
            and SELECTED_LOCAL_REFERENCE.fullmatch(tags[0]) is not None,
            "offline selected image has one safe local reference",
        )
        reference = tags[0]
        resolved = self.docker(
            "image", "inspect", "--format", "{{.Id}}", reference
        ).stdout.strip()
        self.assert_true(
            resolved == image_id,
            "offline selected local reference retains immutable identity",
        )
        return reference

    def _track_image(self, reference: str, *, fixture: bool = False) -> str:
        image_id = self.docker(
            "image", "inspect", "--format", "{{.Id}}", reference
        ).stdout.strip()
        if IMMUTABLE_ID.fullmatch(image_id) is None:
            raise ProbeFailure(
                f"image {reference!r} has malformed immutable ID: {image_id!r}"
            )
        if image_id not in self.initial_image_ids and image_id not in self.image_ids:
            self.image_ids.append(image_id)
        if fixture and image_id not in self.fixture_image_ids:
            self.fixture_image_ids.append(image_id)
        return image_id

    def _container_id(
        self, completed: subprocess.CompletedProcess[str], label: str
    ) -> str:
        container_id = completed.stdout.strip()
        if CONTAINER_ID.fullmatch(container_id) is None:
            container_id = self.docker(
                "container", "inspect", "--format", "{{.Id}}", label
            ).stdout.strip()
        if CONTAINER_ID.fullmatch(container_id) is None:
            raise ProbeFailure(
                f"{label} returned malformed immutable container ID: {container_id!r}"
            )
        return container_id

    @staticmethod
    def _validated_full_id_inventory(
        stdout: str, pattern: re.Pattern[str], label: str
    ) -> list[str]:
        identifiers = stdout.splitlines()
        if any(pattern.fullmatch(identifier) is None for identifier in identifiers):
            raise ProbeFailure(f"{label} contains a malformed full ID")
        if len(identifiers) != len(set(identifiers)):
            raise ProbeFailure(f"{label} contains duplicate full IDs")
        return sorted(identifiers)

    def _full_container_ids(self, *, all_containers: bool) -> list[str]:
        arguments = ["container", "ls"]
        if all_containers:
            arguments.append("--all")
        arguments.extend(("--quiet", "--no-trunc"))
        return self._validated_full_id_inventory(
            self.docker(*arguments).stdout,
            CONTAINER_ID,
            "Docker container inventory",
        )

    @staticmethod
    def _validated_image_id_inventory(stdout: str) -> list[str]:
        identifiers = stdout.splitlines()
        if any(
            IMMUTABLE_ID.fullmatch(identifier) is None for identifier in identifiers
        ):
            raise ProbeFailure("Docker image inventory contains a malformed full ID")
        return sorted(set(identifiers))

    def _all_image_ids(self) -> list[str]:
        return self._validated_image_id_inventory(
            self.docker("image", "ls", "--all", "--quiet", "--no-trunc").stdout
        )

    @staticmethod
    def _is_socket(path: Path) -> bool:
        try:
            return stat.S_ISSOCK(path.stat().st_mode)
        except FileNotFoundError:
            return False

    @staticmethod
    def _remaining_residue_scan_seconds(deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeFailure("residue scan exceeded its aggregate deadline")
        return remaining

    @staticmethod
    def _validated_link_target_parts(
        link_target: str | bytes,
    ) -> tuple[bool, tuple[str, ...]]:
        try:
            if isinstance(link_target, bytes):
                encoded_target = link_target
                decoded_target = link_target.decode("utf-8", "strict")
            else:
                encoded_target = link_target.encode("utf-8", "strict")
                decoded_target = link_target
        except UnicodeError as error:
            raise ProbeFailure("link target is not bounded canonical UTF-8") from error
        if (
            not encoded_target
            or len(encoded_target) > MAX_LINK_TARGET_BYTES
            or b"\0" in encoded_target
        ):
            raise ProbeFailure("link target is empty or outside its bound")
        return decoded_target.startswith("/"), tuple(decoded_target.split("/"))

    @classmethod
    def _normalize_symlink_target(
        cls, parent_parts: Sequence[str], link_target: str | bytes
    ) -> tuple[str, ...]:
        absolute, target_parts = cls._validated_link_target_parts(link_target)
        normalized = [] if absolute else list(parent_parts)
        for part in target_parts:
            if part in ("", "."):
                continue
            if part == "..":
                if normalized:
                    normalized.pop()
                continue
            normalized.append(part)
        return tuple(normalized)

    @classmethod
    def _normalize_hardlink_target(cls, link_target: str) -> tuple[str, ...]:
        absolute, target_parts = cls._validated_link_target_parts(link_target)
        if absolute:
            raise ProbeFailure("hardlink target must be archive-root-relative")
        normalized: list[str] = []
        for part in target_parts:
            if part in ("", "."):
                continue
            if part == "..":
                if not normalized:
                    raise ProbeFailure(
                        "hardlink target traverses outside the archive root"
                    )
                normalized.pop()
                continue
            normalized.append(part)
        if not normalized:
            raise ProbeFailure("hardlink target is empty after normalization")
        return tuple(normalized)

    def _ca_public_spki(self, deadline: float | None = None) -> bytes:
        if deadline is not None:
            self._remaining_residue_scan_seconds(deadline)
        if self.ca_public_spki_cache is not None:
            return self.ca_public_spki_cache
        timeout_seconds = 10.0
        if deadline is not None:
            timeout_seconds = min(
                timeout_seconds, self._remaining_residue_scan_seconds(deadline)
            )
        try:
            completed = subprocess.run(
                ["/usr/bin/openssl", "x509", "-pubkey", "-noout"],
                input=AGENT_CA_CERT.read_bytes(),
                capture_output=True,
                check=False,
                timeout=timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProbeFailure("public CA SPKI extraction failed closed") from error
        public_spki = completed.stdout.strip()
        if (
            completed.returncode != 0
            or not public_spki.startswith(b"-----BEGIN PUBLIC KEY-----\n")
            or not public_spki.endswith(b"\n-----END PUBLIC KEY-----")
            or len(public_spki) > MAX_PUBLIC_SPKI_PEM_BYTES
        ):
            raise ProbeFailure("public CA certificate has no bounded canonical SPKI")
        self.ca_public_spki_cache = public_spki
        return public_spki

    @staticmethod
    def _private_key_candidate_matches_spki(
        candidate: bytes, ca_public_spki: bytes, timeout_seconds: float
    ) -> bool:
        try:
            completed = subprocess.run(
                ["/usr/bin/openssl", "pkey", "-pubout"],
                input=candidate,
                capture_output=True,
                check=False,
                timeout=timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProbeFailure(
                "private-key candidate validation failed closed"
            ) from error
        if completed.returncode < 0:
            raise ProbeFailure("private-key candidate validation failed closed")
        if completed.returncode > 0:
            return False
        candidate_spki = completed.stdout.strip()
        if (
            not candidate_spki.startswith(b"-----BEGIN PUBLIC KEY-----\n")
            or not candidate_spki.endswith(b"\n-----END PUBLIC KEY-----")
            or len(candidate_spki) > MAX_PUBLIC_SPKI_PEM_BYTES
        ):
            raise ProbeFailure("private-key candidate produced an invalid public SPKI")
        return candidate_spki == ca_public_spki

    @classmethod
    def _fingerprint_stream(
        cls,
        handle: BinaryIO,
        markers: Sequence[bytes],
        max_bytes: int,
        *,
        ca_public_spki: bytes | None = None,
        key_scan_budget: PrivateKeyScanBudget | None = None,
        deadline: float | None = None,
        compute_digest: bool = True,
    ) -> tuple[int, str, tuple[bytes, ...], bool]:
        if (ca_public_spki is None) != (key_scan_budget is None):
            raise ProbeFailure("private-key scan authority and budget must be paired")
        scanned = 0
        overlap = b""
        longest = max((len(token) for token in markers), default=0)
        found: list[bytes] = []
        digest = hashlib.sha256() if compute_digest else None
        pem_line_buffer = bytearray()
        pem_discarding_line = False
        pem_candidate: bytearray | None = None
        pem_candidate_end: bytes | None = None
        pem_candidate_newline: bytes | None = None
        pem_candidate_body_lines = 0
        pem_candidate_previous_body_length: int | None = None
        pem_candidate_saw_padding = False
        pem_candidate_incomplete_plausible = False

        def inspect_pem_candidate(candidate: bytes) -> bool:
            if key_scan_budget is None:
                raise ProbeFailure("private-key scan budget is unavailable")
            if key_scan_budget.remaining_candidates <= 0:
                raise ProbeFailure("snapshot-scan:pem-candidate-bound")
            remaining_seconds = key_scan_budget.deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise ProbeFailure("private-key residue scan exceeded its deadline")
            key_scan_budget.remaining_candidates -= 1
            return cls._private_key_candidate_matches_spki(
                candidate,
                ca_public_spki,
                min(PRIVATE_KEY_PARSE_TIMEOUT_SECONDS, remaining_seconds),
            )

        def digest_hex() -> str:
            return "" if digest is None else digest.hexdigest()

        def reset_pem_candidate() -> None:
            nonlocal pem_candidate, pem_candidate_end, pem_candidate_newline
            nonlocal pem_candidate_body_lines
            nonlocal pem_candidate_previous_body_length
            nonlocal pem_candidate_saw_padding
            nonlocal pem_candidate_incomplete_plausible
            pem_candidate = None
            pem_candidate_end = None
            pem_candidate_newline = None
            pem_candidate_body_lines = 0
            pem_candidate_previous_body_length = None
            pem_candidate_saw_padding = False
            pem_candidate_incomplete_plausible = False

        def inspect_incomplete_pem_candidate() -> bool:
            if (
                pem_candidate is None
                or pem_candidate_end is None
                or pem_candidate_newline is None
                or pem_candidate_body_lines == 0
                or not pem_candidate_incomplete_plausible
            ):
                return False
            candidate = bytes(pem_candidate)
            if not candidate.endswith(b"\n"):
                candidate += pem_candidate_newline
            candidate += pem_candidate_end + pem_candidate_newline
            if len(candidate) > MAX_PRIVATE_KEY_PEM_BYTES:
                return False
            return inspect_pem_candidate(candidate)

        def is_canonical_pem_body_line(payload: bytes) -> bool:
            return (
                bool(payload)
                and len(payload) <= 64
                and len(payload) % 4 == 0
                and re.fullmatch(
                    rb"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?",
                    payload,
                )
                is not None
            )

        def consume_pem_line(line: bytes) -> bool:
            nonlocal pem_candidate, pem_candidate_end, pem_candidate_newline
            nonlocal pem_candidate_body_lines
            nonlocal pem_candidate_previous_body_length
            nonlocal pem_candidate_saw_padding
            nonlocal pem_candidate_incomplete_plausible
            if line.endswith(b"\r\n"):
                payload = line[:-2]
                newline = b"\r\n"
            elif line.endswith(b"\n"):
                payload = line[:-1]
                newline = b"\n"
            else:
                payload = line
                newline = None

            begin = next(
                (
                    (header, end)
                    for header, end in PRIVATE_KEY_PEM_BOUNDARIES
                    if payload == header
                ),
                None,
            )
            if begin is not None:
                if inspect_incomplete_pem_candidate():
                    return True
                _header, pem_candidate_end = begin
                pem_candidate = bytearray(line)
                pem_candidate_newline = newline
                pem_candidate_body_lines = 0
                pem_candidate_previous_body_length = None
                pem_candidate_saw_padding = False
                pem_candidate_incomplete_plausible = newline is not None
                return False
            if pem_candidate is None or pem_candidate_end is None:
                return False
            if len(pem_candidate) + len(line) > MAX_PRIVATE_KEY_PEM_BYTES:
                reset_pem_candidate()
                return False
            pem_candidate.extend(line)
            if payload == pem_candidate_end:
                candidate = bytes(pem_candidate)
                reset_pem_candidate()
                return inspect_pem_candidate(candidate)

            if pem_candidate_incomplete_plausible:
                newline_changed = (
                    newline is not None and newline != pem_candidate_newline
                )
                preceding_body_line_was_final = (
                    pem_candidate_previous_body_length is not None
                    and (
                        pem_candidate_previous_body_length != 64
                        or pem_candidate_saw_padding
                    )
                )
                if (
                    newline_changed
                    or preceding_body_line_was_final
                    or not is_canonical_pem_body_line(payload)
                ):
                    pem_candidate_incomplete_plausible = False
                else:
                    pem_candidate_body_lines += 1
                    pem_candidate_previous_body_length = len(payload)
                    pem_candidate_saw_padding = payload.endswith(b"=")
            return False

        def consume_pem_fragment(fragment: bytes, *, ends_line: bool) -> bool:
            nonlocal pem_discarding_line, pem_line_buffer
            if pem_discarding_line:
                if ends_line:
                    pem_discarding_line = False
                return False
            if len(pem_line_buffer) + len(fragment) > MAX_PRIVATE_KEY_PEM_BYTES:
                pem_line_buffer.clear()
                reset_pem_candidate()
                pem_discarding_line = not ends_line
                return False
            pem_line_buffer.extend(fragment)
            if not ends_line:
                return False
            line = bytes(pem_line_buffer)
            pem_line_buffer.clear()
            return consume_pem_line(line)

        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise ProbeFailure("residue scan exceeded its aggregate deadline")
            if (
                key_scan_budget is not None
                and time.monotonic() >= key_scan_budget.deadline
            ):
                raise ProbeFailure("private-key residue scan exceeded its deadline")
            chunk = handle.read(1024 * 1024)
            if not chunk:
                if ca_public_spki is not None and not pem_discarding_line:
                    if pem_line_buffer and consume_pem_line(bytes(pem_line_buffer)):
                        return scanned, digest_hex(), tuple(found), True
                    if inspect_incomplete_pem_candidate():
                        return scanned, digest_hex(), tuple(found), True
                return scanned, digest_hex(), tuple(found), False
            scanned += len(chunk)
            if scanned > max_bytes:
                raise ProbeFailure("residue scan exceeded its byte bound")
            if digest is not None:
                digest.update(chunk)
            if markers:
                window = overlap + chunk
                for token in markers:
                    if token not in found and token in window:
                        found.append(token)
                overlap = window[-longest:]
            if ca_public_spki is None:
                continue
            # Snapshot replay contains tens of gigabytes and millions of files,
            # while private-key candidates are rare. Avoid a Python-level loop
            # over every newline when the current chunk cannot start an exact
            # PEM boundary. Preserve only a possible boundary prefix at the
            # final line so candidates split across chunks remain detectable.
            if pem_candidate is None and not pem_line_buffer:
                search_start = 0
                if pem_discarding_line:
                    discarded_line_end = chunk.find(b"\n")
                    if discarded_line_end < 0:
                        continue
                    pem_discarding_line = False
                    search_start = discarded_line_end + 1
                candidate_region = chunk[search_start:]
                if not any(
                    header in candidate_region
                    for header, _end in PRIVATE_KEY_PEM_BOUNDARIES
                ):
                    final_line_start = candidate_region.rfind(b"\n") + 1
                    trailing_line = candidate_region[final_line_start:]
                    if trailing_line and any(
                        header.startswith(trailing_line)
                        for header, _end in PRIVATE_KEY_PEM_BOUNDARIES
                    ):
                        pem_line_buffer.extend(trailing_line)
                    else:
                        pem_discarding_line = bool(trailing_line)
                    continue
            cursor = 0
            while cursor < len(chunk):
                line_end = chunk.find(b"\n", cursor)
                if line_end < 0:
                    if consume_pem_fragment(chunk[cursor:], ends_line=False):
                        return scanned, digest_hex(), tuple(found), True
                    break
                if consume_pem_fragment(
                    chunk[cursor : line_end + 1], ends_line=True
                ):
                    return scanned, digest_hex(), tuple(found), True
                cursor = line_end + 1

    @classmethod
    def _scan_file(
        cls,
        path: Path,
        forbidden: Sequence[bytes],
        max_bytes: int,
        *,
        deadline: float | None = None,
    ) -> None:
        try:
            with path.open("rb") as handle:
                _size, _digest, found, _contains_ca_key = cls._fingerprint_stream(
                    handle, forbidden, max_bytes, deadline=deadline
                )
        except ProbeFailure as error:
            if str(error) == "residue scan exceeded its byte bound":
                raise ProbeFailure("snapshot-scan:archive-byte-bound") from None
            raise
        if found:
            raise ProbeFailure(
                "exported image contains exact IronCurtain public trust residue"
            )

    def _remove_tracked(
        self,
        resource: Literal["container", "image"],
        tracked_ids: Sequence[str],
        *,
        remove_timeout: int,
    ) -> list[str]:
        immutable_id_pattern = CONTAINER_ID if resource == "container" else IMMUTABLE_ID
        unique_ids = list(dict.fromkeys(tracked_ids))
        for tracked_id in unique_ids:
            if immutable_id_pattern.fullmatch(tracked_id) is None:
                raise ProbeFailure(
                    f"refusing to clean malformed tracked {resource} ID: {tracked_id!r}"
                )
        if unique_ids:
            self.docker(
                resource,
                "rm",
                "--force",
                *reversed(unique_ids),
                expect_success=None,
                timeout=remove_timeout,
            )
        remaining: list[str] = []
        for tracked_id in unique_ids:
            inspected = self.docker(
                resource, "inspect", tracked_id, expect_success=None, timeout=30
            )
            if inspected.returncode == 0:
                remaining.append(tracked_id)
        return remaining

    def cleanup(self) -> None:
        if not self.cleanup_armed:
            return
        self.container_ids = self._remove_tracked(
            "container", self.container_ids, remove_timeout=60
        )
        self.image_ids = self._remove_tracked(
            "image", self.image_ids, remove_timeout=180
        )

    def validate_final_inventory(self) -> None:
        self.require(
            not self.container_ids and not self.image_ids,
            "cleanup.tracked-ids",
            repr((self.container_ids, self.image_ids)),
        )
        image_ids = self._all_image_ids()
        self.require(
            image_ids == list(self.initial_image_ids),
            "cleanup.initial-image-inventory",
            repr((self.initial_image_ids, image_ids)),
        )
        containers = self.docker("container", "ls", "--all", "--quiet").stdout.strip()
        network = json.loads(
            self.docker("network", "inspect", EXPECTED_NETWORK).stdout
        )[0]
        self.require(
            containers == "" and not (network.get("Containers") or {}),
            "cleanup.empty-container-network",
            repr((containers, network.get("Containers"))),
        )

    def assert_complete(self) -> None:
        expected = expected_check_ids(self.mode)
        self.assert_true(
            len(self.checks) == len(set(self.checks)), "check IDs are unique"
        )
        self.assert_true(
            set(self.checks) == set(expected),
            "check ID inventory is exact",
            repr((self.checks, expected)),
        )


def read_mode() -> str:
    mode = TASK_PATH.read_text(encoding="utf-8").strip()
    if mode not in MODE_CHECK_IDS:
        raise ProbeFailure(
            'task text must be exactly "packages", "images", "offline", or "admission"'
        )
    return mode


def write_result(
    mode: str,
    verdict: str,
    passed: bool,
    checks: Sequence[str],
    cache_audit_sentinels: dict[str, str] | None,
    error: str | None = None,
) -> None:
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "mode": mode,
        "checkCount": len(checks),
        "checkIds": list(checks),
        "cacheAuditSentinels": cache_audit_sentinels,
    }
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "verdict": verdict,
        "passed": passed,
        "payload": payload,
    }
    if error is not None:
        result["error"] = error[:4096]
    temporary = RESULT_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(RESULT_PATH)


def internal_snapshot_scan_main() -> int:
    print(INTERNAL_SNAPSHOT_SCAN_BEGIN, flush=True)
    if os.geteuid() != 0:
        print(f"{INTERNAL_SNAPSHOT_SCAN_ERROR} snapshot-scan:euid", flush=True)
        return 1
    try:
        Probe("packages")._scan_snapshot_filesystems_core()
    except BaseException as error:
        print(
            f"{INTERNAL_SNAPSHOT_SCAN_ERROR} {snapshot_scan_failure_code(error)}",
            flush=True,
        )
        return 1
    print(INTERNAL_SNAPSHOT_SCAN_SUCCESS, flush=True)
    return 0


def main() -> int:
    mode = "unknown"
    probe: Probe | None = None
    try:
        mode = read_mode()
        probe = Probe(mode)
        selected_image_id = probe.validate_common()
        probe.validate_relay_topology(selected_image_id)
        if mode == "packages":
            probe.validate_packages()
        elif mode == "images":
            probe.validate_images()
        elif mode == "offline":
            probe.validate_offline(selected_image_id)
        else:
            probe.validate_next_admission()
        probe.cleanup()
        probe.validate_final_inventory()
        probe.assert_complete()
        write_result(mode, "pass", True, probe.checks, probe.cache_audit_sentinels)
        print(f"{len(probe.checks)} deterministic checks pass")
        return 0
    except Exception as error:
        if probe is not None:
            try:
                probe.cleanup()
            except Exception as cleanup_error:
                error = ProbeFailure(f"{error}; cleanup also failed: {cleanup_error}")
        checks = probe.checks if probe is not None else []
        cache_audit_sentinels = (
            probe.cache_audit_sentinels if probe is not None else None
        )
        write_result(mode, "fail", False, checks, cache_audit_sentinels, str(error))
        print(f"nested Docker workflow probe failed: {error}", file=sys.stderr)
        return 1


def entrypoint(argv: Sequence[str]) -> int:
    arguments = tuple(argv[1:])
    if INTERNAL_SNAPSHOT_SCAN_ARG not in arguments:
        return main()
    if arguments != (INTERNAL_SNAPSHOT_SCAN_ARG,):
        print("snapshot-scan:argv", file=sys.stderr)
        return 2
    return internal_snapshot_scan_main()


if __name__ == "__main__":
    raise SystemExit(entrypoint(sys.argv))
