import { spawn } from 'node:child_process';
import { anvilArgs, loadEnvFiles } from './fork-env.mjs';

loadEnvFiles();

const child = spawn('anvil', anvilArgs(), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
