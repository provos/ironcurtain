/** Validate the executable format and platform, without a compiler-byte allowlist. */
export function validateToolchainExecutable(bytes: Buffer, architecture: 'amd64' | 'arm64', label: string): void {
  const machine = architecture === 'amd64' ? 62 : 183;
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== machine
  ) {
    throw new Error(`${label} ELF architecture does not match the selected platform`);
  }
}
