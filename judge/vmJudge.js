const vm = require('node:vm');

async function judge(userCode, problem) {
  const { tests } = problem;
  const sandbox = { module: { exports: null } };
  vm.createContext(sandbox);
  vm.runInContext(`${userCode};`, sandbox, { timeout: 1500 });
  const fn = sandbox.module.exports;
  if (typeof fn !== 'function')
    throw new Error('Export a function via module.exports');

  let passed = 0;
  const total = tests.length;
  const start = Date.now();

  for (const t of tests) {
    const result = fn(...t.input.args);
    if (JSON.stringify(result) === JSON.stringify(t.output)) passed++;
  }

  return {
    verdict: passed === total ? 'Accepted' : 'Wrong Answer',
    passCount: passed,
    total,
    timeMs: Date.now() - start
  };
}

module.exports = { judge };

