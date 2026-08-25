const VALUE_BEGIN_MARKER = '// ironcurtain:failure-diagnostic-code-values:begin';
const VALUE_END_MARKER = '// ironcurtain:failure-diagnostic-code-values:end';
const CATALOG_BEGIN_MARKER = '// ironcurtain:failure-diagnostic-codes:begin';
const CATALOG_END_MARKER = '// ironcurtain:failure-diagnostic-codes:end';
const DECLARATION_PATTERN = /^(diagnostic[A-Za-z0-9]+)\s+failureDiagnosticCode\s*=\s*"(ICBT-[A-Z0-9-]+)"$/u;
const CATALOG_ENTRY_PATTERN = /^(diagnostic[A-Za-z0-9]+),$/u;
const MAX_CODE_BYTES = 128;

/**
 * Parse the deliberately delimited Go value declarations and ordered runtime
 * catalog. Every non-marker line must have one exact supported shape; broad
 * source regexes and silently ignored syntax are intentionally avoided.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseGoFailureDiagnosticCodes(source) {
  const valuesBySymbol = new Map();
  const codes = new Set();
  for (const rawLine of extractDelimitedBlock(source, VALUE_BEGIN_MARKER, VALUE_END_MARKER, 'value')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = DECLARATION_PATTERN.exec(line);
    if (match === null) {
      throw new Error(`unsupported line in Go failure diagnostic value block: ${line}`);
    }
    const [, symbol, code] = match;
    if (valuesBySymbol.has(symbol)) throw new Error(`duplicate Go failure diagnostic symbol: ${symbol}`);
    if (codes.has(code)) throw new Error(`duplicate Go failure diagnostic code: ${code}`);
    if (Buffer.byteLength(code, 'ascii') > MAX_CODE_BYTES) {
      throw new Error(`Go failure diagnostic code exceeds ${MAX_CODE_BYTES} bytes: ${code}`);
    }
    valuesBySymbol.set(symbol, code);
    codes.add(code);
  }
  if (valuesBySymbol.size === 0) throw new Error('Go failure diagnostic value block is empty');

  const catalogSymbols = new Set();
  const orderedCodes = [];
  for (const rawLine of extractDelimitedBlock(source, CATALOG_BEGIN_MARKER, CATALOG_END_MARKER, 'catalog')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = CATALOG_ENTRY_PATTERN.exec(line);
    if (match === null) throw new Error(`unsupported line in Go failure diagnostic catalog: ${line}`);
    const symbol = match[1];
    if (catalogSymbols.has(symbol)) throw new Error(`duplicate Go failure diagnostic catalog symbol: ${symbol}`);
    const code = valuesBySymbol.get(symbol);
    if (code === undefined) throw new Error(`Go failure diagnostic catalog references unknown symbol: ${symbol}`);
    catalogSymbols.add(symbol);
    orderedCodes.push(code);
  }
  if (orderedCodes.length === 0) throw new Error('Go failure diagnostic catalog is empty');
  const unlisted = [...valuesBySymbol.keys()].filter((symbol) => !catalogSymbols.has(symbol));
  if (unlisted.length !== 0) {
    throw new Error(`Go failure diagnostic values are absent from the runtime catalog: ${unlisted.join(', ')}`);
  }
  return orderedCodes;
}

function extractDelimitedBlock(source, beginMarker, endMarker, label) {
  if (source.split(beginMarker).length !== 2 || source.split(endMarker).length !== 2) {
    throw new Error(`Go failure diagnostic ${label} block must contain exactly one begin and end marker`);
  }
  const begin = source.indexOf(beginMarker) + beginMarker.length;
  const end = source.indexOf(endMarker);
  if (end <= begin) throw new Error(`Go failure diagnostic ${label} block markers are out of order`);
  return source.slice(begin, end).split('\n');
}

/**
 * Require an exact ordered match so missing, extra, or reordered generated
 * codes all fail the freshness gate with a bounded, useful diagnostic.
 *
 * @param {readonly string[]} canonical
 * @param {unknown} generated
 */
export function requireExactFailureDiagnosticCodes(canonical, generated) {
  if (!Array.isArray(generated) || !generated.every((value) => typeof value === 'string')) {
    throw new Error('generated failure diagnostic allowlist is not a string array');
  }
  const mismatch = canonical.length !== generated.length || canonical.some((code, index) => generated[index] !== code);
  if (mismatch) {
    throw new Error('generated failure diagnostic allowlist differs from the canonical Go declaration');
  }
}
