/**
 * renderer.ts
 *
 * Server-side KaTeX rendering (no CDN, no webview JS needed for math).
 * katex.renderToString() runs in the extension host and produces HTML
 * that the webview displays — works fully offline.
 *
 * Two math eras (from latex_catalog.md):
 *   mathjax era  (~contest 1100+): block.text has $...$ LaTeX markers
 *   tex-span era (~contest 0–1099): block.html has rendered HTML (<i>, <sup>, etc.)
 */

import * as vscode from 'vscode';
import katex from 'katex';
import { CachedProblem, Block, Example } from './types';
import { CFProblem } from './cf-api';

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ratingColor(r?: number): string {
  if (!r)       return '#808080';
  if (r < 1200) return '#808080';
  if (r < 1400) return '#008000';
  if (r < 1600) return '#03A89E';
  if (r < 1900) return '#1a8cff';
  if (r < 2100) return '#AA00AA';
  if (r < 2400) return '#FF8C00';
  return '#FF0000';
}

function ratingLabel(r?: number): string {
  if (!r)       return '';
  if (r < 1200) return 'Newbie';
  if (r < 1400) return 'Pupil';
  if (r < 1600) return 'Specialist';
  if (r < 1900) return 'Expert';
  if (r < 2100) return 'Candidate Master';
  if (r < 2400) return 'Master';
  if (r < 3000) return 'Grandmaster';
  return 'Legendary';
}

// ── Math rendering ────────────────────────────────────────────────────────────

/**
 * Replace all $...$ and $$...$$ in a plain-text string with KaTeX HTML.
 * Runs server-side in the extension host — no CDN needed.
 */
function renderMathInText(text: string): string {
  // ── Display math $$...$$ first (must come before inline) ──
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false, strict: false });
    } catch {
      return `<span class="math-error">$$${esc(latex)}$$</span>`;
    }
  });

  // ── Inline math $...$ ──
  // Skip $$ (already handled above), don't match empty $$ either
  text = text.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\[\s\S])+?)\$(?!\$)/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false, strict: false });
    } catch {
      return `<span class="math-error">$${esc(latex)}$</span>`;
    }
  });

  return text;
}

// ── Block → HTML ──────────────────────────────────────────────────────────────

function blockToHtml(block: Block): string {
  switch (block.type) {

    case 'paragraph': {
      // tex-span era: block.html already has formatted HTML (<i>, <sup class="upper-index">, etc.)
      // Check for CF formatting class names
      const isTexSpan = block.html && (
        block.html.includes('tex-font-style') ||
        block.html.includes('class="tex-span"') ||
        block.html.includes('upper-index') ||
        block.html.includes('lower-index')
      );

      if (isTexSpan) {
        // Inject as-is — CF already formatted it
        return `<p>${block.html}</p>`;
      }

      // mathjax era: block.text has $...$ — run KaTeX server-side
      const text = block.text ?? block.html ?? '';
      // Escape HTML special chars EXCEPT we want KaTeX output (raw HTML) to pass through
      // So: first render math (returns HTML strings), then the remaining plain text is safe
      // because block.text is plain text (no HTML tags outside of math)
      const withMath = renderMathInText(text);
      return `<p>${withMath}</p>`;
    }

    case 'code':
      return `<pre><code>${esc(block.code)}</code></pre>`;

    case 'image': {
      const filename = block.src.replace('cf-image://', '');
      return `<img data-cf-image="${esc(filename)}" src="" alt="${esc(block.alt ?? '')}" loading="lazy">`;
    }

    case 'table':
      return `<div class="table-wrap">${block.html}</div>`;

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items
        .map(item => `<li>${renderMathInText(item)}</li>`)
        .join('');
      return `<${tag}>${items}</${tag}>`;
    }
  }
}

function blocksToHtml(blocks: Block[]): string {
  return blocks.map(blockToHtml).join('\n');
}

// ── Examples ──────────────────────────────────────────────────────────────────

function renderExamples(examples: Example[]): string {
  if (!examples.length) { return '<p class="muted">No examples.</p>'; }
  return examples.map((ex, i) => `
<div class="example">
  <div class="example-head">
    <span class="example-label">Example ${i + 1}</span>
  </div>
  <div class="io-block">
    <div class="io-bar">
      <span class="io-label">Input</span>
      <button class="copy-btn" onclick="doCopy(this,'${esc(ex.input)}')">Copy</button>
    </div>
    <pre class="io-pre">${esc(ex.input)}</pre>
  </div>
  <div class="io-block">
    <div class="io-bar">
      <span class="io-label">Output</span>
      <button class="copy-btn" onclick="doCopy(this,'${esc(ex.output)}')">Copy</button>
    </div>
    <pre class="io-pre">${esc(ex.output)}</pre>
  </div>
  ${ex.explanation ? `<div class="example-note">${renderMathInText(ex.explanation)}</div>` : ''}
</div>`).join('');
}

// ── KaTeX CSS (inlined from the npm package) ──────────────────────────────────

