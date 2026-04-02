import { describe, expect, it } from 'vitest';
import { createId, generateToolName } from '../../src/utils/tool-name';

describe('tool-name utilities', () => {
  it('generates a windsurf_endless tool name', () => {
    expect(generateToolName()).toMatch(/^windsurf_endless_[a-f0-9]{8}$/);
  });

  it('generates unique ids with prefix', () => {
    expect(createId('msg')).toMatch(/^msg_[a-f0-9]{12}$/);
  });
});
