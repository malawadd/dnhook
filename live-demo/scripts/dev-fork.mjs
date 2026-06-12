import { spawn } from 'node:child_process';
import { anvilArgs, forkEnvOverrides, loadEnvFiles } from './fork-env.mjs';

loadEnvFiles();

const env = { ...process.env, ...forkEnvOverrides() };
const spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
  spawn('anvil', anvilArgs(), { ...spawnOptions, env: process.env }),
  spawn(npm, ['run', 'dev:api'], spawnOptions),
  spawn(npm, ['run', 'dev:web'], spawnOptions),
];

let shuttingDown = false;

for (const child of children) {
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child && !other.killed) other.kill();
    }
    process.exitCode = code ?? 0;
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  });
}
