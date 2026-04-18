#!/usr/bin/env bash
# Run the root test suite, then the web-ui workspace suite.
#
# When any arg is passed (e.g., `npm test -- test/foo.ts`), forward it to
# the root `vitest run` and skip the web-ui sub-suite — a targeted run
# against a specific file is almost never intended to also run the
# unrelated web-ui tests. Use `npm run test:web-ui` to target the
# web-ui suite explicitly.
set -euo pipefail

npx vitest run "$@"

if [ $# -eq 0 ]; then
  npm test -w packages/web-ui
fi
