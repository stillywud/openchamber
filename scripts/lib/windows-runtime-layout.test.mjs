import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  enumerateWebRuntimeLayout,
  stageWindowsStandaloneRuntime,
} from './windows-runtime-layout.mjs';

const tempDirs = [];

async function makeTempDir() {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-runtime-layout-'));
  tempDirs.push(dirPath);
  return dirPath;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeFile(filePath, content = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createPackage(rootDir, packageName, manifest) {
  const segments = packageName.split('/');
  const packageDir = path.join(rootDir, 'node_modules', ...segments);
  await writeJson(path.join(packageDir, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    ...manifest,
  });
  await writeFile(path.join(packageDir, 'index.js'), 'export default true;\n');
}

async function createBunLinkedPackage(rootDir, packageName, manifest) {
  const segments = packageName.split('/');
  const storePackageDir = path.join(rootDir, 'node_modules', '.bun', `${packageName.replace('/', '+')}@1.0.0`, 'node_modules', ...segments);
  await writeJson(path.join(storePackageDir, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    ...manifest,
  });
  await writeFile(path.join(storePackageDir, 'index.js'), 'export default true;\n');

  const linkedPackageDir = path.join(rootDir, 'node_modules', ...segments);
  await fs.mkdir(path.dirname(linkedPackageDir), { recursive: true });
  await fs.symlink(storePackageDir, linkedPackageDir, 'junction');

  return { storePackageDir, linkedPackageDir };
}

async function createBunNestedPackage(rootDir, ownerPackageName, packageName, manifest) {
  const ownerStoreDir = path.join(rootDir, 'node_modules', '.bun', `${ownerPackageName.replace('/', '+')}@1.0.0`, 'node_modules');
  const segments = packageName.split('/');
  const storePackageDir = path.join(rootDir, 'node_modules', '.bun', `${packageName.replace('/', '+')}@1.0.0`, 'node_modules', ...segments);

  await writeJson(path.join(storePackageDir, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    ...manifest,
  });
  await writeFile(path.join(storePackageDir, 'index.js'), 'export default true;\n');

  const linkedPackageDir = path.join(ownerStoreDir, ...segments);
  await fs.mkdir(path.dirname(linkedPackageDir), { recursive: true });
  await fs.symlink(storePackageDir, linkedPackageDir, 'junction');

  return { storePackageDir, linkedPackageDir };
}

async function createFixtureRepo() {
  const repoRoot = await makeTempDir();

  await writeJson(path.join(repoRoot, 'package.json'), {
    name: 'openchamber-monorepo',
    private: true,
    dependencies: {
      react: '1.0.0',
    },
  });

  await writeJson(path.join(repoRoot, 'packages', 'web', 'package.json'), {
    name: '@openchamber/web',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      express: '1.0.0',
      '@scope/pkg': '1.0.0',
      'exported-package': '1.0.0',
      'import-only-package': '1.0.0',
      'unused-ui-package': '1.0.0',
    },
  });

  await writeFile(path.join(repoRoot, 'packages', 'web', 'bin', 'cli.js'), 'import path from "path";\nimport exportedPackage from "exported-package";\nconsole.log(path, exportedPackage);\n');
  await writeFile(path.join(repoRoot, 'packages', 'web', 'server', 'index.js'), 'import express from "express";\nimport scopedPackage from "@scope/pkg";\nimport importOnlyPackage from "import-only-package";\nconsole.log(express, scopedPackage, importOnlyPackage);\n');
  await writeFile(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'), '<html></html>\n');

  await createPackage(repoRoot, 'express', {
    dependencies: {
      accepts: '1.0.0',
    },
    optionalDependencies: {
      fsevents: '1.0.0',
    },
  });
  await createPackage(repoRoot, 'accepts', {});
  await createPackage(repoRoot, '@scope/pkg', {
    peerDependencies: {
      react: '1.0.0',
    },
  });
  await createPackage(repoRoot, 'exported-package', {
    exports: {
      '.': './index.js',
    },
    dependencies: {
      'nested-runtime': '1.0.0',
    },
  });
  await createPackage(repoRoot, 'import-only-package', {
    type: 'module',
    exports: {
      '.': {
        import: './index.js',
      },
    },
  });
  await createPackage(repoRoot, 'nested-runtime', {});
  await createPackage(repoRoot, 'react', {});
  await createPackage(repoRoot, 'unused-ui-package', {});

  return repoRoot;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dirPath = tempDirs.pop();
    await fs.rm(dirPath, { recursive: true, force: true });
  }
});

