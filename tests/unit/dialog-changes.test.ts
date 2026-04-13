/**
 * Unit tests for dialog panel bug fixes:
 * - MCP ImageContent format (must match MCP spec, not Anthropic API)
 * - Queue auto-reply logic
 * - File content truncation (UI preview vs LLM content)
 * - Binary file detection
 * - text/uri-list parsing
 */
import { describe, it, expect } from 'vitest';

// ── MCP ImageContent format ──────────────────────────────────────────

describe('MCP ImageContent format', () => {
  // Simulate what bridge.ts resolver does
  function buildMcpContent(
    text: string,
    images?: { data: string; media_type: string }[]
  ): Record<string, unknown>[] {
    const content: Record<string, unknown>[] = [
      { type: 'text', text },
    ];
    if (images && images.length > 0) {
      for (const img of images) {
        // MCP spec ImageContent: top-level data + mimeType
        content.push({
          type: 'image',
          data: img.data,
          mimeType: img.media_type,
        });
      }
    }
    return content;
  }

  it('text-only response has correct MCP TextContent format', () => {
    const content = buildMcpContent('hello');
    expect(content).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('image response uses MCP spec format (data + mimeType at top level)', () => {
    const content = buildMcpContent('see image', [
      { data: 'aGVsbG8=', media_type: 'image/png' },
    ]);
    expect(content).toHaveLength(2);
    const img = content[1];
    // MCP spec: { type: "image", data: string, mimeType: string }
    expect(img).toHaveProperty('type', 'image');
    expect(img).toHaveProperty('data', 'aGVsbG8=');
    expect(img).toHaveProperty('mimeType', 'image/png');
    // Must NOT have Anthropic-style nested 'source'
    expect(img).not.toHaveProperty('source');
    // Must NOT have 'media_type' (that's Anthropic naming)
    expect(img).not.toHaveProperty('media_type');
  });

  it('multiple images are all MCP-formatted', () => {
    const content = buildMcpContent('two images', [
      { data: 'img1', media_type: 'image/jpeg' },
      { data: 'img2', media_type: 'image/webp' },
    ]);
    expect(content).toHaveLength(3);
    for (let i = 1; i < content.length; i++) {
      expect(content[i]).toHaveProperty('type', 'image');
      expect(content[i]).toHaveProperty('data');
      expect(content[i]).toHaveProperty('mimeType');
      expect(content[i]).not.toHaveProperty('source');
    }
  });
});

// ── Queue auto-reply logic ───────────────────────────────────────────

describe('Queue auto-reply logic', () => {
  // Simulate the auto-reply decision from extension.ts dialogHandler
  function shouldAutoReply(queueItems: string[]): { autoReply: string; remaining: string[] } | null {
    if (queueItems.length > 0) {
      return {
        autoReply: queueItems[0],
        remaining: queueItems.slice(1),
      };
    }
    return null;
  }

  it('returns null when queue is empty', () => {
    expect(shouldAutoReply([])).toBeNull();
  });

  it('consumes first item and returns remaining', () => {
    const result = shouldAutoReply(['first', 'second', 'third']);
    expect(result).not.toBeNull();
    expect(result!.autoReply).toBe('first');
    expect(result!.remaining).toEqual(['second', 'third']);
  });

  it('single-item queue returns empty remaining', () => {
    const result = shouldAutoReply(['only']);
    expect(result!.autoReply).toBe('only');
    expect(result!.remaining).toEqual([]);
  });

  it('does not mutate original array', () => {
    const original = ['a', 'b'];
    shouldAutoReply(original);
    expect(original).toEqual(['a', 'b']);
  });
});

// ── File content truncation ──────────────────────────────────────────

describe('File content truncation (UI preview vs LLM)', () => {
  const MAX_LLM = 50_000;
  const MAX_PREVIEW = 2000;

  function processFileContent(text: string): { preview: string; fullContent: string } {
    const fullContent = text.length > MAX_LLM
      ? text.slice(0, MAX_LLM) + '\n... (truncated at 50KB)'
      : text;
    const preview = text.length > MAX_PREVIEW
      ? text.slice(0, MAX_PREVIEW) + '\n... (truncated)'
      : text;
    return { preview, fullContent };
  }

  it('small file: preview and fullContent are identical', () => {
    const { preview, fullContent } = processFileContent('short');
    expect(preview).toBe('short');
    expect(fullContent).toBe('short');
  });

  it('medium file (>2KB <50KB): preview truncated, fullContent complete', () => {
    const text = 'x'.repeat(10_000);
    const { preview, fullContent } = processFileContent(text);
    expect(preview.length).toBeLessThan(text.length);
    expect(preview).toContain('... (truncated)');
    expect(fullContent).toBe(text); // full content preserved
  });

  it('large file (>50KB): both truncated at different levels', () => {
    const text = 'y'.repeat(100_000);
    const { preview, fullContent } = processFileContent(text);
    expect(preview.length).toBeLessThan(MAX_PREVIEW + 50);
    expect(fullContent.length).toBeLessThan(MAX_LLM + 50);
    expect(fullContent).toContain('truncated at 50KB');
    expect(preview).toContain('... (truncated)');
  });

  it('submitCustom uses fullContent over preview', () => {
    // Simulate submitCustom logic
    const attachment = {
      kind: 'file' as const,
      filename: 'config.json',
      fullContent: 'full-content-here',
      preview: 'prev',
    };
    const content = attachment.fullContent || attachment.preview || '';
    expect(content).toBe('full-content-here');
  });

  it('submitCustom falls back to preview when fullContent is absent', () => {
    const attachment = {
      kind: 'file' as const,
      filename: 'old.txt',
      preview: 'preview-content',
    };
    const content = (attachment as any).fullContent || attachment.preview || '';
    expect(content).toBe('preview-content');
  });
});

// ── Binary file detection ────────────────────────────────────────────

describe('Binary file detection', () => {
  const BINARY_RE = /\.(exe|dll|so|dylib|bin|o|a|lib|zip|tar|gz|bz2|xz|7z|rar|jar|war|ear|class|pyc|pyo|wasm|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|sqlite|db|mdb|mp3|mp4|avi|mov|mkv|flv|wmv|wav|flac|aac|ogg|ttf|otf|woff|woff2|eot|ico|icns|psd|ai|sketch|fig)$/i;
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

  function fileCategory(filename: string): 'image' | 'binary' | 'text' {
    if (IMAGE_RE.test(filename)) return 'image';
    if (BINARY_RE.test(filename)) return 'binary';
    return 'text';
  }

  it('recognizes common binary formats', () => {
    expect(fileCategory('app.exe')).toBe('binary');
    expect(fileCategory('archive.zip')).toBe('binary');
    expect(fileCategory('data.pdf')).toBe('binary');
    expect(fileCategory('font.woff2')).toBe('binary');
    expect(fileCategory('module.wasm')).toBe('binary');
  });

  it('recognizes image formats', () => {
    expect(fileCategory('photo.png')).toBe('image');
    expect(fileCategory('photo.jpg')).toBe('image');
    expect(fileCategory('photo.jpeg')).toBe('image');
    expect(fileCategory('icon.svg')).toBe('image');
  });

  it('treats unknown extensions as text (safe default)', () => {
    expect(fileCategory('config.json')).toBe('text');
    expect(fileCategory('.env')).toBe('text');
    expect(fileCategory('Makefile')).toBe('text');
    expect(fileCategory('unknown.xyz')).toBe('text');
  });
});

// ── isTextFile logic ─────────────────────────────────────────────────

describe('isTextFile enhanced logic', () => {
  const TEXT_EXTS = [
    'js','ts','jsx','tsx','mjs','cjs','mts','cts',
    'py','pyw','rb','go','rs','java','kt','kts','scala','clj','cljs',
    'c','cpp','cc','cxx','h','hpp','hxx','cs','fs','fsx',
    'swift','m','mm','dart','lua','r','jl','ex','exs','erl','hrl','zig','nim','v',
    'php','pl','pm','tcl','awk','sed',
    'html','htm','xml','svg','xsl','xslt',
    'css','scss','sass','less','styl','stylus',
    'vue','svelte','astro','njk','ejs','hbs','pug','jade',
    'json','jsonc','json5','yaml','yml','toml','ini','cfg','conf','properties',
    'csv','tsv','env',
    'md','markdown','mdx','txt','rst','adoc','asciidoc','org','tex','bib',
    'log','diff','patch',
    'sh','bash','zsh','fish','ps1','psm1','bat','cmd',
    'sql','graphql','gql','prisma','proto','thrift','avsc',
    'gitignore','gitattributes','gitmodules','gitkeep',
    'dockerignore',
    'editorconfig','eslintrc','prettierrc','stylelintrc','babelrc',
    'npmrc','nvmrc','yarnrc','node-version',
    'cursorrules','windsurfrules','clinerules','mdc','mcp',
    'tf','tfvars','hcl','gradle','cmake',
    'dockerfile','makefile','vagrantfile','gemfile','rakefile','procfile',
    'license','licence','authors','contributors','codeowners',
    'lock','snap',
  ];

  const SPECIAL_FILENAMES = new Set([
    '.env.local','.env.development','.env.production','.env.test','.env.staging',
    'cmakelists.txt','go.sum','cargo.lock','pnpm-lock.yaml',
    'docker-compose.yml','docker-compose.yaml',
    '.prettierignore','.eslintignore','.gitignore','.dockerignore',
  ]);

  function isTextFile(name: string): boolean {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower === '.env' || lower.startsWith('.env.')) return true;
    if (SPECIAL_FILENAMES.has(lower)) return true;
    const ext = lower.split('.').pop() ?? '';
    return TEXT_EXTS.includes(ext);
  }

  it('recognizes dotenv family', () => {
    expect(isTextFile('.env')).toBe(true);
    expect(isTextFile('.env.local')).toBe(true);
    expect(isTextFile('.env.production')).toBe(true);
    expect(isTextFile('.env.custom')).toBe(true);
  });

  it('recognizes special filenames', () => {
    expect(isTextFile('docker-compose.yml')).toBe(true);
    expect(isTextFile('go.sum')).toBe(true);
    expect(isTextFile('.prettierignore')).toBe(true);
  });

  it('recognizes AI tool config files', () => {
    expect(isTextFile('.cursorrules')).toBe(true);
    expect(isTextFile('.windsurfrules')).toBe(true);
    expect(isTextFile('rules.mdc')).toBe(true);
  });

  it('recognizes no-extension filenames', () => {
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(isTextFile('Makefile')).toBe(true);
    expect(isTextFile('LICENSE')).toBe(true);
  });

  it('rejects empty name', () => {
    expect(isTextFile('')).toBe(false);
  });
});

// ── MCP progress notification format ─────────────────────────────────

describe('MCP progress notification format', () => {
  function buildProgressNotification(progressToken: string | number, counter: number) {
    return {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: counter,
        message: 'Waiting for user response...',
      },
    };
  }

  it('has correct JSON-RPC structure', () => {
    const notif = buildProgressNotification('abc123', 1);
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('notifications/progress');
    expect(notif.params.progressToken).toBe('abc123');
    expect(notif.params.progress).toBe(1);
  });

  it('does NOT include total field (was incorrectly total:0 before)', () => {
    const notif = buildProgressNotification('tok', 5);
    expect(notif.params).not.toHaveProperty('total');
  });

  it('includes human-readable message', () => {
    const notif = buildProgressNotification('tok', 1);
    expect(notif.params.message).toBe('Waiting for user response...');
  });

  it('progress value increases with each call', () => {
    const n1 = buildProgressNotification('t', 1);
    const n2 = buildProgressNotification('t', 2);
    const n3 = buildProgressNotification('t', 3);
    expect(n2.params.progress).toBeGreaterThan(n1.params.progress);
    expect(n3.params.progress).toBeGreaterThan(n2.params.progress);
  });

  it('works with numeric progressToken', () => {
    const notif = buildProgressNotification(42, 1);
    expect(notif.params.progressToken).toBe(42);
  });
});

