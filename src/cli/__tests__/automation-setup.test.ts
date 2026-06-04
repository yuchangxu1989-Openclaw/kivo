import { describe, expect, it } from 'vitest';
import { buildAutomationCommands } from '../automation-setup.js';

describe('KIVO init automation cron', () => {
  it('registers daily governance run command for the current project directory', () => {
    const commands = buildAutomationCommands('/tmp/kivo-user-project');

    expect(commands.governanceCommand).toBe('kivo governance run --auto');
    expect(commands.cronLines[0]).toBe(
      "0 4 * * * cd '/tmp/kivo-user-project' && npx kivo governance run --auto >> '/tmp/kivo-user-project/.kivo/governance.log' 2>&1",
    );
    expect(commands.cronLines[0]).not.toContain('/root/.openclaw/workspace/projects/kivo');
  });
});