describe('windows runtime layout', () => {
  it('enumerates app files and installed runtime packages from the root install', async () => {
    const repoRoot = await createFixtureRepo();

    const layout = await enumerateWebRuntimeLayout({ repoRoot });

    assert.deepEqual(layout.runtimeFileEntries, [
      'packages/web/bin',
      'packages/web/dist',
      'packages/web/package.json',
      'packages/web/server',
    ]);
    assert.deepEqual(layout.runtimePackages, [
      '@scope/pkg',
      'accepts',
      'exported-package',
      'express',
      'import-only-package',
      'nested-runtime',
      'react',
    ]);
  });

  it('stages a standalone runtime tree with copied app files and node_modules', async () => {
    const repoRoot = await createFixtureRepo();
    const outputDir = await makeTempDir();

    const result = await stageWindowsStandaloneRuntime({
      repoRoot,
      outputDir,
    });

    assert.equal(result.stageDir, outputDir);
    assert.match(await fs.readFile(path.join(outputDir, 'packages', 'web', 'dist', 'index.html'), 'utf8'), /<html>/);
    assert.match(await fs.readFile(path.join(outputDir, 'node_modules', 'express', 'package.json'), 'utf8'), /"name": "express"/);
    assert.match(await fs.readFile(path.join(outputDir, 'node_modules', '@scope', 'pkg', 'package.json'), 'utf8'), /"name": "@scope\/pkg"/);
  });

  it('copies only enumerated packages instead of an entire Bun store bucket', async () => {
    const repoRoot = await makeTempDir();
    const outputDir = await makeTempDir();

    await writeJson(path.join(repoRoot, 'package.json'), {
      name: 'openchamber-monorepo',
      private: true,
    });

    await writeJson(path.join(repoRoot, 'packages', 'web', 'package.json'), {
      name: '@openchamber/web',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        'bun-linked-package': '1.0.0',
      },
    });

    await writeFile(path.join(repoRoot, 'packages', 'web', 'bin', 'cli.js'), 'console.log("cli");\n');
    await writeFile(path.join(repoRoot, 'packages', 'web', 'server', 'index.js'), 'import bunLinkedPackage from "bun-linked-package";\nconsole.log(bunLinkedPackage);\n');
    await writeFile(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'), '<html></html>\n');

    await createBunLinkedPackage(repoRoot, 'bun-linked-package', {});
    await createPackage(repoRoot, 'unrelated-bun-sibling', {});
    await fs.cp(
      path.join(repoRoot, 'node_modules', 'unrelated-bun-sibling'),
      path.join(repoRoot, 'node_modules', '.bun', 'bun-linked-package@1.0.0', 'node_modules', 'unrelated-bun-sibling'),
      { recursive: true, force: true },
    );

    await stageWindowsStandaloneRuntime({
      repoRoot,
      outputDir,
    });

    assert.equal(await fs.readFile(path.join(outputDir, 'node_modules', 'bun-linked-package', 'package.json'), 'utf8').then(() => true, () => false), true);
    assert.equal(await fs.readFile(path.join(outputDir, 'node_modules', 'unrelated-bun-sibling', 'package.json'), 'utf8').then(() => true, () => false), false);
  });

  it('discovers transitive packages stored only in the Bun package store', async () => {
    const repoRoot = await makeTempDir();

    await writeJson(path.join(repoRoot, 'package.json'), {
      name: 'openchamber-monorepo',
      private: true,
    });

    await writeJson(path.join(repoRoot, 'packages', 'web', 'package.json'), {
      name: '@openchamber/web',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        'bun-linked-package': '1.0.0',
      },
    });

    await writeFile(path.join(repoRoot, 'packages', 'web', 'bin', 'cli.js'), 'console.log("cli");\n');
    await writeFile(path.join(repoRoot, 'packages', 'web', 'server', 'index.js'), 'import bunLinkedPackage from "bun-linked-package";\nconsole.log(bunLinkedPackage);\n');
    await writeFile(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'), '<html></html>\n');

    await createBunLinkedPackage(repoRoot, 'bun-linked-package', {
      dependencies: {
        '@kwsites/file-exists': '1.0.0',
      },
    });
    await createBunNestedPackage(repoRoot, 'bun-linked-package', '@kwsites/file-exists', {});

    const layout = await enumerateWebRuntimeLayout({ repoRoot });

    assert.equal(layout.runtimePackages.includes('@kwsites/file-exists'), true);
  });
});
