const argument = process.argv[2] ?? '0';

if (argument === 'hang') {
  setInterval(() => undefined, 1_000);
} else if (argument === 'flood') {
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  for (let index = 0; index < 52; index++) process.stdout.write(chunk);
} else {
  const exitCode = Number(argument);

  process.stdout.write(`qualification fixture stdout ${exitCode}\n`);
  process.stderr.write(`qualification fixture stderr ${exitCode}\n`);
  process.exitCode = exitCode;
}
