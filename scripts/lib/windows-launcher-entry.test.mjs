import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatLaunchSummaryLine } from './windows-launcher-entry.mjs';

describe('windows launcher entry', () => {
  it('formats a machine-readable launch summary line', () => {
    const line = formatLaunchSummaryLine({
      action: 'reused',
      host: '127.0.0.1',
      port: 3000,
    });

    assert.equal(
      line,
      'OPENCHAMBER_LAUNCH_RESULT={"action":"reused","host":"127.0.0.1","port":3000,"url":"http://127.0.0.1:3000"}',
    );
  });
});
