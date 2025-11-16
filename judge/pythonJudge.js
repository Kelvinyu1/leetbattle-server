const { spawn } = require('node:child_process');
const path = require('node:path');

function judgePython(userCode, problem, { timeoutMs = 3500 } = {}) {
  return new Promise((resolve, reject) => {
    const runner = path.join(__dirname, 'py_runner.py');
    const child = spawn('python3', [runner], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const payload = JSON.stringify({
      code: userCode,
      exportName: problem.exportName || null,
      tests: problem.tests || [],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Time Limit Exceeded'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || `Python exited ${code}`));
      }
      try {
        const res = JSON.parse(stdout);
        resolve(res);
      } catch (e) {
        reject(new Error(`Bad runner output: ${stdout || stderr}`));
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

module.exports = { judgePython };

