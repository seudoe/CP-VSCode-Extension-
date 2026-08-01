import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CachedProblem, Block, Example } from './types';
import { CFProblem } from '../problems/cf-api';

// ── Block → HTML ──────────────────────────────────────────────────────────────

function blockToHtml(block: Block, webview: vscode.Webview, imagesDir: string, extensionUri: vscode.Uri): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${block.html}</p>`;

    case 'code':
      return `<pre><code>${escHtml(block.code)}</code></pre>`;

    case 'image': {
      // block.src is relative like "images/1234-A_foo.png"
      const absPath = path.join(imagesDir, '..', block.src);
      if (fs.existsSync(absPath)) {
        const uri = webview.asWebviewUri(vscode.Uri.file(absPath));
        return `<img src="${uri}" alt="${escHtml(block.alt ?? '')}" style="max-width:100%">`;
      }
      return `<img src="" alt="${escHtml(block.alt ?? 'image')}" style="max-width:100%">`;
    }

    case 'table':
      return block.html;

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map(i => `<li>${escHtml(i)}</li>`).join('\n');
      return `<${tag}>${items}</${tag}>`;
    }
  }
}

function blocksToHtml(blocks: Block[], webview: vscode.Webview, imagesDir: string, extensionUri: vscode.Uri): string {
  return blocks.map(b => blockToHtml(b, webview, imagesDir, extensionUri)).join('\n');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderExamples(examples: Example[]): string {
  return examples.map((ex, i) => `
    <div class="example">
      <div class="example-header">Example ${i + 1}</div>
      <div class="example-io">
        <div class="io-block">
          <div class="io-label">Input</div>
          <pre class="io-pre">${escHtml(ex.input)}</pre>
        </div>
        <div class="io-block">
          <div class="io-label">Output</div>
          <pre class="io-pre">${escHtml(ex.output)}</pre>
        </div>
      </div>
      ${ex.explanation ? `<div class="example-note"><strong>Note:</strong> ${escHtml(ex.explanation)}</div>` : ''}
    </div>
  `).join('');
}

// ── CF rank color ─────────────────────────────────────────────────────────────

function ratingColor(rating?: number): string {
  if (!rating) { return '#888'; }
  if (rating < 1200) { return '#808080'; }
  if (rating < 1400) { return '#008000'; }
  if (rating < 1600) { return '#03A89E'; }
  if (rating < 1900) { return '#0000FF'; }
  if (rating < 2100) { return '#AA00AA'; }
  if (rating < 2400) { return '#FF8C00'; }
  return '#FF0000';
}

// ── Main render function ──────────────────────────────────────────────────────

export function renderProblem(
  cached: CachedProblem,
  meta: CFProblem | undefined,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  imagesDir: string
): string {
  const { statement, contestId, index } = cached;
  const id = `${contestId}${index}`;
  const color = ratingColor(meta?.rating);

  const descHtml    = blocksToHtml(statement.description, webview, imagesDir, extensionUri);
  const inputHtml   = blocksToHtml(statement.input,       webview, imagesDir, extensionUri);
  const outputHtml  = blocksToHtml(statement.output,      webview, imagesDir, extensionUri);
  const noteHtml    = statement.note ? blocksToHtml(statement.note, webview, imagesDir, extensionUri) : '';
  const examplesHtml = renderExamples(statement.examples);

  const tagsHtml = meta?.tags.length
    ? meta.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join(' ')
    : '<span class="tag-none">—</span>';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[${id}] ${escHtml(statement.title)}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #333);
      --accent: #1a8cff;
      --section-bg: var(--vscode-sideBar-background, #1e1e1e);
      --pre-bg: var(--vscode-textBlockQuote-background, #2a2a2a);
      --tag-bg: var(--vscode-badge-background, #333);
      --tag-fg: var(--vscode-badge-foreground, #ccc);
      --rating-color: ${color};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.7;
      color: var(--fg);
      background: var(--bg);
      padding: 0 24px 48px 24px;
      max-width: 900px;
      margin: 0 auto;
    }

    /* ── Header ── */
    .problem-header {
      padding: 20px 0 16px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .contest-name {
      font-size: 12px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .problem-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--fg);
    }
    .problem-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 12px;
      font-size: 13px;
      color: #888;
    }
    .meta-item strong { color: var(--fg); }
    .rating-value { color: var(--rating-color); font-weight: 700; }

    /* ── Hideable sections ── */
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px 0 6px 0;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      color: #888;
    }
    .toggle-row:hover { color: var(--fg); }
    .toggle-arrow { font-size: 10px; transition: transform 0.15s; }
    .toggle-arrow.open { transform: rotate(90deg); }
    .collapsible { overflow: hidden; }
    .collapsible.hidden { display: none; }

    /* ── Tags ── */
    .tag {
      display: inline-block;
      background: var(--tag-bg);
      color: var(--tag-fg);
      border-radius: 3px;
      padding: 2px 7px;
      font-size: 12px;
      margin: 2px 2px;
    }
    .tag-none { color: #555; font-size: 12px; }

    /* ── Problem statement sections ── */
    .section {
      margin: 20px 0;
    }
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 10px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }
    p { margin: 8px 0; }
    ul, ol { padding-left: 24px; margin: 8px 0; }

    pre {
      background: var(--pre-bg);
      border-radius: 4px;
      padding: 12px 14px;
      overflow-x: auto;
      font-family: "Consolas", "Menlo", monospace;
      font-size: 13px;
      margin: 8px 0;
    }
    img { border-radius: 3px; margin: 8px 0; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    td, th { border: 1px solid var(--border); padding: 6px 10px; }

    /* ── Examples ── */
    .example {
      background: var(--section-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 16px;
      margin: 10px 0;
    }
    .example-header {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 10px;
      color: var(--accent);
    }
    .example-io {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 500px) {
      .example-io { grid-template-columns: 1fr; }
    }
    .io-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #888;
      margin-bottom: 4px;
    }
    .io-pre {
      background: var(--pre-bg);
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 13px;
      white-space: pre;
      margin: 0;
    }
    .example-note {
      margin-top: 10px;
      font-size: 13px;
      color: #aaa;
    }

    /* ── Math passthrough ── */
    .tex-font-style-it  { font-style: italic; }
    .tex-font-style-bf  { font-weight: bold; }
    .tex-font-style-tt  { font-family: monospace; }
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="problem-header">
    <div class="contest-name">Contest ${contestId}</div>
    <div class="problem-title">[${id}] ${escHtml(statement.title)}</div>

    <div class="problem-meta-row">
      <span class="meta-item">⏱ <strong>${escHtml(statement.timeLimit)}</strong></span>
      <span class="meta-item">💾 <strong>${escHtml(statement.memoryLimit)}</strong></span>
      ${meta?.rating
        ? `<span class="meta-item">★ <span class="rating-value">${meta.rating}</span></span>`
        : ''}
    </div>

    <!-- Rating (hideable) -->
    ${meta?.rating ? `
    <div class="toggle-row" onclick="toggle('rating-section', this)">
      <span class="toggle-arrow open">▶</span> Rating
    </div>
    <div class="collapsible" id="rating-section">
      <span class="rating-value" style="font-size:16px;font-weight:700">${meta.rating}</span>
    </div>` : ''}

    <!-- Tags (hideable) -->
    <div class="toggle-row" onclick="toggle('tags-section', this)">
      <span class="toggle-arrow open">▶</span> Tags
    </div>
    <div class="collapsible" id="tags-section">
      ${tagsHtml}
    </div>
  </div>

  <!-- ── Statement ── -->
  <div class="section">
    ${descHtml}
  </div>

  <!-- ── Input ── -->
  <div class="section">
    <div class="section-title">Input</div>
    ${inputHtml}
  </div>

  <!-- ── Output ── -->
  <div class="section">
    <div class="section-title">Output</div>
    ${outputHtml}
  </div>

  <!-- ── Examples ── -->
  <div class="section">
    <div class="section-title">Examples</div>
    ${examplesHtml}
  </div>

  ${noteHtml ? `
  <!-- ── Note ── -->
  <div class="section">
    <div class="section-title">Note</div>
    ${noteHtml}
  </div>` : ''}

  <script>
    function toggle(id, btn) {
      const el = document.getElementById(id);
      const arrow = btn.querySelector('.toggle-arrow');
      if (el.classList.contains('hidden')) {
        el.classList.remove('hidden');
        arrow.classList.add('open');
      } else {
        el.classList.add('hidden');
        arrow.classList.remove('open');
      }
    }
  </script>
</body>
</html>`;
}
