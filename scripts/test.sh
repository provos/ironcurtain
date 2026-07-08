#!/usr/bin/env bash
# Run the root test suite (with a bounded retry for a known teardown flake),
# then the web-ui workspace suite.
#
# When any arg is passed (e.g., `npm test -- test/foo.ts`), forward it to the
# root `vitest run`, skip the retry logic, and skip the web-ui sub-suite — a
# targeted run against a specific file is almost never intended to also run the
# unrelated web-ui tests. Use `npm run test:web-ui` to target the web-ui suite.
#
# ── Teardown-flake retry ──────────────────────────────────────────────────
# On macOS CI a vitest `forks` worker occasionally dies at end-of-run
# ("Worker exited unexpectedly" / "Tests closed successfully but something
# prevents Vite server from exiting"), failing the run even though every test
# passed. The root cause is unresolved — ruled out so far: the open-files limit
# (runners sit at 10240, not starved) and plain handle leaks (closing/unref-ing
# them didn't help). See issue #363.
#
# Until it's found, re-run the root suite (up to MAX_ATTEMPTS) but ONLY when the
# failure is that benign teardown signature with ZERO failed tests. This is
# re-verification, not masking: a genuine test failure ("N failed" in the vitest
# summary) is never retried — it propagates immediately. Success requires a
# clean `vitest` exit within the attempt budget; if every attempt hit the
# teardown flake (tests passing each time) we log loudly and pass, since failing
# a run in which no test ever failed is worse than the flake it papers over.
set -uo pipefail

# Targeted runs (any arg): original behavior, no retry, no web-ui sub-suite.
if [ $# -ne 0 ]; then
  exec npx vitest run "$@"
fi

MAX_ATTEMPTS=3
# vitest summary lines look like "Test Files  1 failed | 251 passed …" /
# "Tests  3 failed | …"; a real failure always prints "<n> failed" there.
FAILURE_RE='(Test Files|Tests)[[:space:]]+[0-9]+ failed'
TEARDOWN_RE='Worker exited unexpectedly|prevents Vite server from exiting|close timed out after [0-9]+ms'

strip_ansi() { perl -pe 's/\x1b\[[0-9;]*m//g' 2>/dev/null || cat; }

# Runs the root suite once; sets CLASSIFY to pass | fail | flake.
CLASSIFY=""
run_root_once() {
  local log
  # Explicit template: BSD mktemp (macOS) can require one; harmless on GNU.
  log="$(mktemp "${TMPDIR:-/tmp}/ic-vitest-run.XXXXXX")"
  npx vitest run 2>&1 | tee "$log"
  local ec="${PIPESTATUS[0]}"
  local clean
  clean="$(strip_ansi <"$log")"
  rm -f "$log"
  if [ "$ec" -eq 0 ]; then
    CLASSIFY=pass
  elif printf '%s\n' "$clean" | grep -qE "$FAILURE_RE"; then
    CLASSIFY=fail
  elif printf '%s\n' "$clean" | grep -qE "$TEARDOWN_RE"; then
    CLASSIFY=flake
  else
    CLASSIFY=fail
  fi
}

attempt=1
while :; do
  run_root_once
  case "$CLASSIFY" in
    pass)
      break
      ;;
    fail)
      exit 1
      ;;
    flake)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "::warning::vitest teardown flake persisted across ${MAX_ATTEMPTS} attempts; every attempt had zero failed tests, so treating as success (see scripts/test.sh / issue #363)"
        break
      fi
      echo "::warning::vitest teardown flake on attempt ${attempt}/${MAX_ATTEMPTS} (all tests passed but a worker died at teardown); retrying the root suite"
      attempt=$((attempt + 1))
      ;;
  esac
done

npm test -w packages/web-ui
