import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BROWSER_OPEN_SUPPRESSION_WINDOW_MS = 30 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const HEALTH_CHECK_RETRIES = 60;
const HEALTH_CHECK_RETRY_INTERVAL_MS = 1000;

function getOpenChamberDataDir() {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    return path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function getRuntimeStateDir() {
  return path.join(getOpenChamberDataDir(), 'runtime-state');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${filePath}: ${error.message}`);
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getPackagedRuntimeInstallPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'OpenChamber', 'runtime');
}

function getVersionedRuntimePath(version) {
  return path.join(getPackagedRuntimeInstallPath(), version);
}

async function extractPayload(payloadArchivePath, targetVersion) {
  const targetPath = getVersionedRuntimePath(targetVersion);
  
  if (await pathExists(targetPath)) {
    const existingManifestPath = path.join(targetPath, 'payload-manifest.json');
    if (await pathExists(existingManifestPath)) {
      const existingManifest = await readJson(existingManifestPath);
      if (existingManifest.version === targetVersion) {
        return { alreadyExtracted: true, path: targetPath };
      }
    }
  }

  await fs.mkdir(targetPath, { recursive: true });

  const admZip = await import('adm-zip');
  const zip = new admZip.default(payloadArchivePath);
  zip.extractAllTo(targetPath, true);

  return { alreadyExtracted: false, path: targetPath };
}

async function readRuntimeState(stateFilePath) {
  try {
    return await readJson(stateFilePath);
  } catch {
    return {};
  }
}

async function writeRuntimeState(stateFilePath, state) {
  await writeJson(stateFilePath, state);
}

async function getRuntimeStateFilePath(version) {
  const stateDir = getRuntimeStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  return path.join(stateDir, `${version}.json`);
}

async function updateLastBrowserOpenAt(version) {
  const stateFilePath = await getRuntimeStateFilePath(version);
  const state = await readRuntimeState(stateFilePath);
  state.lastBrowserOpenAt = Date.now();
  await writeRuntimeState(stateFilePath, state);
}

async function shouldSuppressBrowserOpen(version, suppressionWindowMs = DEFAULT_BROWSER_OPEN_SUPPRESSION_WINDOW_MS) {
  const stateFilePath = await getRuntimeStateFilePath(version);
  const state = await readRuntimeState(stateFilePath);
  
  if (!state.lastBrowserOpenAt) {
    return false;
  }
  
  const elapsed = Date.now() - state.lastBrowserOpenAt;
  return elapsed < suppressionWindowMs;
}

function openBrowser(url) {
  const commandName = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  
  spawn(commandName, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

async function httpGet(url, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP error: ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function checkHealth(port, host = '127.0.0.1') {
  const url = `http://${host}:${port}/health`;
  try {
    const response = await httpGet(url);
    if (response.status === 200) {
      const healthData = JSON.parse(response.body);
      return {
        healthy: healthData.status === 'ok',
        ready: healthData.isOpenCodeReady === true,
        data: healthData,
      };
    }
    return { healthy: false, ready: false, data: null };
  } catch {
    return { healthy: false, ready: false, data: null };
  }
}

async function waitForReady(port, host = '127.0.0.1', maxRetries = HEALTH_CHECK_RETRIES) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const health = await checkHealth(port, host);
    if (health.ready) {
      return { success: true, attempts: attempt + 1, health };
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_RETRY_INTERVAL_MS));
  }
  return { success: false, attempts: maxRetries, health: null };
}

async function findExistingInstance(targetPort) {
  const dataDir = getOpenChamberDataDir();
  const instancesDir = path.join(dataDir, 'run');
  
  if (!await pathExists(instancesDir)) {
    return null;
  }
  
  const files = await fs.readdir(instancesDir);
  
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    const instancePath = path.join(instancesDir, file);
    try {
      const instance = await readJson(instancePath);
      
      if (targetPort && instance.port !== targetPort) continue;
      
      const health = await checkHealth(instance.port, instance.host || '127.0.0.1');
      
      if (health.healthy) {
        return {
          port: instance.port,
          host: instance.host || '127.0.0.1',
          health,
          isHealthy: true,
        };
      }
      
      return {
        port: instance.port,
        host: instance.host || '127.0.0.1',
        health,
        isHealthy: false,
        isStale: true,
      };
    } catch {
      continue;
    }
  }
  
  return null;
}

async function launchRuntime(runtimePath, manifest, options = {}) {
  const {
    port,
    openBrowser: shouldOpenBrowser = true,
    forceNewInstance = false,
  } = options;
  
  const cliPath = path.join(runtimePath, manifest.entry);
  const runtimeVersion = manifest.version;
  
  if (!forceNewInstance) {
    const existing = await findExistingInstance(port);
    if (existing) {
      if (existing.isHealthy) {
        return {
          action: 'reused',
          port: existing.port,
          host: existing.host,
          message: 'Reused existing healthy instance',
        };
      }
    }
  }
  
  const args = ['serve', '--foreground'];
  
  if (port) {
    args.push('--port', String(port));
  }
  
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: runtimePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCHAMBER_PACKAGED_RUNTIME: 'true',
    },
  });
  
  const stdoutChunks = [];
  const stderrChunks = [];
  
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutChunks.push(text);
    process.stdout.write(text);
  });
  
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    process.stderr.write(text);
  });
  
  const targetPort = port || 3000;
  const waitResult = await waitForReady(targetPort, '127.0.0.1');
  
  if (!waitResult.success) {
    child.kill('SIGTERM');
    return {
      action: 'failed',
      error: 'Server failed to become ready',
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  }
  
  if (shouldOpenBrowser) {
    const suppressBrowserOpen = await shouldSuppressBrowserOpen(runtimeVersion);
    
    if (!suppressBrowserOpen) {
      const browserUrl = `http://127.0.0.1:${targetPort}`;
      openBrowser(browserUrl);
      await updateLastBrowserOpenAt(runtimeVersion);
    }
  }

  const dataDir = getOpenChamberDataDir();
  const runDir = path.join(dataDir, 'run');
  await fs.mkdir(runDir, { recursive: true });
  const instanceStatePath = path.join(runDir, `${targetPort}.json`);
  await writeJson(instanceStatePath, {
    pid: child.pid,
    port: targetPort,
    version: runtimeVersion,
    timestamp: Date.now(),
  });
  
  return {
    action: 'launched',
    port: targetPort,
    host: '127.0.0.1',
    pid: child.pid,
    ready: true,
  };
}

export {
  DEFAULT_BROWSER_OPEN_SUPPRESSION_WINDOW_MS,
  extractPayload,
  findExistingInstance,
  getPackagedRuntimeInstallPath,
  getRuntimeStateDir,
  getVersionedRuntimePath,
  launchRuntime,
  openBrowser,
  readRuntimeState,
  shouldSuppressBrowserOpen,
  updateLastBrowserOpenAt,
  waitForReady,
  writeRuntimeState,
};