describe('FIFO dialog queue semantics', () => {
  type Request = { id: number | string; sessionId: string };

  function enqueue(queue: Request[], req: Request): { active: Request; queuedCount: number } | null {
    queue.push(req);
    const active = queue[0];
    if (!active) return null;
    return { active, queuedCount: Math.max(0, queue.length - 1) };
  }

  function resolveActive(queue: Request[]): { nextActive?: Request; queuedCount: number } {
    queue.shift();
    return {
      nextActive: queue[0],
      queuedCount: Math.max(0, queue.length - 1),
    };
  }

  it('keeps first request active and places later requests into backlog', () => {
    const queue: Request[] = [];
    const first = enqueue(queue, { id: 1, sessionId: 'sess_a' });
    const second = enqueue(queue, { id: 2, sessionId: 'sess_b' });

    expect(first).toEqual({ active: { id: 1, sessionId: 'sess_a' }, queuedCount: 0 });
    expect(second).toEqual({ active: { id: 1, sessionId: 'sess_a' }, queuedCount: 1 });
  });

  it('promotes next queued request only after active request resolves', () => {
    const queue: Request[] = [];
    enqueue(queue, { id: 1, sessionId: 'sess_a' });
    enqueue(queue, { id: 2, sessionId: 'sess_b' });

    const afterResolve = resolveActive(queue);
    expect(afterResolve.nextActive).toEqual({ id: 2, sessionId: 'sess_b' });
    expect(afterResolve.queuedCount).toBe(0);
  });

  it('does not supersede earlier requests when new requests arrive', () => {
    const queue: Request[] = [];
    enqueue(queue, { id: 1, sessionId: 'sess_a' });
    enqueue(queue, { id: 2, sessionId: 'sess_b' });
    enqueue(queue, { id: 3, sessionId: 'sess_c' });

    expect(queue.map((item) => item.id)).toEqual([1, 2, 3]);
  });
});

