import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGoFailureDiagnosticCodes, requireExactFailureDiagnosticCodes } from './diagnostic-codes.mjs';

const catalog = `
const (
  // ironcurtain:failure-diagnostic-code-values:begin
  diagnosticFirst failureDiagnosticCode = "ICBT-FIRST-V1"
  diagnosticSecond failureDiagnosticCode = "ICBT-SECOND-V1"
  // ironcurtain:failure-diagnostic-code-values:end
)
var failureDiagnosticCodeCatalog = [...]failureDiagnosticCode{
  // ironcurtain:failure-diagnostic-codes:begin
  diagnosticFirst,
  diagnosticSecond,
  // ironcurtain:failure-diagnostic-codes:end
}
`;

test('parses only the deliberately delimited Go diagnostic catalog', () => {
  assert.deepEqual(parseGoFailureDiagnosticCodes(catalog), ['ICBT-FIRST-V1', 'ICBT-SECOND-V1']);
  assert.throws(
    () => parseGoFailureDiagnosticCodes(catalog.replace('failureDiagnosticCode', 'string')),
    /unsupported line/u,
  );
  assert.throws(
    () => parseGoFailureDiagnosticCodes(catalog.replace('// ironcurtain:failure-diagnostic-codes:end', '')),
    /exactly one begin and end/u,
  );
  assert.throws(
    () => parseGoFailureDiagnosticCodes(catalog.replace('  diagnosticSecond,\n', '')),
    /absent from the runtime catalog/u,
  );
  assert.throws(
    () => parseGoFailureDiagnosticCodes(catalog.replace('  diagnosticSecond,\n', '  diagnosticFirst,\n')),
    /duplicate.*catalog symbol/u,
  );
});

test('exact generated comparison rejects missing, extra, and reordered codes', () => {
  const canonical = parseGoFailureDiagnosticCodes(catalog);
  assert.doesNotThrow(() => requireExactFailureDiagnosticCodes(canonical, canonical));
  assert.throws(() => requireExactFailureDiagnosticCodes(canonical, canonical.slice(0, 1)), /differs/u);
  assert.throws(() => requireExactFailureDiagnosticCodes(canonical, [...canonical, 'ICBT-EXTRA-V1']), /differs/u);
  assert.throws(() => requireExactFailureDiagnosticCodes(canonical, [...canonical].reverse()), /differs/u);
});
