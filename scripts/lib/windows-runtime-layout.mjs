import fs from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';

const WEB_RUNTIME_FILE_ENTRIES = [
  'packages/web/bin',
  'packages/web/dist',
  'packages/web/package.json',
  'packages/web/server',
];

const RUNTIME_SOURCE_DIRS = [
  'packages/web/bin',
  'packages/web/server',
];

const NODE_BUILTIN_MODULES = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, '')));

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function packageNameToPath(packageName) {
  return path.join(...packageName.split('/'));
}

function shouldIncludeRuntimePackage(packageName) {
  return typeof packageName === 'string' && packageName.length > 0 && !packageName.startsWith('@types/');
}

function packageSpecifierToName(specifier) {
  if (typeof specifier !== 'string') {
    return null;
  }

  const trimmed = specifier.trim();
  if (!trimmed || trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.startsWith('node:') || trimmed.startsWith('bun:')) {
    return null;
  }

  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  const packageName = trimmed.split('/')[0] || null;
  if (packageName && NODE_BUILTIN_MODULES.has(packageName)) {
    return null;
  }

  return packageName;
}

async function listFilesRecursive(rootDir) {
  const files = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

async function collectRuntimeEntryPackageNames(repoRoot) {
  const packageNames = new Set();
  const specifierPattern = /(?:import\s+(?:[^'"()]+?\s+from\s+)?|export\s+[^'"()]+?\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;

  for (const relativeDir of RUNTIME_SOURCE_DIRS) {
    const sourceDir = path.join(repoRoot, relativeDir);
    const files = await listFilesRecursive(sourceDir);
    for (const filePath of files) {
      if (!filePath.endsWith('.js') && !filePath.endsWith('.mjs')) {
        continue;
      }
      const source = await fs.readFile(filePath, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const packageName = packageSpecifierToName(match[1]);
        if (shouldIncludeRuntimePackage(packageName)) {
          packageNames.add(packageName);
        }
      }
    }
  }

  return [...packageNames].sort();
}

async function assertRequiredPaths(repoRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!await pathExists(absolutePath)) {
      throw new Error(`Required runtime path is missing: ${relativePath}`);
    }
  }
}

async function resolveInstalledPackageManifest(packageName, manifestCandidates) {
  for (const fromManifestPath of manifestCandidates) {
    const resolvedManifestPath = await fs.realpath(fromManifestPath).catch(() => fromManifestPath);
    const manifestDir = path.dirname(resolvedManifestPath);
    let currentDir = manifestDir;
    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(
        path.basename(currentDir) === 'node_modules' ? currentDir : path.join(currentDir, 'node_modules'),
        packageNameToPath(packageName),
        'package.json',
      );
      if (await pathExists(packageJsonPath)) {
        return packageJsonPath;
      }
      currentDir = path.dirname(currentDir);
    }

    const resolver = createRequire(resolvedManifestPath);
    try {
      return resolver.resolve(`${packageName}/package.json`);
    } catch {
      const candidatePaths = resolver.resolve.paths(packageName) || [];
      for (const candidatePath of candidatePaths) {
        const packageJsonPath = path.join(candidatePath, packageNameToPath(packageName), 'package.json');
        if (await pathExists(packageJsonPath)) {
          return packageJsonPath;
        }
      }

      try {
        const resolvedEntryPath = resolver.resolve(packageName);
        let packageDir = path.dirname(resolvedEntryPath);
        while (packageDir && packageDir !== path.dirname(packageDir)) {
          const packageJsonPath = path.join(packageDir, 'package.json');
          if (await pathExists(packageJsonPath)) {
            return packageJsonPath;
          }
          if (path.basename(packageDir) === 'node_modules') {
            break;
          }
          packageDir = path.dirname(packageDir);
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function buildManifestCandidates(primaryManifestPath, fallbackManifestPaths) {
  return [...new Set([primaryManifestPath, ...fallbackManifestPaths].filter(Boolean))];
}

async function collectInstalledRuntimePackages({ entryManifestPath, fallbackManifestPaths, packageNames }) {
  const queue = [...packageNames].filter(shouldIncludeRuntimePackage).sort();
  const visited = new Set();
  const discovered = [];
  const packageSources = new Map();
  const packageManifestPaths = new Map();

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) {
      continue;
    }
    const fromManifestPath = packageManifestPaths.get(packageName) || entryManifestPath;
    const manifestPath = await resolveInstalledPackageManifest(
      packageName,
      buildManifestCandidates(fromManifestPath, fallbackManifestPaths),
    );
    if (!manifestPath) {
      throw new Error(`Runtime dependency is not installed in the monorepo runtime installs: ${packageName}`);
    }
    const packageDir = path.dirname(manifestPath);

    visited.add(packageName);
    discovered.push(packageName);
    packageSources.set(packageName, packageDir);

    const manifest = await readJson(manifestPath);
    const nextNames = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ];

    for (const nextName of nextNames) {
      if (!shouldIncludeRuntimePackage(nextName) || visited.has(nextName)) {
        continue;
      }
      if (await resolveInstalledPackageManifest(nextName, buildManifestCandidates(manifestPath, fallbackManifestPaths))) {
        if (!packageManifestPaths.has(nextName)) {
          packageManifestPaths.set(nextName, manifestPath);
        }
        queue.push(nextName);
      }
    }
  }

  return {
    runtimePackages: discovered.sort(),
    packageSources,
  };
}

async function enumerateWebRuntimeLayout({ repoRoot }) {
  const rootDir = path.resolve(repoRoot);
  const rootPackagePath = path.join(rootDir, 'package.json');
  const webPackagePath = path.join(rootDir, 'packages', 'web', 'package.json');

  await assertRequiredPaths(rootDir, [...WEB_RUNTIME_FILE_ENTRIES, 'node_modules', 'packages/web/package.json']);

  const runtimeEntryPackageNames = await collectRuntimeEntryPackageNames(rootDir);
  const packageInventory = await collectInstalledRuntimePackages({
    entryManifestPath: webPackagePath,
    fallbackManifestPaths: [rootPackagePath],
    packageNames: runtimeEntryPackageNames,
  });

  return {
    repoRoot: rootDir,
    runtimeFileEntries: [...WEB_RUNTIME_FILE_ENTRIES],
    runtimePackages: packageInventory.runtimePackages,
    packageSources: packageInventory.packageSources,
  };
}

async function copyIntoStage(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: true,
    force: true,
  });
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    await copyIntoStage(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
}

async function stageWindowsStandaloneRuntime({ repoRoot, outputDir }) {
  const layout = await enumerateWebRuntimeLayout({ repoRoot });
  const stageDir = path.resolve(outputDir);

  if (!stageDir || stageDir.length === 0 || stageDir === path.sep) {
    throw new Error('Invalid stage directory path - refusing to delete');
  }
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  for (const relativePath of layout.runtimeFileEntries) {
    await copyIntoStage(path.join(layout.repoRoot, relativePath), path.join(stageDir, relativePath));
  }

  for (const packageName of layout.runtimePackages) {
    const sourcePath = layout.packageSources.get(packageName);
    await copyIntoStage(sourcePath, path.join(stageDir, 'node_modules', packageNameToPath(packageName)));
  }

  return {
    ...layout,
    stageDir,
  };
}

function getPackagedRuntimeFileList() {
  return [...WEB_RUNTIME_FILE_ENTRIES];
}

async function stageWindowsRuntime({ repoRoot, outputDir }) {
  return stageWindowsStandaloneRuntime({ repoRoot, outputDir });
}

const PAYLOAD_MANIFEST_VERSION = 1;

function getPayloadManifestDefaults() {
  return {
    version: null,
    payloadVersion: PAYLOAD_MANIFEST_VERSION,
    entry: 'packages/web/bin/cli.js',
    bun: 'bun.exe',
  };
}

function buildPayloadManifest({ version, bunBinaryName }) {
  const manifest = getPayloadManifestDefaults();
  manifest.version = version;
  manifest.bun = bunBinaryName || 'bun.exe';
  return manifest;
}

async function writePayloadManifest(stageDir, manifest) {
  const manifestPath = path.join(stageDir, 'payload-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

async function readPayloadManifest(stageDir) {
  const manifestPath = path.join(stageDir, 'payload-manifest.json');
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export {
  PAYLOAD_MANIFEST_VERSION,
  WEB_RUNTIME_FILE_ENTRIES,
  buildPayloadManifest,
  enumerateWebRuntimeLayout,
  getPackagedRuntimeFileList,
  getPayloadManifestDefaults,
  readPayloadManifest,
  stageWindowsRuntime,
  stageWindowsStandaloneRuntime,
  writePayloadManifest,
};
