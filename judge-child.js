const mode = (process.env.VM_MODE || 'ivm').toLowerCase();

const ivmJudge = () => require('./judge/ivmJudge');
const vmJudge = () => require('./judge/vmJudge');
const { judgePython } = require('./judge/pythonJudge');

process.on('message', async (m) => {
  try {
    const { code, problem, lang } = m;

    let res;
    if ((lang || '').toLowerCase().startsWith('py')) {
      res = await judgePython(code, problem);
    } else {
      const judge = mode === 'vm' ? vmJudge() : ivmJudge();
      res = await judge.judge(code, problem);
    }

    process.send && process.send(res);
  } catch (e) {
    process.send && process.send({
      verdict: 'Runtime Error',
      passCount: 0,
      total: 0,
      timeMs: 0,
      error: String(e.message || e)
    });
  } finally {
    process.exit(0);
  }
});

