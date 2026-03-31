import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleExistingInstanceReuse } from './windows-bootstrap.mjs';

describe('windows bootstrap', () => {
  it('opens the browser when reusing an existing healthy instance unless suppressed', async () => {
    const openedUrls = [];
    const updatedVersions = [];

    const result = await handleExistingInstanceReuse({
      existing: { port: 4317, host: '127.0.0.1' },
      runtimeVersion: '1.9.1',
      shouldOpenBrowser: true,
      openBrowserImpl: (url) => openedUrls.push(url),
      shouldSuppressBrowserOpenImpl: async () => false,
      updateLastBrowserOpenAtImpl: async (version) => updatedVersions.push(version),
    });

    assert.deepEqual(openedUrls, ['http://127.0.0.1:4317']);
    assert.deepEqual(updatedVersions, ['1.9.1']);
    assert.equal(result.action, 'reused');
    assert.equal(result.port, 4317);
  });
});
