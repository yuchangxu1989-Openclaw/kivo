import { describe, expect, it } from 'vitest';
import { buildAutomationCommands } from '../automation-setup.js';

describe('KIVO init automation cron', () => {
  it('registers daily governance run command for OpenClaw host', () => {
    const commands = buildAutomationCommands('/root/.openclaw/workspace/projects/kivo');

    expect(commands.governanceCommand).toBe('kivo governance run --auto');
    expect(commands.cronLines[0]).toBe(
      '0 4 * * * cd /root/.openclaw/workspace/projects/kivo && npx kivo governance run --auto 2>&1 >> /tmp/kivo-governance.log',
    );
  });
});
