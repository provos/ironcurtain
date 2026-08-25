import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import isNumber from 'is-number';

const result = {
  nonce: readFileSync('/fixture/nonce.txt', 'utf8'),
  npm: `is-number@${isNumber('37') ? '7.0.0' : 'invalid'}`,
  pypi: `idna@${readFileSync('/fixture/pypi-version.txt', 'utf8')}`,
  aptCurlVersion: readFileSync('/fixture/apt-curl-version.txt', 'utf8'),
  cargo: readFileSync('/fixture/cargo-version.txt', 'utf8'),
  cargoOutput: execFileSync('/usr/local/bin/ironcurtain-cargo-smoke', { encoding: 'utf8' }),
};

if (!/^[a-f0-9]{32}$/u.test(result.nonce)) throw new Error(`bad nonce: ${JSON.stringify(result.nonce)}`);
if (result.npm !== 'is-number@7.0.0') throw new Error(`bad npm result: ${result.npm}`);
if (result.pypi !== 'idna@3.15') throw new Error(`bad PyPI result: ${result.pypi}`);
if (result.aptCurlVersion !== '7.88.1-10+deb12u15') {
  throw new Error(`bad apt curl version: ${result.aptCurlVersion}`);
}
if (result.cargo !== 'itoa@1.0.15') throw new Error(`bad Cargo result: ${result.cargo}`);
if (result.cargoOutput !== '37') throw new Error(`bad Cargo output: ${result.cargoOutput}`);

process.stdout.write(`${JSON.stringify(result)}\n`);
