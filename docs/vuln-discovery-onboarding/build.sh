#!/usr/bin/env bash
# Build vuln-discovery-onboarding.pdf from README.md.
# Requires pandoc + xelatex (e.g. `brew install pandoc` and a TeX distribution).
set -euo pipefail
cd "$(dirname "$0")"

pandoc README.md -o vuln-discovery-onboarding.pdf \
  --pdf-engine=xelatex \
  --resource-path=. \
  -V geometry:margin=1in \
  -V colorlinks=true \
  -V monofont="Menlo" \
  -V mainfont="Helvetica"
