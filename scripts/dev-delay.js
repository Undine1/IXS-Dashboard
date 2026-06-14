const { spawn } = require('child_process');

// Delay in milliseconds before starting dev server
const DELAY_MS = process.env.DEV_START_DELAY_MS ? Number(process.env.DEV_START_DELAY_MS) : 3000;

console.log(`Waiting ${DELAY_MS}ms before starting dev server...`);
setTimeout(() => {
  console.log('Starting `next dev`...');
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['next', 'dev'];
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code));
}, DELAY_MS);
