const { fork } = require('node:child_process');
const path = require('node:path');

function runSubmission({ code, problem, lang }) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'judge-child.js'), {
      execArgv: ['--max-old-space-size=64']
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Time Limit Exceeded'));
    }, 5000);

    child.on('message', (msg) => { clearTimeout(timer); resolve(msg); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });

    child.send({ code, problem, lang });
  });
}

module.exports = { runSubmission }; // <-- important

