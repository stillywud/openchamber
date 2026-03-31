import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildPayloadManifest,
  stageWindowsStandaloneRuntime,
  writePayloadManifest,
} from './lib/windows-runtime-layout.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const webDistDir = path.join(webDir, 'dist');
const defaultStageDir = path.join(os.tmpdir(), 'openchamber-windows-runtime-stage');
const defaultOutputDir = path.join(repoRoot, 'dist');
const launcherSupportFiles = [
  'scripts/lib/windows-bootstrap.mjs',
  'scripts/lib/windows-launcher-entry.mjs',
];

function createRequireFromWeb() {
  return createRequire(path.join(webDir, 'package.json'));
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    stageOnly: false,
    verifyStagedRuntime: false,
    outputDir: defaultStageDir,
    wrapIntoExe: true,
    bunBinaryName: 'bun.exe',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--stage-only') {
      options.stageOnly = true;
      continue;
    }
    if (value === '--verify-staged-runtime') {
      options.verifyStagedRuntime = true;
      continue;
    }
    if (value === '--output-dir') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error('Missing value for --output-dir');
      }
      options.outputDir = path.resolve(nextValue);
      index += 1;
      continue;
    }
    if (value === '--no-wrap') {
      options.wrapIntoExe = false;
      continue;
    }
    if (value === '--bun-binary') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error('Missing value for --bun-binary');
      }
      options.bunBinaryName = nextValue;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${value}`);
  }

  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findFileRecursive(rootDir, fileName, maxDepth = 4) {
  if (!rootDir || maxDepth < 0 || !await pathExists(rootDir)) {
    return null;
  }

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
  }

  if (maxDepth === 0) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const resolved = await findFileRecursive(path.join(rootDir, entry.name), fileName, maxDepth - 1);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function assertWebDistExists() {
  if (!await pathExists(webDistDir)) {
    throw new Error('packages/web/dist is missing after the web build');
  }
}

async function resolveBunBinary() {
  const envCandidates = [
    process.env.BUN_BINARY,
    process.env.BUN,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  ].filter(Boolean);

  for (const candidate of envCandidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (result.status === 0) {
      return candidate;
    }
  }

  const commandName = process.platform === 'win32' ? 'where' : 'which';
  const lookup = spawnSync(commandName, ['bun'], { encoding: 'utf8', windowsHide: true });
  if (lookup.status === 0) {
    const resolvedPath = lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const executableName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const searchRoots = [
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.codex'),
    path.join(localAppData, 'Temp', 'bun-extract'),
    path.join(localAppData, 'npm-cache', '_npx'),
  ];

  for (const searchRoot of searchRoots) {
    const resolvedPath = await findFileRecursive(searchRoot, executableName, 5);
    if (!resolvedPath) {
      continue;
    }
    const result = spawnSync(resolvedPath, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (result.status === 0) {
      return resolvedPath;
    }
  }

  return null;
}

async function stageBunBinary(stageDir, bunBinaryPath, bunBinaryName) {
  if (!bunBinaryPath) {
    throw new Error('Bun binary is required for the packaged Windows runtime');
  }

  const targetPath = path.join(stageDir, bunBinaryName || 'bun.exe');
  await fs.copyFile(bunBinaryPath, targetPath);
  return targetPath;
}

async function buildWebRuntime() {
  const bunBinary = await resolveBunBinary();
  if (bunBinary) {
    run(bunBinary, ['run', 'build:web'], repoRoot);
    await assertWebDistExists();
    return;
  }

  const viteCliPath = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!await pathExists(viteCliPath)) {
    throw new Error('Unable to find Bun or the local Vite CLI for the required web build');
  }

  run(process.execPath, [viteCliPath, 'build'], webDir);
  await assertWebDistExists();
}

function waitForLine(stream, matcher, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timeoutId);
      stream.off('data', onData);
    };

    const onData = (chunk) => {
      buffer += chunk.toString();
      if (matcher.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error(`Timed out waiting for output: ${matcher}`));
    }, timeoutMs);

    stream.on('data', onData);
  });
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function verifyStagedRuntime(stageDir) {
  const openCodePort = await allocatePort();
  const webPort = await allocatePort();
  const dataDir = path.join(stageDir, '.runtime-data');

  const openCodeStub = http.createServer((request, response) => {
    if (request.url === '/global/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });

  await new Promise((resolve, reject) => {
    openCodeStub.once('error', reject);
    openCodeStub.listen(openCodePort, '127.0.0.1', resolve);
  });

  const bunBinaryPath = path.join(stageDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
  const child = spawn(bunBinaryPath, [
    path.join(stageDir, 'packages', 'web', 'bin', 'cli.js'),
    'serve',
    '--foreground',
    '--port',
    String(webPort),
  ], {
    cwd: stageDir,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCHAMBER_DATA_DIR: dataDir,
      OPENCODE_HOST: `http://127.0.0.1:${openCodePort}`,
      OPENCODE_SKIP_START: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

  let timer;
  try {
    await waitForLine(child.stdout, /Using external OpenCode server at/, 20000);
    await waitForLine(child.stdout, /OpenChamber server listening on/, 20000);

    const response = await fetch(`http://127.0.0.1:${webPort}/health`);
    if (!response.ok) {
      throw new Error(`Staged runtime health check failed with status ${response.status}`);
    }

    return {
      webPort,
      openCodePort,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await openCodeStub.closeAllConnections();
    await new Promise((resolve, reject) => openCodeStub.close((error) => error ? reject(error) : resolve()));
  }
}