// ── RC2: timeout/stop returns JSON-RPC error, not fake user reply ──

describe('RC2: Cancelled dialog returns JSON-RPC error', () => {
  function buildRpcResponse(result: unknown, error?: unknown): Record<string, unknown> {
    const rpcResponse: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: 42,
    };
    if (error) rpcResponse['error'] = error;
    else rpcResponse['result'] = result;
    return rpcResponse;
  }

  function buildDialogResult(
    userResponse: string,
    images?: { data: string; media_type: string }[],
    cancelled?: boolean,
  ): Record<string, unknown> {
    if (cancelled) {
      return buildRpcResponse(undefined, {
        code: -32001,
        message: userResponse,
      });
    }
    const content: Record<string, unknown>[] = [
      { type: 'text', text: userResponse },
    ];
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({ type: 'image', data: img.data, mimeType: img.media_type });
      }
    }
    return buildRpcResponse({ content, isError: false });
  }

  it('normal response produces tool result (no error)', () => {
    const result = buildDialogResult('Hello LLM');
    expect(result).toHaveProperty('result');
    expect(result).not.toHaveProperty('error');
    const r = result['result'] as { content: { type: string; text: string }[] };
    expect(r.content[0].text).toBe('Hello LLM');
  });

  it('timed-out dialog produces JSON-RPC error', () => {
    const result = buildDialogResult('Dialog timed out', undefined, true);
    const err = result['error'] as { code: number; message: string };
    expect(err.code).toBe(-32001);
    expect(err.message).toContain('timed out');
  });

  it('bridge-stopped dialog produces JSON-RPC error', () => {
    const result = buildDialogResult('Bridge stopped', undefined, true);
    const err = result['error'] as { code: number; message: string };
    expect(err.code).toBe(-32001);
    expect(err.message).toBe('Bridge stopped');
  });

  it('cancelled response never leaks as tool result text', () => {
    const result = buildDialogResult('(cancelled)', undefined, true);
    // Must NOT appear in result.content
    expect(result).not.toHaveProperty('result');
  });
});

