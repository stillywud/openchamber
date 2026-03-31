import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchRuntime } from './windows-bootstrap.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundleRoot = path.resolve(__dirname, '..', '..');

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

  if (result.action === 'reused') {
    console.log(`Reused existing OpenChamber instance on http://${result.host}:${result.port}`);
    return;
  }

  console.log(`OpenChamber is ready on http://${result.host}:${result.port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
