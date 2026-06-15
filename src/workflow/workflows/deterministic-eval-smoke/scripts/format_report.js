const fs = require('fs');
const Ajv = require('ajv');

const evalPath = '/workspace/.workflow/eval.json';
const reportPath = '/workspace/.workflow/report.md';
const data = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

const ajv = new Ajv();
const validate = ajv.compile({
  type: 'object',
  required: ['score', 'passed', 'cases', 'dependency'],
  properties: {
    score: { type: 'number' },
    passed: { type: 'boolean' },
    cases: { type: 'number' },
    dependency: { const: 'numpy' },
  },
});

if (!validate(data)) {
  console.error(JSON.stringify(validate.errors));
  process.exit(1);
}

fs.writeFileSync(
  reportPath,
  `# Eval report\n\nscore: ${data.score}\npassed: ${data.passed}\ncases: ${data.cases}\nnode_dependency: ajv\n`,
);
console.log('1 test pass');
