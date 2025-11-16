const fs = require('fs');
const path = require('path');

const PROB_DIR = __dirname;

function getRandomProblem(includeTests = false) {
  const files = fs.readdirSync(PROB_DIR).filter(f => f.endsWith('.json'));
  const pick = files[Math.floor(Math.random() * files.length)];
  const p = JSON.parse(fs.readFileSync(path.join(PROB_DIR, pick), 'utf8'));
  if (includeTests) return p;
  const { tests, ...meta } = p;
  return meta;
}

module.exports = { getRandomProblem };

