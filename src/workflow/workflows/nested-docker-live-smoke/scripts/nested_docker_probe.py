#!/usr/bin/env python3
"""Deterministic nested-Docker acceptance executed inside a workflow container."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Sequence


WORKSPACE = Path("/workspace")
TASK_PATH = WORKSPACE / ".workflow" / "task" / "description.md"
RESULT_PATH = WORKSPACE / ".workflow" / "nested-docker-result.json"
PUBLIC_IMAGE = "busybox:1.37.0-glibc"
DENIED_IMAGE = "example.invalid/ironcurtain/denied:latest"
EXPECTED_NETWORK = "ironcurtain"
EXPECTED_DOCKER_HOST = "unix:///run/ironcurtain-docker/docker.sock"


class ProbeFailure(RuntimeError):
    pass


class Probe:
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.checks: list[str] = []
        suffix = uuid.uuid4().hex[:12]
        self.server_name = f"ic-wf-server-{suffix}"
        self.published_name = f"ic-wf-published-{suffix}"
        self.host_port = 30000 + (int(suffix[:4], 16) % 8000)
        self.nonce = uuid.uuid4().hex

    def require(self, condition: bool, label: str, detail: str = "") -> None:
        if not condition:
            suffix = f": {detail}" if detail else ""
            raise ProbeFailure(f"{label}{suffix}")
        self.checks.append(label)

    def run(
        self,
        argv: Sequence[str],
        *,
        expect_success: bool | None = True,
        timeout: int = 180,
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
            raise ProbeFailure(f"command timed out after {timeout}s: {list(argv)!r}") from error

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
        timeout: int = 180,
    ) -> subprocess.CompletedProcess[str]:
        return self.run(["docker", *args], expect_success=expect_success, timeout=timeout)

    def validate_common(self) -> str:
        docker_host = os.environ.get("DOCKER_HOST")
        self.require(
            docker_host == EXPECTED_DOCKER_HOST,
            "exact DOCKER_HOST exported",
            repr(docker_host),
        )
        network_name = os.environ.get("IRONCURTAIN_DOCKER_NETWORK")
        self.require(network_name == EXPECTED_NETWORK, "managed network name exported", repr(network_name))

        server_version = self.docker("version", "--format", "{{.Server.Version}}").stdout.strip()
        self.require(bool(server_version), "private daemon is ready")

        info = json.loads(self.docker("info", "--format", "{{json .}}").stdout)
        security_options = info.get("SecurityOptions") or []
        self.require(info.get("Driver") == "vfs", "private daemon uses vfs", repr(info.get("Driver")))
        self.require(
            any("rootless" in str(option).lower() for option in security_options),
            "private daemon is rootless",
            repr(security_options),
        )

        networks = json.loads(self.docker("network", "inspect", EXPECTED_NETWORK).stdout)
        self.require(isinstance(networks, list) and len(networks) == 1, "managed network inspect is singular")
        network = networks[0]
        self.require(network.get("Name") == EXPECTED_NETWORK, "managed network has the fixed name")
        self.require(network.get("Driver") == "bridge", "managed network uses bridge driver")
        self.require(network.get("Internal") is True, "managed network is internal")
        self.require(not (network.get("Containers") or {}), "managed network starts empty")

        containers = self.docker("container", "ls", "--all", "--quiet").stdout.strip()
        self.require(containers == "", "private daemon starts without workload containers", containers)

        image_ids = [line for line in self.docker("image", "ls", "--quiet", "--no-trunc").stdout.splitlines() if line]
        self.require(len(image_ids) >= 1, "selected agent image is preloaded")
        return image_ids[0]

    def validate_offline(self, selected_image_id: str) -> None:
        self.docker("image", "pull", PUBLIC_IMAGE, expect_success=False, timeout=60)
        self.checks.append("public pull is rejected in offline mode")

        self.docker(
            "container",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--entrypoint",
            "/bin/true",
            selected_image_id,
        )
        self.checks.append("preloaded image runs while offline")

        retained = self.docker("image", "inspect", PUBLIC_IMAGE, expect_success=False)
        self.require(retained.returncode != 0, "failed offline pull retains no public image")

    def validate_public(self) -> None:
        self.docker("image", "pull", PUBLIC_IMAGE, timeout=240)
        self.checks.append("allowed public image pull succeeds")
        self.docker("image", "pull", DENIED_IMAGE, expect_success=False, timeout=60)
        self.checks.append("unlisted registry pull is rejected")

        server_script = 'printf "%s" "$1" > /tmp/index.html; exec httpd -f -p 8080 -h /tmp'
        self.docker(
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
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64k",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            PUBLIC_IMAGE,
            "sh",
            "-c",
            server_script,
            "sh",
            self.nonce,
        )
        self.checks.append("server starts on managed network")

        server_ip = self.docker(
            "container",
            "inspect",
            "--format",
            f"{{{{(index .NetworkSettings.Networks \"{EXPECTED_NETWORK}\").IPAddress}}}}",
            self.server_name,
        ).stdout.strip()
        self.require(bool(server_ip), "managed server receives an inner IPv4 address")

        resolv_conf = self.docker(
            "container",
            "run",
            "--rm",
            "--network",
            EXPECTED_NETWORK,
            "--pull",
            "never",
            PUBLIC_IMAGE,
            "cat",
            "/etc/resolv.conf",
        ).stdout
        self.require("127.0.0.11" in resolv_conf, "managed network exposes embedded DNS")

        by_alias = self._wget_from_sibling("http://target:8080/")
        self.require(by_alias == self.nonce, "sibling reaches server by network alias", repr(by_alias))
        by_ip = self._wget_from_sibling(f"http://{server_ip}:8080/")
        self.require(by_ip == self.nonce, "sibling reaches server by inner IPv4", repr(by_ip))

        self.docker(
            "container",
            "run",
            "--rm",
            "--network",
            "host",
            "--pull",
            "never",
            PUBLIC_IMAGE,
            "wget",
            "-T",
            "3",
            "-qO-",
            "http://1.1.1.1/",
            expect_success=False,
            timeout=10,
        )
        self.checks.append("host-network child has no direct public-IP egress")

        self.docker(
            "container",
            "run",
            "--detach",
            "--name",
            self.published_name,
            "--network",
            EXPECTED_NETWORK,
            "--publish",
            f"127.0.0.1:{self.host_port}:8080",
            "--pull",
            "never",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64k",
            PUBLIC_IMAGE,
            "sh",
            "-c",
            server_script,
            "sh",
            self.nonce,
        )
        self.checks.append("published-port fixture starts inside the private daemon")

        port_map = json.loads(
            self.docker("container", "inspect", "--format", "{{json .NetworkSettings.Ports}}", self.published_name).stdout
        )
        self.require(self._has_no_bindings(port_map), "nested publish creates no host binding", repr(port_map))
        self.require(
            self._outer_loopback_body(self.host_port) != self.nonce,
            "agent-shell localhost cannot reach nested published service",
        )

    def _wget_from_sibling(self, url: str) -> str:
        last_error = ""
        for _ in range(10):
            result = self.docker(
                "container",
                "run",
                "--rm",
                "--network",
                EXPECTED_NETWORK,
                "--pull",
                "never",
                PUBLIC_IMAGE,
                "wget",
                "-T",
                "3",
                "-qO-",
                url,
                expect_success=None,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout
            last_error = result.stderr
            time.sleep(1)
        raise ProbeFailure(f"sibling could not reach {url}: {last_error[-2048:]}")

    @staticmethod
    def _has_no_bindings(port_map: Any) -> bool:
        if port_map is None or port_map == {}:
            return True
        if not isinstance(port_map, dict):
            return False
        return all(value is None or value == [] for value in port_map.values())

    @staticmethod
    def _outer_loopback_body(port: int) -> str | None:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f"http://127.0.0.1:{port}/", timeout=3) as response:
                return response.read(4096).decode("utf-8", errors="replace")
        except Exception:
            return None

    def cleanup(self) -> None:
        for name in (self.published_name, self.server_name):
            self.docker("container", "rm", "--force", name, expect_success=None, timeout=30)
        if self.mode == "public":
            self.docker("image", "rm", "--force", PUBLIC_IMAGE, expect_success=None, timeout=60)

    def validate_final_inventory(self) -> None:
        containers = self.docker("container", "ls", "--all", "--quiet").stdout.strip()
        self.require(containers == "", "private daemon ends without workload containers", containers)
        network = json.loads(self.docker("network", "inspect", EXPECTED_NETWORK).stdout)[0]
        self.require(not (network.get("Containers") or {}), "managed network ends empty")


def read_mode() -> str:
    mode = TASK_PATH.read_text(encoding="utf-8").strip()
    if mode not in {"public", "offline"}:
        raise ProbeFailure('task text must be exactly "public" or "offline"')
    return mode


def write_result(mode: str, verdict: str, passed: bool, checks: Sequence[str], error: str | None = None) -> None:
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"mode": mode, "checkCount": len(checks), "checks": list(checks)}
    result: dict[str, Any] = {"verdict": verdict, "passed": passed, "payload": payload}
    if error is not None:
        result["error"] = error[:4096]
    temporary = RESULT_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(RESULT_PATH)


def main() -> int:
    mode = "unknown"
    probe: Probe | None = None
    try:
        mode = read_mode()
        probe = Probe(mode)
        selected_image_id = probe.validate_common()
        if mode == "public":
            probe.validate_public()
        else:
            probe.validate_offline(selected_image_id)
        probe.cleanup()
        probe.validate_final_inventory()
        write_result(mode, "pass", True, probe.checks)
        print(f"{len(probe.checks)} tests pass")
        return 0
    except Exception as error:
        if probe is not None:
            try:
                probe.cleanup()
            except Exception as cleanup_error:
                error = ProbeFailure(f"{error}; cleanup also failed: {cleanup_error}")
        checks = probe.checks if probe is not None else []
        write_result(mode, "fail", False, checks, str(error))
        print(f"nested Docker workflow probe failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