// ── RC3: sessionToDialogKey reverse mapping ──────────────────────────

describe('RC3: sessionToDialogKey reverse mapping', () => {
  it('maps sessionId to dialogKey for reliable lookup', () => {
    const map = new Map<string, string | number>();
    map.set('sess_abc', 42);
    map.set('sess_def', 'mcp_xyz');

    expect(map.get('sess_abc')).toBe(42);
    expect(map.get('sess_def')).toBe('mcp_xyz');
    expect(map.get('sess_missing')).toBeUndefined();
  });

  it('reverse mapping survives SSE reconnection (sessionId changes)', () => {
    // Simulate: dialog created with sess_old, SSE reconnects as sess_new
    const sessionToDialogKey = new Map<string, string | number>();
    const resolvers = new Map<string | number, string>();

    // Dialog created with original sessionId
    const dialogKey = 42;
    sessionToDialogKey.set('sess_old', dialogKey);
    resolvers.set(dialogKey, 'pending');

    // SSE reconnects — sess_old gone, sess_new appears
    // But sessionToDialogKey still maps sess_old → 42

    // User responds via dialog panel (still has sess_old in webview cfg)
    const lookupKey = sessionToDialogKey.get('sess_old');
    expect(lookupKey).toBe(42);
    expect(resolvers.get(lookupKey!)).toBe('pending');
  });

  it('cleanup removes mapping after resolve', () => {
    const map = new Map<string, string | number>();
    map.set('sess_abc', 42);

    // Simulate resolve + cleanup
    map.delete('sess_abc');
    expect(map.get('sess_abc')).toBeUndefined();
    expect(map.size).toBe(0);
  });
});

