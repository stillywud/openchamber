import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchRuntime } from './windows-bootstrap.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundleRoot = path.resolve(__dirname, '..', '..');
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

async function readManifest() {
  const manifestPath = path.join(bundleRoot, 'payload-manifest.json');
  const content = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

function readOptionalPort() {
  const raw = process.env.OPENCHAMBER_PORT || process.env.PORT;
  if (!raw) {
    return undefined;
  }

  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

function formatLaunchSummaryLine(result) {
  const summary = {
    action: result.action,
    host: result.host,
    port: result.port,
    url: `http://${result.host}:${result.port}`,
  };

  return `OPENCHAMBER_LAUNCH_RESULT=${JSON.stringify(summary)}`;
}

async function main() {
  const manifest = await readManifest();
  const result = await launchRuntime(bundleRoot, manifest, {
    port: readOptionalPort(),
    openBrowser: true,
    forceNewInstance: false,
  });

  if (result.action === 'failed') {
    throw new Error(result.error || 'Failed to launch OpenChamber packaged runtime');
  }

  console.log(formatLaunchSummaryLine(result));
}

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { formatLaunchSummaryLine };
