let ivm;
try { ivm = require('isolated-vm'); } catch { /* fallback */ }

async function judge(userCode, problem) {
  if (!ivm) throw new Error('isolated-vm not installed; set VM_MODE=vm');
  const { tests } = problem;

  const isolate = new ivm.Isolate({ memoryLimit: 64 });
  const context = await isolate.createContext();
  const jail = context.global;
  await jail.set('global', jail.derefInto());

  const bootstrap = `
    const module = { exports: null };
    ${userCode}
    global.__exported = module.exports || null;
  `;
  const script = await isolate.compileScript(bootstrap);
  await script.run(context, { timeout: 1500 });

  const exportedRef = await jail.get('__exported', { reference: true });
  if (!exportedRef) throw new Error('Export a function via module.exports');

  let passed = 0;
  const total = tests.length;
  const start = Date.now();

  for (const t of tests) {
    const result = await exportedRef.apply(undefined, t.input.args, { timeout: 1200 });
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

