const argument = process.argv[2] ?? '0';

if (argument === 'hang') {
  setInterval(() => undefined, 1_000);
} else {
  const exitCode = Number(argument);

  process.stdout.write(`qualification fixture stdout ${exitCode}\n`);
  process.stderr.write(`qualification fixture stderr ${exitCode}\n`);
  process.exitCode = exitCode;
}
