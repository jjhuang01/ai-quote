import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import type { McpDialogRequest, ImageAttachment } from '../core/contracts';

export type DialogSubmitHandler = (sessionId: string, response: string, images?: ImageAttachment[]) => void;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Safely embed a value inside a <script> block — escapes </ sequences that would prematurely close the tag. */
function safeJsonEmbed(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/** Render a LaTeX string to HTML via KaTeX (MathML output — no CSS needed). */
function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { displayMode, output: 'mathml', throwOnError: false });
  } catch {
    return `<code class="math-error">${escHtml(tex)}</code>`;
  }
}

/** Highlight a code string with highlight.js, returning HTML. */
function highlightCode(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escHtml(code);
  }
}

/** Server-side markdown → HTML renderer with KaTeX math, highlight.js, and Mermaid support. */
function renderMarkdown(md: string): string {
  // 1. Extract fenced code blocks (including mermaid)
  const codeBlocks: string[] = [];
  let src = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.trimEnd();
    if (lang === 'mermaid') {
      codeBlocks.push(`<pre class="mermaid">${escHtml(trimmed)}</pre>`);
    } else {
      const highlighted = highlightCode(trimmed, lang || '');
      codeBlocks.push(
        `<pre><code class="hljs lang-${escHtml(lang || 'text')}">${highlighted}</code></pre>`,
      );
    }
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract display math blocks: $$...$$
  const mathBlocks: string[] = [];
  src = src.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    mathBlocks.push(renderKatex(tex, true));
    return `\x00MB${mathBlocks.length - 1}\x00`;
  });

  // 3. Extract inline code
  const inlineCodes: string[] = [];
  src = src.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 4. Process inline math: $...$  (after inline code to avoid conflicts)
  src = src.replace(/\$([^$\n]+)\$/g, (_, tex) => renderKatex(tex, false));

  // Inline formatting helper (bold, italic, links, strikethrough, images) — operates on already-escaped text
  const inlineFmt = (t: string): string =>
    escHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Process lines
  const lines = src.split('\n');
  const out: string[] = [];
  let listTag = '';
  let inTable = false;

  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = ''; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code-block placeholder
    const cbMatch = line.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) { closeList(); closeTable(); out.push(codeBlocks[+cbMatch[1]]); continue; }

    // Math-block placeholder
    const mbMatch = line.match(/^\x00MB(\d+)\x00$/);
    if (mbMatch) { closeList(); closeTable(); out.push(mathBlocks[+mbMatch[1]]); continue; }

    // Heading
    const hMatch = line.match(/^(#{1,6}) (.+)$/);
    if (hMatch) { closeList(); closeTable(); out.push(`<h${hMatch[1].length}>${inlineFmt(hMatch[2])}</h${hMatch[1].length}>`); continue; }

    // HR
    if (/^-{3,}$/.test(line.trim())) { closeList(); closeTable(); out.push('<hr>'); continue; }

    // Blockquote
    if (line.startsWith('> ')) { closeList(); closeTable(); out.push(`<blockquote>${inlineFmt(line.slice(2))}</blockquote>`); continue; }

    // Task list
    const taskMatch = line.match(/^[-*] \[([ xX])\] (.+)$/);
    if (taskMatch) { closeTable(); if (listTag !== 'ul') { closeList(); out.push('<ul class="task-list">'); listTag = 'ul'; } const checked = taskMatch[1] !== ' ' ? ' checked disabled' : ' disabled'; out.push(`<li class="task-item"><input type="checkbox"${checked}> ${inlineFmt(taskMatch[2])}</li>`); continue; }

    // Unordered list
    const ulMatch = line.match(/^[-*] (.+)$/);
    if (ulMatch) { closeTable(); if (listTag !== 'ul') { closeList(); out.push('<ul>'); listTag = 'ul'; } out.push(`<li>${inlineFmt(ulMatch[1])}</li>`); continue; }

    // Ordered list
    const olMatch = line.match(/^\d+\. (.+)$/);
    if (olMatch) { closeTable(); if (listTag !== 'ol') { closeList(); out.push('<ol>'); listTag = 'ol'; } out.push(`<li>${inlineFmt(olMatch[1])}</li>`); continue; }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      if (/^\|[-: |]+\|$/.test(line.trim())) continue; // separator
      closeList();
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const next = lines[i + 1] || '';
      if (/^\|[-: |]+\|$/.test(next.trim())) {
        closeTable();
        out.push('<table><thead><tr>' + cells.map(c => `<th>${inlineFmt(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true; i++;
      } else if (inTable) {
        out.push('<tr>' + cells.map(c => `<td>${inlineFmt(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }

    closeList(); closeTable();
    if (!line.trim()) continue;
    out.push(`<p>${inlineFmt(line)}</p>`);
  }
  closeList(); closeTable();

  // 6. Restore placeholders
  let html = out.join('\n');
  codeBlocks.forEach((cb, i) => { html = html.replace(`\x00CB${i}\x00`, cb); });
  mathBlocks.forEach((mb, i) => { html = html.replace(`\x00MB${i}\x00`, mb); });
  inlineCodes.forEach((ic, i) => { html = html.replace(`\x00IC${i}\x00`, ic); });
  return html;
}

/**
 * QuoteDialogPanel opens a focused WebviewPanel in the editor area (center tab)
 * when the LLM calls the MCP tool, instead of showing in the sidebar.
 * Reuses the same panel across calls — just updates content.
 */
export class QuoteDialogPanel {
  private static instance?: QuoteDialogPanel;
  /** Guard: max auto-reopens per dialog to prevent infinite loops. */
  private static reopenCount = 0;

  private panel: vscode.WebviewPanel;
  private currentReq?: McpDialogRequest;
  private onSubmit?: DialogSubmitHandler;
  private onQueueAdd?: (items: string[]) => void;
  private onQueueReplace?: (items: string[]) => void;
  private submitted = false;
  private enterToSend = false;
  private queueCount = 0;
  private queueItems: string[] = [];
  private recentHistory: { summary: string; response: string; time: string }[] = [];

  private constructor(
    private readonly extensionUri: vscode.Uri,
    onSubmit: DialogSubmitHandler
  ) {
    this.onSubmit = onSubmit;
    this.panel = vscode.window.createWebviewPanel(
      'quoteDialog',
      '⏸ Quote — 等待回复',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    this.panel.webview.onDidReceiveMessage((msg: { type: string; value?: unknown }) => {
      if (msg.type === 'dialogSubmit' && this.currentReq && !this.submitted) {
        this.submitted = true;
        const payload = msg.value as { sessionId?: string; response?: string; images?: ImageAttachment[] } | undefined;
        const response = payload?.response ?? '';
        const images = payload?.images ?? [];
        const sid = payload?.sessionId ?? this.currentReq.sessionId;
        this.onSubmit?.(sid, response, images.length > 0 ? images : undefined);
      }
      if (msg.type === 'dialogDismiss') {
        this.dismissAndResolve();
        this.panel.dispose();
      }
      if (msg.type === 'dialogClose') {
        this.panel.dispose();
      }
      if (msg.type === 'queueAdd') {
        const items = msg.value as string[];
        if (items?.length) this.onQueueAdd?.(items);
      }
      if (msg.type === 'queueUpdate') {
        const items = msg.value as string[];
        if (Array.isArray(items)) {
          this.queueItems = items;
          this.queueCount = items.length;
          this.onQueueReplace?.(items);
        }
      }
      if (msg.type === 'readFiles') {
        const uris = msg.value as string[];
        if (Array.isArray(uris)) void this.readAndSendFiles(uris);
      }
      if (msg.type === 'browseFiles') {
        void this.browseAndSendFiles();
      }
    });

    this.panel.onDidDispose(() => {
      const wasPending = !this.submitted && !!this.currentReq;
      QuoteDialogPanel.instance = undefined;

      if (wasPending && QuoteDialogPanel.reopenCount < 3) {
        // Tab X while dialog pending — auto-reopen to prevent accidental dismiss.
        // Dialog is NOT resolved; LLM keeps waiting.
        QuoteDialogPanel.reopenCount++;
        const req = this.currentReq!;
        const handler = this.onSubmit!;
        const uri = this.extensionUri;
        const opts = {
          enterToSend: this.enterToSend,
          queueCount: this.queueCount,
          queueItems: [...this.queueItems],
          onQueueAdd: this.onQueueAdd,
          onQueueReplace: this.onQueueReplace,
        };
        setTimeout(() => {
          try {
            // If a new dialog already arrived during the delay, skip reopen
            if (QuoteDialogPanel.instance) return;
            QuoteDialogPanel.show(uri, req, handler, opts);
            void vscode.window.showInformationMessage('💡 使用「取消」按钮关闭对话面板');
          } catch { /* extension may be deactivating */ }
        }, 80);
        return;
      }

      // Submitted (via 发送 / 取消) or reopen limit reached — clean up.
      // If reopen limit reached and still pending, resolve as dismissed.
      if (wasPending) {
        this.dismissAndResolve();
      }
    });
  }

  public static show(
    extensionUri: vscode.Uri,
    req: McpDialogRequest,
    onSubmit: DialogSubmitHandler,
    options?: { enterToSend?: boolean; queueCount?: number; queueItems?: string[]; recentHistory?: { summary: string; response: string; time: string }[]; onQueueAdd?: (items: string[]) => void; onQueueReplace?: (items: string[]) => void }
  ): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.onSubmit = onSubmit;
      QuoteDialogPanel.instance.enterToSend = options?.enterToSend ?? false;
      QuoteDialogPanel.instance.queueCount = options?.queueCount ?? 0;
      QuoteDialogPanel.instance.queueItems = options?.queueItems ?? [];
      QuoteDialogPanel.instance.recentHistory = options?.recentHistory ?? [];
      QuoteDialogPanel.instance.onQueueAdd = options?.onQueueAdd;
      QuoteDialogPanel.instance.onQueueReplace = options?.onQueueReplace;
      QuoteDialogPanel.instance.update(req);
      QuoteDialogPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const inst = new QuoteDialogPanel(extensionUri, onSubmit);
    inst.enterToSend = options?.enterToSend ?? false;
    inst.queueCount = options?.queueCount ?? 0;
    inst.queueItems = options?.queueItems ?? [];
    inst.recentHistory = options?.recentHistory ?? [];
    inst.onQueueAdd = options?.onQueueAdd;
    inst.onQueueReplace = options?.onQueueReplace;
    QuoteDialogPanel.instance = inst;
    inst.update(req);
  }

  /** Update queue display from outside (e.g. when sidebar queue changes). */
  public static updateQueueCount(count: number): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.queueCount = count;
    }
  }

  /** Sync full queue items to dialog webview. */
  public static syncQueueItems(items: string[]): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.queueItems = items;
      QuoteDialogPanel.instance.queueCount = items.length;
      try {
        void QuoteDialogPanel.instance.panel.webview.postMessage({ type: 'queueSync', value: items });
      } catch { /* panel may be disposed */ }
    }
  }

  /** Transition panel to "sent" state — user closes manually via tab X button. */
  public static showSentState(): void {
    if (!QuoteDialogPanel.instance) return;
    const inst = QuoteDialogPanel.instance;
    inst.panel.title = '✓ Quote — 已发送';
    try {
      void inst.panel.webview.postMessage({ type: 'dialogResolved' });
    } catch { /* panel may be disposed */ }
  }

  public static dispose(): void {
    QuoteDialogPanel.instance?.panel.dispose();
    QuoteDialogPanel.instance = undefined;
  }

  /** Mark the current dialog as externally submitted so dispose won't re-resolve. */
  public static markSubmitted(): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.submitted = true;
    }
  }

  private async browseAndSendFiles(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: '添加到对话',
    });
    if (!result || result.length === 0) return;
    await this.readAndSendFiles(result.map(u => u.toString()));
  }

  private async readAndSendFiles(uris: string[]): Promise<void> {
    for (const uri of uris) {
      try {
        const fileUri = vscode.Uri.parse(uri);
        const filename = fileUri.path.split('/').pop() || 'file';
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(fileUri);
        } catch {
          void this.panel.webview.postMessage({
            type: 'readFileResult',
            value: { filename, content: '', size: 0, isImage: false, error: '文件不存在或无权访问' },
          });
          continue;
        }

        // Directory: list contents
        if (stat.type === vscode.FileType.Directory) {
          const entries = await vscode.workspace.fs.readDirectory(fileUri);
          const listing = entries
            .map(([name, type]) => `${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`)
            .join('\n');
          void this.panel.webview.postMessage({
            type: 'readFileResult',
            value: { filename: filename + '/', content: listing, size: listing.length, isImage: false },
          });
          continue;
        }

        const isImage = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(filename);
        const isBinary = /\.(exe|dll|so|dylib|bin|o|a|lib|zip|tar|gz|bz2|xz|7z|rar|jar|war|ear|class|pyc|pyo|wasm|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|sqlite|db|mdb|mp3|mp4|avi|mov|mkv|flv|wmv|wav|flac|aac|ogg|ttf|otf|woff|woff2|eot|ico|icns|psd|ai|sketch|fig)$/i.test(filename);

        if (!isImage && isBinary) {
          void this.panel.webview.postMessage({
            type: 'readFileResult',
            value: { filename, content: '', size: stat.size, isImage: false, error: `不支持的二进制文件类型` },
          });
          continue;
        }

        if (isImage) {
          const data = await vscode.workspace.fs.readFile(fileUri);
          const base64 = Buffer.from(data).toString('base64');
          const ext = (filename.split('.').pop() ?? 'png').toLowerCase();
          const mediaType = ext === 'svg' ? 'image/svg+xml' : `image/${ext.replace('jpg', 'jpeg')}`;
          const dataUri = `data:${mediaType};base64,${base64}`;
          void this.panel.webview.postMessage({
            type: 'readFileResult',
            value: { filename, content: '', size: data.length, isImage: true, dataUri, mediaType },
          });
        } else {
          // Limit to 500KB to avoid overwhelming the webview
          if (stat.size > 512_000) {
            void this.panel.webview.postMessage({
              type: 'readFileResult',
              value: { filename, content: '', size: stat.size, isImage: false, error: `文件过大 (${(stat.size / 1024).toFixed(0)} KB)` },
            });
            continue;
          }
          const data = await vscode.workspace.fs.readFile(fileUri);
          const content = Buffer.from(data).toString('utf8');
          void this.panel.webview.postMessage({
            type: 'readFileResult',
            value: { filename, content, size: data.length, isImage: false },
          });
        }
      } catch (err) {
        const filename = uri.split('/').pop() || 'file';
        void this.panel.webview.postMessage({
          type: 'readFileResult',
          value: { filename, content: '', size: 0, isImage: false, error: String(err) },
        });
      }
    }
  }

  private dismissAndResolve(): void {
    if (this.submitted || !this.currentReq) return;
    this.submitted = true;
    const sid = this.currentReq.sessionId;
    this.onSubmit?.(sid, '(dismissed)');
  }

  private update(req: McpDialogRequest): void {
    this.submitted = false;
    this.currentReq = req;
    this.panel.title = '⏸ Quote — 等待回复';
    this.panel.webview.html = this.buildHtml(req);
    QuoteDialogPanel.reopenCount = 0; // Reset guard for new dialog
  }

  private buildHtml(req: McpDialogRequest): string {
    const nonce = randomBytes(16).toString('hex');
    const dialogScriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dialog.js')
    );
    const mermaidScriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'mermaid.min.js')
    );

    const optionBtns = (req.options ?? [])
      .map(
        (opt, i) =>
          `<button class="opt-btn" data-action="submitOption" data-idx="${i}">${escHtml(opt)}</button>`
      )
      .join('');

    const summaryContent = req.isMarkdown !== false
      ? renderMarkdown(req.summary)
      : `<pre>${escHtml(req.summary)}</pre>`;
    const summaryHtml = `<div id="summary" class="summary${req.isMarkdown !== false ? ' md' : ''}">${summaryContent}</div>`;

    const sessionId = safeJsonEmbed(req.sessionId);

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; img-src ${this.panel.webview.cspSource} data: blob:; font-src ${this.panel.webview.cspSource} data:;">
<title>Quote Dialog</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1a1a1a));
    --fg: var(--vscode-foreground, #e6e6e6);
    --muted: var(--vscode-descriptionForeground, #848484);
    --border: var(--vscode-panel-border, #383838);
    --border-subtle: color-mix(in srgb, var(--border) 48%, transparent);
    --input-bg: var(--vscode-input-background, #2e2e2e);
    --input-fg: var(--vscode-input-foreground, #e6e6e6);
    --input-border: var(--vscode-input-border, #555);
    --card: var(--vscode-editorWidget-background, #252525);
    --accent: #10b981;
    --accent-dim: #059669;
    --accent-subtle: color-mix(in srgb, var(--accent) 12%, transparent);
    --surface: var(--vscode-input-background, #2e2e2e);
    --surface-hover: color-mix(in srgb, var(--accent) 10%, var(--surface));
    --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
    --success: #22c55e;
    --danger: #ef4444;
    --danger-subtle: color-mix(in srgb, #ef4444 14%, transparent);
    --warning: #f59e0b;
    --warning-dim: #d97706;
    --warning-subtle: color-mix(in srgb, #f59e0b 14%, transparent);
    --radius: 8px;
    --font: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    --mono: var(--vscode-editor-font-family, 'SF Mono', Menlo, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg);
  }
  .header-status {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 60%, transparent);
    flex-shrink: 0;
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 60%, transparent); }
    50% { opacity: 0.5; box-shadow: 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
  }
  .header-title { font-weight: 600; font-size: 12px; flex: 1; letter-spacing: 0.02em; color: var(--fg); text-transform: uppercase; }
  .header-ts { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .summary {
    line-height: 1.65;
    max-height: 50vh;
    overflow-y: auto;
    padding: 14px 16px;
    background: var(--card);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .summary pre { white-space: pre-wrap; word-break: break-word; }
  .summary.md h1,.summary.md h2,.summary.md h3 { margin: 8px 0 4px; font-weight: 600; }
  .summary.md h1 { font-size: 1.3em; }
  .summary.md h2 { font-size: 1.15em; }
  .summary.md h3 { font-size: 1em; }
  .summary.md p { margin-bottom: 8px; }
  .summary.md ul,.summary.md ol { padding-left: 20px; margin-bottom: 8px; }
  .summary.md li { margin-bottom: 2px; }
  .summary.md code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-family: var(--mono); font-size: 0.9em; }
  .summary.md pre { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 4px; overflow-x: auto; }
  .summary.md pre code { background: none; padding: 0; }
  .summary.md strong,.summary.md b { font-weight: 600; }
  .summary.md em,.summary.md i { font-style: italic; }
  .summary.md a { color: var(--accent); }
  .summary.md blockquote { border-left: 3px solid var(--accent); padding-left: 10px; opacity: 0.8; margin: 8px 0; }
  .summary.md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
  .summary.md table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  .summary.md th,.summary.md td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
  .summary.md th { background: rgba(255,255,255,0.05); }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt-btn {
    padding: 6px 14px;
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    transition: all 0.15s ease;
  }
  .opt-btn:hover { background: var(--surface-hover); border-color: var(--accent); }
  .input-section { display: flex; flex-direction: column; gap: 6px; }
  .input-label { font-size: 12px; color: var(--fg); font-weight: 600; }
  .input-hint { font-weight: 400; font-size: 11px; color: var(--muted); margin-left: 4px; }
  .textarea-wrap { position: relative; }
  .char-count {
    position: absolute; bottom: 8px; right: 10px;
    font-size: 11px; color: var(--muted); pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  textarea {
    width: 100%;
    min-height: 100px;
    resize: vertical;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 12px 14px 26px;
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
    transition: border-color 0.15s;
  }
  textarea:focus { border-color: var(--accent); }
  textarea.drag-active { border-color: var(--accent); background: var(--accent-subtle); }
  .btn-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .btn-send {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: 1;
    padding: 11px 0;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    font-weight: 600;
    letter-spacing: 0.01em;
    transition: all 0.15s ease;
  }
  .btn-send:hover { background: var(--accent-dim); }
  .btn-send:active { transform: scale(0.99); }
  .btn-send svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .btn-cancel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 11px 14px;
    background: transparent;
    color: var(--warning);
    border: 1px solid var(--warning);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    font-weight: 500;
    transition: all 0.15s ease;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .btn-cancel:hover { background: var(--warning-subtle); color: var(--warning-dim); border-color: var(--warning-dim); }
  .btn-cancel:active { transform: scale(0.97); }
  .btn-cancel svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .shortcut-bar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 6px 0 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .shortcut-bar kbd {
    display: inline-block;
    padding: 1px 5px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.3;
    color: var(--muted);
  }
  .shortcut-sep { color: var(--border-subtle); margin: 0 2px; }
  /* Drop zone & attachments */
  .drop-zone {
    border: 1.5px dashed var(--border-subtle);
    border-radius: var(--radius);
    padding: 10px;
    text-align: center;
    font-size: 11px;
    color: var(--muted);
    transition: all 0.2s;
    cursor: pointer;
  }
  .drop-zone.dragover {
    border-color: var(--accent);
    color: var(--fg);
    background: var(--accent-subtle);
  }
  .drop-zone:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    color: var(--fg);
  }
  .attachment-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .attach-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    font-size: 12px;
  }
  .attach-item.attach-image {
    align-items: flex-start;
  }
  .attach-thumb {
    width: 48px; height: 48px;
    border-radius: 3px;
    object-fit: cover;
    flex-shrink: 0;
    border: 1px solid var(--border-subtle);
  }
  .attach-icon {
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; flex-shrink: 0;
    opacity: 0.6;
  }
  .attach-info { flex: 1; min-width: 0; }
  .attach-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .attach-meta { font-size: 10px; color: var(--muted); }
  .attach-preview {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
    max-height: 42px;
    overflow: hidden;
    white-space: pre;
    text-overflow: ellipsis;
    margin-top: 2px;
    line-height: 1.4;
  }
  .attach-remove {
    width: 20px; height: 20px;
    background: none; border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 3px;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .attach-remove:hover { color: var(--danger); background: var(--danger-subtle); }
  .attach-count { font-size: 11px; color: var(--muted); }
  /* Copy button */
  .copy-btn {
    position: absolute; top: 6px; right: 6px;
    padding: 3px 8px;
    background: var(--surface); border: 1px solid var(--border-subtle);
    border-radius: 4px; cursor: pointer;
    font-size: 11px; color: var(--muted);
    opacity: 0; transition: opacity 0.15s;
    font-family: var(--font);
  }
  .summary-wrap { position: relative; }
  .summary-wrap:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { color: var(--fg); border-color: var(--accent); }
  .copy-btn.copied { color: var(--accent); border-color: var(--accent); }
  /* Queue inline */
  .queue-inline {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 8px 12px;
    background: var(--card);
  }
  .queue-inline-header {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; font-weight: 600; margin-bottom: 4px;
  }
  .queue-inline-actions { display: flex; gap: 4px; }
  .queue-toggle, .queue-clear-all {
    background: none; border: none; cursor: pointer;
    font-size: 12px; color: var(--muted); padding: 2px;
    border-radius: 3px; transition: color 0.12s;
  }
  .queue-toggle:hover { color: var(--fg); }
  .queue-clear-all:hover { color: var(--danger); }
  .queue-inline-list { max-height: 160px; overflow-y: auto; }
  .queue-inline-list.collapsed { display: none; }
  .queue-item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 12px;
  }
  .queue-item:last-child { border-bottom: none; }
  .queue-item-num { color: var(--muted); font-size: 11px; flex-shrink: 0; min-width: 18px; }
  .queue-item-content {
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: default;
  }
  .queue-item-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .queue-item-editing { flex-direction: column; align-items: stretch; padding: 6px; }
  .queue-act {
    width: 20px; height: 20px;
    background: none; border: none;
    color: var(--muted); cursor: pointer;
    font-size: 11px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .queue-act:hover { color: var(--fg); }
  .queue-act-danger:hover { color: var(--danger); }
  .queue-edit-input {
    width: 100%; min-height: 28px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 4px 6px; font-family: var(--font); font-size: 12px;
    outline: none;
  }
  .queue-edit-input:focus { border-color: var(--accent); }
  .queue-empty { font-size: 11px; color: var(--muted); padding: 4px 0; text-align: center; }
  /* Dialog history section (past conversations) */
  .history-section { margin-bottom: 8px; }
  .history-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    font-size: 12px; color: var(--muted);
    transition: all 0.15s;
  }
  .history-header:hover { color: var(--fg); border-color: var(--border); }
  .history-toggle-icon { font-size: 10px; transition: transform 0.2s; }
  .history-list { max-height: 300px; overflow-y: auto; }
  .history-list.collapsed { display: none; }
  .history-item {
    padding: 6px 8px; border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
  }
  .history-item:last-child { border-bottom: none; }
  .history-item-llm, .history-item-user {
    display: flex; align-items: flex-start; gap: 6px;
    margin-bottom: 2px;
  }
  .history-role {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent); font-size: 9px; font-weight: 600;
    padding: 1px 4px; border-radius: 3px; flex-shrink: 0;
    margin-top: 1px;
  }
  .history-role-user {
    background: color-mix(in srgb, var(--success) 20%, transparent);
    color: var(--success);
  }
  .history-text {
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--fg); opacity: 0.8;
  }
  .history-copy, .sent-copy {
    background: none; border: none; cursor: pointer;
    font-size: 11px; color: var(--muted); padding: 1px 2px;
    border-radius: 3px; flex-shrink: 0; transition: color 0.12s;
    opacity: 0;
  }
  .history-item-llm:hover .history-copy,
  .history-item-user:hover .history-copy,
  .sent-bubble:hover .sent-copy { opacity: 1; }
  .history-copy:hover, .sent-copy:hover { color: var(--accent); }
  .history-item-time {
    font-size: 10px; color: var(--muted); text-align: right;
    margin-top: 2px;
  }
  /* Sent message history bubbles */
  .sent-history { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
  .sent-bubble {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-radius: var(--radius);
    font-size: 12px;
    animation: sentSlideIn 0.2s ease;
  }
  @keyframes sentSlideIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .sent-label {
    background: var(--accent); color: #fff;
    font-size: 10px; font-weight: 600;
    padding: 1px 5px; border-radius: 3px;
    flex-shrink: 0; margin-top: 1px;
  }
  .sent-content {
    flex: 1; min-width: 0;
    white-space: pre-wrap; word-break: break-word;
    color: var(--fg); line-height: 1.5;
  }
  .sent-time {
    font-size: 10px; color: var(--muted);
    flex-shrink: 0; margin-top: 1px;
  }
  /* Inline close button + sent status (after dialogResolved) */
  .btn-close-inline {
    padding: 1px 8px;
    background: none;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--font);
    line-height: 1.6;
    transition: all 0.12s;
    flex-shrink: 0;
  }
  .btn-close-inline:hover { color: var(--fg); border-color: var(--fg); }
  .sent-status { font-size: 11px; color: var(--success); flex: 1; text-align: left; }
  .sent-bar { justify-content: flex-start; gap: 8px; }
  /* Toast */
  .toast {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: var(--card); color: var(--fg); border: 1px solid var(--border-subtle);
    padding: 6px 16px; border-radius: var(--radius); font-size: 12px;
    opacity: 0; pointer-events: none; transition: all 0.25s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 100;
  }
  .toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }
  /* highlight.js dark theme (VS Code-aligned) */
  .hljs { color: #d4d4d4; }
  .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-link { color: #569cd6; }
  .hljs-function .hljs-keyword { color: #569cd6; }
  .hljs-string,.hljs-title.function_,.hljs-title.class_ { color: #ce9178; }
  .hljs-comment,.hljs-quote { color: #6a9955; font-style: italic; }
  .hljs-number,.hljs-regexp,.hljs-literal,.hljs-bullet { color: #b5cea8; }
  .hljs-meta,.hljs-meta .hljs-keyword { color: #9cdcfe; }
  .hljs-type,.hljs-built_in,.hljs-class .hljs-title { color: #4ec9b0; }
  .hljs-attr,.hljs-variable,.hljs-template-variable { color: #9cdcfe; }
  .hljs-attribute { color: #d7ba7d; }
  .hljs-symbol,.hljs-addition { color: #b5cea8; }
  .hljs-deletion { color: #ce9178; }
  .hljs-title { color: #dcdcaa; }
  .hljs-params { color: #d4d4d4; }
  .hljs-punctuation { color: #d4d4d4; }
  /* Mermaid diagram styling */
  pre.mermaid { background: transparent; border: none; padding: 8px 0; text-align: center; overflow-x: auto; }
  pre.mermaid svg { max-width: 100%; height: auto; }
  pre.mermaid[data-processed="true"] { font-size: 0; }
  /* Math styling */
  .math-error { color: #ef4444; background: rgba(239,68,68,0.1); padding: 2px 6px; border-radius: 3px; }
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 8px 0; }
  /* Task list styling */
  .task-list { list-style: none; padding-left: 4px; }
  .task-item { display: flex; align-items: baseline; gap: 6px; }
  .task-item input[type="checkbox"] { margin: 0; flex-shrink: 0; }
  /* Strikethrough */
  del { opacity: 0.6; }
</style>
</head>
<body>
<div class="header">
  <span class="header-status"></span>
  <span class="header-title">等待回复</span>
  <span class="header-ts" id="ts"></span>
</div>
<div class="body">
  ${this.recentHistory.length > 0 ? `
  <div class="history-section" id="historySection">
    <div class="history-header" id="historyToggle">
      <span>📜 对话历史 (${this.recentHistory.length})</span>
      <span class="history-toggle-icon" id="historyIcon">▶</span>
    </div>
    <div class="history-list collapsed" id="historyList">${this.recentHistory.map(h => {
      const ts = new Date(h.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const summaryPreview = escHtml(h.summary.replace(/[#*`\n]/g, ' ').trim().slice(0, 100));
      const responsePreview = escHtml(h.response.slice(0, 100));
      const summaryFull = escHtml(h.summary);
      const responseFull = escHtml(h.response);
      return `<div class="history-item">
        <div class="history-item-llm"><span class="history-role">LLM</span><span class="history-text">${summaryPreview}</span><button class="history-copy" data-copy="${summaryFull}" title="复制 LLM 摘要">📋</button></div>
        <div class="history-item-user"><span class="history-role history-role-user">你</span><span class="history-text">${responsePreview}</span><button class="history-copy" data-copy="${responseFull}" title="复制用户回复">📋</button></div>
        <div class="history-item-time">${ts}</div>
      </div>`;
    }).join('')}</div>
  </div>` : ''}
  <div class="summary-wrap">
    ${summaryHtml}
    <button class="copy-btn" id="copySummary" title="复制 LLM 摘要">复制</button>
  </div>
  ${optionBtns ? `<div class="options">${optionBtns}</div>` : ''}
  <div class="queue-inline" id="queueSection">
    <div class="queue-inline-header">
      <span>📋 发送队列 (<span id="queueBadge">${this.queueCount}</span>)</span>
      <span class="queue-inline-actions">
        <button class="queue-toggle" id="queueToggle" title="展开/收起">▼</button>
        <button class="queue-clear-all" id="queueClearAll" title="清空全部">🗑</button>
      </span>
    </div>
    <div class="queue-inline-list" id="queueList"></div>
  </div>
  <div class="input-section">
    <div class="input-label">反馈内容 <span class="input-hint">拖拽文件/图片 · Ctrl+V 粘贴</span></div>
    <div class="textarea-wrap">
      <textarea id="reply" placeholder="输入反馈或指令..." autofocus></textarea>
      <span class="char-count" id="charCount">0 字</span>
    </div>
  </div>
  <div id="dropZone" class="drop-zone">拖拽文件或图片到此处 · 支持 100+ 种文件类型 · <a href="#" id="browseBtn" style="color:var(--accent);text-decoration:underline;cursor:pointer;">浏览文件</a></div>
  <div id="attachmentList" class="attachment-list"></div>
  <span id="attachCount" class="attach-count"></span>
  <div class="btn-row">
    <button class="btn-send" data-action="submitCustom"><svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>发送</button>
    <button class="btn-cancel" data-action="closeDialog"><svg viewBox="0 0 24 24"><path d="M18 6L6 18"/><path d="M6 6L18 18"/></svg>关闭</button>
  </div>
  <div class="shortcut-bar">
    <kbd>${this.enterToSend ? 'Enter' : 'Ctrl+Enter'}</kbd> 发送 <span class="shortcut-sep">|</span> <kbd>Esc</kbd> 结束
  </div>
</div>
<script nonce="${nonce}">
  window.__DIALOG_CONFIG__ = {
    sessionId: ${sessionId},
    enterToSend: ${this.enterToSend ? 'true' : 'false'},
    options: ${safeJsonEmbed(req.options ?? [])},
    queueItems: ${safeJsonEmbed(this.queueItems)},
    historyCount: ${this.recentHistory.length}
  };
</script>
<script nonce="${nonce}" src="${mermaidScriptUri}"></script>
<script nonce="${nonce}" src="${dialogScriptUri}"></script>
<script nonce="${nonce}">
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose', fontFamily: 'var(--font)' });
    mermaid.run({ querySelector: 'pre.mermaid' }).catch(function(){});
  }
</script>
</body>
</html>`;
  }
}
