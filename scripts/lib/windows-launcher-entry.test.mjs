import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatLaunchSummaryLine, resolveOpenCodeHostSummary } from './windows-launcher-entry.mjs';

describe('windows launcher entry', () => {
  it('formats a machine-readable launch summary line', () => {
    const line = formatLaunchSummaryLine({
      action: 'reused',
      host: '127.0.0.1',
      port: 3000,
      externalMode: true,
      openCodeHost: 'http://127.0.0.1:4095',
      openCodeGuidance: '',
    });

    assert.equal(
      line,
      'OPENCHAMBER_LAUNCH_RESULT={"action":"reused","host":"127.0.0.1","port":3000,"url":"http://127.0.0.1:3000","externalMode":true,"openCodeHost":"http://127.0.0.1:4095","openCodeGuidance":""}',
    );
  });

  it('sanitizes noisy OPENCODE_HOST values down to the actual URL', () => {
    const previous = process.env.OPENCODE_HOST;
    process.env.OPENCODE_HOST = '&& http://127.0.0.1:8443 &&';

    try {
      assert.equal(resolveOpenCodeHostSummary(), 'http://127.0.0.1:8443');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_HOST;
      } else {
        process.env.OPENCODE_HOST = previous;
      }
    }
  });

  it('returns not configured when no OpenCode host is available', () => {
    const previousHost = process.env.OPENCODE_HOST;
    const previousPort = process.env.OPENCODE_PORT;

    delete process.env.OPENCODE_HOST;
    delete process.env.OPENCODE_PORT;

    try {
      assert.equal(resolveOpenCodeHostSummary(), 'not configured');
      const line = formatLaunchSummaryLine({
        action: 'launched',
        host: '127.0.0.1',
        port: 3000,
      });
      assert.match(line, /"openCodeGuidance":"Configure OPENCODE_HOST or use the web UI settings after launch"/);
    } finally {
      if (previousHost === undefined) delete process.env.OPENCODE_HOST;
      else process.env.OPENCODE_HOST = previousHost;
      if (previousPort === undefined) delete process.env.OPENCODE_PORT;
      else process.env.OPENCODE_PORT = previousPort;
    }
  });
});