// ── URI list parsing ──────────────────────────────────────────────────

describe('text/uri-list parsing', () => {
  function parseUriList(uriList: string, textData: string): string[] {
    const uris: string[] = [];
    if (uriList) {
      uriList.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) uris.push(trimmed);
      });
    } else if (textData) {
      textData.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('file://') || (trimmed.startsWith('/') && !trimmed.includes(' '))) {
          uris.push(trimmed.startsWith('file://') ? trimmed : 'file://' + trimmed);
        }
      });
    }
    return uris;
  }

  it('parses standard text/uri-list format', () => {
    const uris = parseUriList('file:///home/user/file.ts\nfile:///home/user/other.json', '');
    expect(uris).toEqual(['file:///home/user/file.ts', 'file:///home/user/other.json']);
  });

  it('skips comment lines (starting with #)', () => {
    const uris = parseUriList('# comment\nfile:///real.txt', '');
    expect(uris).toEqual(['file:///real.txt']);
  });

  it('falls back to text/plain with file:// prefix', () => {
    const uris = parseUriList('', 'file:///Users/test/config.json');
    expect(uris).toEqual(['file:///Users/test/config.json']);
  });

  it('falls back to text/plain with absolute path (adds file:// prefix)', () => {
    const uris = parseUriList('', '/Users/test/config.json');
    expect(uris).toEqual(['file:///Users/test/config.json']);
  });

  it('rejects text/plain lines with spaces (not a path)', () => {
    const uris = parseUriList('', 'this is a sentence');
    expect(uris).toEqual([]);
  });

  it('returns empty for no data', () => {
    const uris = parseUriList('', '');
    expect(uris).toEqual([]);
  });

  it('handles mixed entries with blank lines', () => {
    const uris = parseUriList('file:///a.ts\n\nfile:///b.ts\n', '');
    expect(uris).toEqual(['file:///a.ts', 'file:///b.ts']);
  });
});
