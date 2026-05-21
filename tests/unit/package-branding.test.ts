import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package branding', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

  it('uses Windsurf Quote as the public extension identity', () => {
    expect(manifest.name).toBe('windsurf-quote');
    expect(manifest.displayName).toBe('Windsurf Quote');
    expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe('Windsurf Quote');
    expect(manifest.contributes.views['quote-sidebar'][0].name).toBe('Windsurf Quote');
    expect(manifest.contributes.configuration.title).toBe('Windsurf Quote');
  });

  it('keeps quote command and configuration ids for backward compatibility', () => {
    expect(manifest.contributes.commands.every((item: { command: string }) => item.command.startsWith('quote.'))).toBe(true);
    expect(Object.keys(manifest.contributes.configuration.properties).every((key) => key.startsWith('quote.'))).toBe(true);
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('quote-sidebar');
    expect(manifest.contributes.views['quote-sidebar'][0].id).toBe('quoteView');
  });
});