async function readVersion() {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function createExeBundle(stageDir, outputDir, version) {
  const admZipRequire = createRequireFromWeb();
  const AdmZip = admZipRequire('adm-zip');
  const zip = new AdmZip();
  
  const stageFiles = await fs.readdir(stageDir, { withFileTypes: true });
  
  for (const entry of stageFiles) {
    const entryPath = path.join(stageDir, entry.name);
    if (entry.isDirectory()) {
      zip.addLocalFolder(entryPath, entry.name);
    } else {
      zip.addLocalFile(entryPath);
    }
  }
  
  const bundleDir = path.join(outputDir, 'bundles');
  await fs.mkdir(bundleDir, { recursive: true });
  
  const bundlePath = path.join(bundleDir, `openchamber-${version}-windows-x64.zip`);
  zip.writeZip(bundlePath);
  
  return bundlePath;
}

async function stageLauncherSupportFiles(stageDir) {
  for (const relativePath of launcherSupportFiles) {
    const sourcePath = path.join(repoRoot, relativePath);
    const targetPath = path.join(stageDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

function buildCmdLauncher() {
  return [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'set "BUN_EXE=%SCRIPT_DIR%bun.exe"',
    'set "MANIFEST_FILE=%SCRIPT_DIR%payload-manifest.json"',
    'set "LAUNCHER_FILE=%SCRIPT_DIR%scripts\\lib\\windows-launcher-entry.mjs"',
    'set "LOG_FILE=%SCRIPT_DIR%OpenChamber.log"',
    '',
    'if not exist "%BUN_EXE%" (',
    '  echo Missing bun.exe in package root.',
    '  exit /b 1',
    ')',
    '',
    'if not exist "%MANIFEST_FILE%" (',
    '  echo Missing payload-manifest.json in package root.',
    '  exit /b 1',
    ')',
    '',
    'if not exist "%LAUNCHER_FILE%" (',
    '  echo Missing launcher entry script in package root.',
    '  exit /b 1',
    ')',
    '',
    'set "OPENCHAMBER_PACKAGED_RUNTIME=true"',
    'echo OpenChamber launcher starting...',
    'echo Bundle root: %SCRIPT_DIR%',
    'echo Detailed logs: %LOG_FILE%',
    'echo. > "%LOG_FILE%"',
    '"%BUN_EXE%" "%LAUNCHER_FILE%" >> "%LOG_FILE%" 2>&1',
    'if errorlevel 1 (',
    '  echo Failed to start OpenChamber.',
    '  echo See log: %LOG_FILE%',
    '  exit /b 1',
    ')',
    `for /f "usebackq delims=" %%L in (powershell -NoProfile -Command "(Get-Content -Path '%LOG_FILE%' | Select-String '^OPENCHAMBER_LAUNCH_RESULT=').Line | Select-Object -Last 1") do set "RESULT_LINE=%%L"`.replaceAll('\u007f', '`'),
    'if not defined RESULT_LINE (',
    '  echo OpenChamber started, but no launch summary was returned.',
    '  echo See log: %LOG_FILE%',
    '  exit /b 0',
    ')',
    `for /f "usebackq tokens=1,2 delims=|" %%A in (powershell -NoProfile -Command "$json=((Get-Content -Path '%LOG_FILE%' | Select-String '^OPENCHAMBER_LAUNCH_RESULT=').Line | Select-Object -Last 1) -replace '^OPENCHAMBER_LAUNCH_RESULT=',''; $data=$json | ConvertFrom-Json; Write-Output ($data.action + '|' + $data.url)") do (set "RESULT_ACTION=%%A" & set "RESULT_URL=%%B")`.replaceAll('', '`'),
    'echo Mode: %RESULT_ACTION%',
    `powershell -NoProfile -Command "$json=((Get-Content -Path '%LOG_FILE%' | Select-String '^OPENCHAMBER_LAUNCH_RESULT=').Line | Select-Object -Last 1) -replace '^OPENCHAMBER_LAUNCH_RESULT=',''; $data=$json | ConvertFrom-Json; $mode = if ($data.externalMode) { 'external-opencode' } else { 'managed-opencode' }; Write-Host ('OpenCode mode: ' + $mode); Write-Host ('OpenCode host: ' + $data.openCodeHost)"`,
    'echo URL:  %RESULT_URL%',
    'echo Log:  %LOG_FILE%',
    'exit /b 0',
    '',
  ].join('\r\n');
}

function buildVbsLauncher() {
  return [
    'Set shell = CreateObject("WScript.Shell")',
    'scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)',
    'shell.Run Chr(34) & scriptDir & "\\OpenChamber.cmd" & Chr(34), 0, False',
  ].join('\r\n');
}

async function stageWindowsLaunchers(stageDir) {
  await fs.writeFile(path.join(stageDir, 'OpenChamber.cmd'), buildCmdLauncher(), 'utf8');
  await fs.writeFile(path.join(stageDir, 'OpenChamber.vbs'), buildVbsLauncher(), 'utf8');
}

async function main() {
  const options = parseArgs();
  const bunBinary = await resolveBunBinary();

  const version = await readVersion();
  
  await buildWebRuntime();
  const stage = await stageWindowsStandaloneRuntime({
    repoRoot,
    outputDir: options.outputDir,
  });

  await stageLauncherSupportFiles(stage.stageDir);
  await stageWindowsLaunchers(stage.stageDir);

  const manifest = buildPayloadManifest({
    version,
    bunBinaryName: options.bunBinaryName,
  });
  
  const manifestPath = await writePayloadManifest(stage.stageDir, manifest);
  console.log(`Payload manifest written to: ${manifestPath}`);

  const stagedBunBinaryPath = await stageBunBinary(stage.stageDir, bunBinary, options.bunBinaryName);
  console.log(`Bundled Bun runtime at: ${stagedBunBinaryPath}`);

  let verification = null;
  if (options.verifyStagedRuntime) {
    verification = await verifyStagedRuntime(stage.stageDir);
  }

  let bundlePath = null;
  if (options.wrapIntoExe) {
    const outputDir = defaultOutputDir;
    await fs.mkdir(outputDir, { recursive: true });
    bundlePath = await createExeBundle(stage.stageDir, outputDir, version);
    console.log(`EXE bundle created at: ${bundlePath}`);
  }

  const result = {
    stageDir: stage.stageDir,
    runtimePackages: stage.runtimePackages,
    manifest,
    manifestPath,
    verified: Boolean(verification),
    mode: options.stageOnly ? 'stage-only' : 'stage-ready',
    wrapped: options.wrapIntoExe,
    bundlePath,
    version,
  };

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = (() => {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
})();

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export {
  buildWebRuntime,
  parseArgs,
  readVersion,
  verifyStagedRuntime,
};
