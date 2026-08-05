import fs from 'fs';

const path = 'src/assessment/main.js';
let js = fs.readFileSync(path, 'utf8');

const roundsStart = js.indexOf('const ROUNDS = [');
const namesStart = js.indexOf('const ROUND_NAMES = ');
const correctStart = js.indexOf('const CORRECT_ANS = [');
if (roundsStart < 0 || namesStart < 0 || correctStart < 0) {
  throw new Error('markers not found');
}

// CORRECT_ANS array ends at first `];` after it that closes the outer array
const afterCorrect = js.indexOf('];', correctStart);
const correctEnd = afterCorrect + 2;

const roundsBlock = js.slice(roundsStart, namesStart).trimEnd();
const namesBlock = js.slice(namesStart, correctStart).trimEnd();
const correctBlock = js.slice(correctStart, correctEnd).trimEnd();

const roundsJs =
  roundsBlock.replace('const ROUNDS =', 'export const ROUNDS =') +
  '\n\n' +
  namesBlock.replace('const ROUND_NAMES =', 'export const ROUND_NAMES =') +
  '\n\n' +
  correctBlock.replace('const CORRECT_ANS =', 'export const CORRECT_ANS =') +
  '\n';

fs.writeFileSync('src/assessment/rounds.js', roundsJs);

js =
  js.slice(0, roundsStart) +
  // leave ROUND_NAMES and CORRECT_ANS removed too — imported
  js.slice(correctEnd);

// Add import after existing imports
if (!js.includes("from './rounds.js'")) {
  js = js.replace(
    "import { EMAIL_CFG } from '../shared/email.js';\n",
    "import { EMAIL_CFG } from '../shared/email.js';\nimport { ROUNDS, ROUND_NAMES, CORRECT_ANS } from './rounds.js';\n"
  );
}

fs.writeFileSync(path, js);
console.log('rounds.js bytes', roundsJs.length, 'main.js bytes', js.length);
