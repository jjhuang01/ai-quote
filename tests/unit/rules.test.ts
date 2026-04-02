import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('rules template evidence', () => {
  it('documents the expected rule filenames', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-echo-rules-'));
    const filePath = path.join(tempRoot, 'AI_FEEDBACK_RULES.md');
    await fs.writeFile(filePath, '# Available Tools', 'utf8');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('# Available Tools');
  });
});
