import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(repoRoot, 'web');
const localNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npmInvocation(args) {
  if (process.platform === 'win32' && existsSync(localNpmCli)) return { command: process.execPath, args: [localNpmCli, ...args] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function runNpm(label, args, cwd, attempts = 1) {
  const invocation = npmInvocation(args);
  run(label, invocation.command, invocation.args, cwd, attempts);
}

function run(label, command, args, cwd, attempts = 1) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`\n[verify] ${label}${attempts > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd') });
    if (result.error) {
      if (attempt === attempts) {
        console.error(`[verify] ${label} could not start: ${result.error.message}`);
        process.exit(1);
      }
    } else if (result.status === 0) {
      return;
    } else if (attempt === attempts) {
      console.error(`[verify] ${label} failed with exit code ${result.status}.`);
      process.exit(result.status || 1);
    }
    console.warn(`[verify] ${label} failed; retrying the external gate.`);
  }
}

run('backend unittest discovery', 'python', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], repoRoot);
runNpm('frontend Vitest', ['test'], webRoot);
runNpm('frontend production build and bundle gate', ['run', 'build'], webRoot);
runNpm('frontend dependency audit', ['audit'], webRoot, 3);
runNpm('serial browser acceptance', ['run', 'test:e2e', '--', '--workers=1'], webRoot);

console.log('\n[verify] all repository gates passed.');