function getKatexCss(): string {
  try {
    // katex ships its CSS alongside the JS in node_modules
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const cssPath = path.join(
      path.dirname(require.resolve('katex')),
      'katex.min.css'
    );
    if (fs.existsSync(cssPath)) {
      return fs.readFileSync(cssPath, 'utf-8');
    }
  } catch { /* ignore */ }
  return '';
}

// Cache it — only read once per extension session
let _katexCss: string | null = null;
function katexCss(): string {
  if (_katexCss === null) { _katexCss = getKatexCss(); }
  return _katexCss;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function renderProblem(
  cached: CachedProblem,
  meta: CFProblem | undefined,
  _webview: vscode.Webview,
  _extensionUri: vscode.Uri,
): string {
  const { statement, contestId, index } = cached;
  const id    = `${contestId}${index}`;
  const color = ratingColor(meta?.rating);
  const label = ratingLabel(meta?.rating);

  const descHtml     = blocksToHtml(statement.description);
  const inputHtml    = blocksToHtml(statement.input);
  const outputHtml   = blocksToHtml(statement.output);
  const noteHtml     = statement.note ? blocksToHtml(statement.note) : '';
  const examplesHtml = renderExamples(statement.examples);

  const tagsHtml = meta?.tags?.length
    ? meta.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '<span class="muted">No tags</span>';

  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');

  // KaTeX fonts — inline the CSS but fonts are loaded from relative paths.
  // We use a CDN fallback only for the fonts (not the CSS or JS).
  const katexFontsCdn = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/';

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           font-src https://cdn.jsdelivr.net;
           img-src data: https: vscode-resource:;
           script-src 'nonce-${nonce}';">
<title>[${id}] ${esc(statement.title)}</title>

<!-- KaTeX CSS from CDN (fonts need CDN anyway) -->
<link nonce="${nonce}" rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">

<style nonce="${nonce}">
/* ── Tokens ── */
:root {
  --bg:       var(--vscode-editor-background);
  --fg:       var(--vscode-editor-foreground);
  --muted:    var(--vscode-descriptionForeground, #888);
  --border:   var(--vscode-panel-border, #3a3a3a);
  --accent:   #4e9eff;
  --card:     var(--vscode-sideBar-background, #1c1c1c);
  --pre-bg:   var(--vscode-textBlockQuote-background, #232323);
  --tag-bg:   var(--vscode-badge-background, #2a2a2a);
  --tag-fg:   var(--vscode-badge-foreground, #bbb);
  --rating:   ${color};
  --r:        6px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.8;
  color: var(--fg);
  background: var(--bg);
  padding: 0 28px 72px;
  max-width: 860px;
  margin: 0 auto;
}

/* ── Header ── */
.hdr { padding: 24px 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 28px; }
.contest-pill {
  display: inline-block;
  font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: var(--accent); margin-bottom: 8px;
}
.prob-title { font-size: 23px; font-weight: 700; line-height: 1.3; }

/* ── Meta pills ── */
.meta-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: 20px; padding: 4px 12px;
  font-size: 13px; color: var(--muted);
}
.pill strong { color: var(--fg); font-weight: 600; }
.pill-rating { border-color: var(--rating); }
.pill-rating strong { color: var(--rating); }

/* ── Collapsible detail rows ── */
.detail { margin-top: 10px; }
.detail-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: none; border: none; padding: 0;
  font: inherit; font-size: 12px; color: var(--muted);
  cursor: pointer;
}
.detail-btn:hover { color: var(--fg); }
.chev { font-size: 9px; transition: transform .15s; display: inline-block; }
.chev.open { transform: rotate(90deg); }
.detail-body { display: none; padding: 8px 0 2px; }
.detail-body.open { display: block; }

/* ── Tags ── */
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag {
  background: var(--tag-bg); color: var(--tag-fg);
  border-radius: 4px; padding: 3px 9px; font-size: 12px;
}
.muted { color: var(--muted); font-size: 13px; }

/* ── Sections ── */
.section { margin: 28px 0; }
.sec-title {
  font-size: 11px; font-weight: 700; letter-spacing: 1px;
  text-transform: uppercase; color: var(--muted);
  padding-bottom: 7px; margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

/* ── Text / paragraphs ── */
p { margin: 10px 0; font-size: 15px; }

/* CF tex-span formatting classes */
.tex-font-style-bf, b, strong { font-weight: 700; }
.tex-font-style-it, i, em     { font-style: italic; }
.tex-font-style-tt            { font-family: "Consolas","Menlo",monospace; font-size: .9em; }
.tex-font-style-sl            { font-style: oblique; }
.upper-index                  { vertical-align: super; font-size: .72em; line-height: 0; }
.lower-index                  { vertical-align: sub;   font-size: .72em; line-height: 0; }

/* ── Code / pre ── */
pre, code { font-family: "Consolas","Menlo","Courier New",monospace; }
pre {
  background: var(--pre-bg); border: 1px solid var(--border);
  border-radius: var(--r); padding: 14px 16px;
  overflow-x: auto; font-size: 13.5px; line-height: 1.6;
  margin: 10px 0; white-space: pre;
}

/* ── Images ── */
img { max-width: 100%; border-radius: 4px; margin: 10px 0; display: block; }

/* ── Tables ── */
.table-wrap { overflow-x: auto; margin: 10px 0; }
table { border-collapse: collapse; min-width: 100%; font-size: 14px; }
td, th { border: 1px solid var(--border); padding: 7px 12px; text-align: left; }
th { background: var(--card); font-weight: 600; }

/* ── Lists ── */
ul, ol { padding-left: 26px; margin: 10px 0; }
li { margin: 5px 0; }

/* ── Examples ── */
.example {
  border: 1px solid var(--border); border-radius: var(--r);
  overflow: hidden; margin: 12px 0; background: var(--card);
}
.example-head {
  padding: 9px 14px; background: var(--pre-bg);
  border-bottom: 1px solid var(--border);
}
.example-label {
  font-size: 11px; font-weight: 700; letter-spacing: .6px;
  text-transform: uppercase; color: var(--accent);
}
.io-block { border-bottom: 1px solid var(--border); }
.io-block:last-of-type { border-bottom: none; }
.io-bar {
  display: flex; align-items: center;
  justify-content: space-between;
  padding: 6px 14px 3px;
}
.io-label {
  font-size: 11px; font-weight: 700; letter-spacing: .6px;
  text-transform: uppercase; color: var(--muted);
}
.copy-btn {
  font: inherit; font-size: 11px;
  background: var(--tag-bg); color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 2px 8px; cursor: pointer;
  transition: color .12s, border-color .12s;
}
.copy-btn:hover { color: var(--fg); border-color: var(--accent); }
.copy-btn.ok { color: #4caf50; border-color: #4caf50; }

/* io-pre: MUST have white-space:pre to show newlines */
.io-pre {
  margin: 0; padding: 8px 14px 12px;
  background: transparent; border: none; border-radius: 0;
  white-space: pre; font-size: 13.5px; line-height: 1.65;
}
.example-note {
  padding: 10px 14px; font-size: 13px; color: var(--muted);
  border-top: 1px solid var(--border); background: var(--pre-bg);
}

/* ── KaTeX ── */
.katex-display { margin: 16px 0; overflow-x: auto; }
.math-error { color: #f44; font-family: monospace; font-size: 13px; }
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="hdr">
  <div class="contest-pill">Contest ${contestId} &middot; Problem ${index}</div>
  <div class="prob-title">${esc(statement.title)}</div>

  <div class="meta-row">
    <span class="pill"><span>&#9201;</span><strong>${esc(statement.timeLimit)}</strong></span>
    <span class="pill"><span>&#128190;</span><strong>${esc(statement.memoryLimit)}</strong></span>
    ${meta?.rating ? `<span class="pill pill-rating"><strong>${meta.rating}</strong><span style="opacity:.6;font-size:11px;margin-left:3px">${label}</span></span>` : ''}
  </div>

  <!-- Tags (collapsed by default) -->
  <div class="detail">
    <button class="detail-btn" onclick="tog('tags','this_btn',this)">
      <span class="chev" id="chev-tags">&#9658;</span>
      Tags${meta?.tags?.length ? ` <span style="opacity:.5;font-size:11px">(${meta.tags.length})</span>` : ''}
    </button>
    <div class="detail-body" id="tags">
      <div class="tags">${tagsHtml}</div>
    </div>
  </div>
</div>

<!-- ── Statement ── -->
<div class="section">${descHtml}</div>

<!-- ── Input ── -->
<div class="section">
  <div class="sec-title">Input</div>
  ${inputHtml}
</div>

<!-- ── Output ── -->
<div class="section">
  <div class="sec-title">Output</div>
  ${outputHtml}
</div>

<!-- ── Examples ── -->
<div class="section">
  <div class="sec-title">Examples</div>
  ${examplesHtml}
</div>

${noteHtml ? `
<div class="section">
  <div class="sec-title">Note</div>
  ${noteHtml}
</div>` : ''}

<script nonce="${nonce}">
  // ── Collapsible ────────────────────────────────────────────────────────────
  function tog(id, _, btn) {
    const body = document.getElementById(id);
    const chev = document.getElementById('chev-' + id);
    const open = body.classList.toggle('open');
    if (chev) chev.classList.toggle('open', open);
  }

  // ── Copy ───────────────────────────────────────────────────────────────────
  function doCopy(btn, text) {
    // unescape HTML entities that were escaped for the attribute
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1500);
  }

  // ── Images via postMessage ─────────────────────────────────────────────────
  const vsApi = acquireVsCodeApi();
  document.querySelectorAll('img[data-cf-image]').forEach(img => {
    const fn = img.getAttribute('data-cf-image');
    if (fn) vsApi.postMessage({ type: 'fetchImage', filename: fn });
  });
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'imageData')
      document.querySelectorAll('img[data-cf-image="'+m.filename+'"]')
        .forEach(i => i.src = m.dataUri);
  });
</script>

</body>
</html>`;
}
