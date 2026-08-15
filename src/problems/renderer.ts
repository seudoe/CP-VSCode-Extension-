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
  if (!r) return '#808080';
  if (r < 1200) return '#808080';
  if (r < 1400) return '#008000';
  if (r < 1600) return '#03A89E';
  if (r < 1900) return '#1a8cff';
  if (r < 2100) return '#AA00AA';
  if (r < 2400) return '#FF8C00';
  return '#FF0000';
}

function ratingLabel(r?: number): string {
  if (!r) return '';
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
  // Display math first
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false, strict: false, output: 'mathml' });
    } catch {
      return `<span class="math-error">$$${esc(latex)}$$</span>`;
    }
  });

  // Inline math
  text = text.replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false, strict: false, output: 'mathml' });
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
      // Prioritize HTML to avoid duplicate text bugs caused by the scraper's plaintext extraction
      if (block.html) {
        let cleanHtml = block.html;
        
        // Convert the MathJax script tags to standard KaTeX blocks
        cleanHtml = cleanHtml.replace(/<script[^>]*type="math\/tex; mode=display"[^>]*>([\s\S]*?)<\/script>/g, (_, tex) => {
          return renderMathInText('$$' + tex + '$$');
        });
        cleanHtml = cleanHtml.replace(/<script[^>]*type="math\/tex"[^>]*>([\s\S]*?)<\/script>/g, (_, tex) => {
          return renderMathInText('$' + tex + '$');
        });

        // Any leftover script tags are errors
        cleanHtml = cleanHtml.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_, latex) => `<span class="math-error">${esc(latex)}</span>`);
        
        return `<p>${cleanHtml}</p>`;
      }

      // Fallback to text if HTML isn't available
      if (block.text != null && block.text !== '') {
        return `<p>${renderMathInText(block.text)}</p>`;
      }

      return '<p></p>';
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
  return examples.map((ex, i) => {
    let inHtml = `<pre class="io-pre">${esc(ex.input)}</pre>`;
    let outHtml = `<pre class="io-pre">${esc(ex.output)}</pre>`;

    if (examples.length === 1) {
      const inputLines = ex.input.trim().split('\n');
      const outputLines = ex.output.trim().split('\n');
      const t = parseInt(inputLines[0]?.trim(), 10);
      
      if (!isNaN(t) && t > 1 && t <= 100000) {
        const remainingIn = inputLines.slice(1);
        if (remainingIn.length % t === 0 && outputLines.length % t === 0) {
          const inPerTest = remainingIn.length / t;
          const outPerTest = outputLines.length / t;
          
          let fIn = `<div class="tc-row alt-0"><div class="tc-num"></div><div class="tc-content">${esc(inputLines[0])}</div></div>`;
          for (let j = 0; j < t; j++) {
            const chunk = remainingIn.slice(j * inPerTest, (j + 1) * inPerTest).join('\n');
            fIn += `<div class="tc-row alt-${(j + 1) % 2}"><div class="tc-num">${j + 1}</div><div class="tc-content">${esc(chunk)}</div></div>`;
          }
          inHtml = `<div class="io-pre" style="padding:8px 0 12px;">${fIn}</div>`;
          
          let fOut = '';
          for (let j = 0; j < t; j++) {
            const chunk = outputLines.slice(j * outPerTest, (j + 1) * outPerTest).join('\n');
            fOut += `<div class="tc-row alt-${(j + 1) % 2}"><div class="tc-num">${j + 1}</div><div class="tc-content">${esc(chunk)}</div></div>`;
          }
          outHtml = `<div class="io-pre" style="padding:8px 0 12px;">${fOut}</div>`;
        }
      }
    }

    return `
<div class="example">
  <div class="example-head">
    <span class="example-label">Example ${i + 1}</span>
  </div>
  <div class="io-block">
    <div class="io-bar">
      <span class="io-label">Input</span>
      <button class="copy-btn" data-copy="${esc(ex.input)}">Copy</button>
    </div>
    ${inHtml}
  </div>
  <div class="io-block">
    <div class="io-bar">
      <span class="io-label">Output</span>
      <button class="copy-btn" data-copy="${esc(ex.output)}">Copy</button>
    </div>
    ${outHtml}
  </div>
  ${ex.explanation ? `<div class="example-note">${renderMathInText(ex.explanation)}</div>` : ''}
</div>`;
  }).join('');
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
  contestName?: string
): string {
  const { statement, contestId, index } = cached;
  const id = `${contestId}${index}`;
  const color = ratingColor(meta?.rating);
  const label = ratingLabel(meta?.rating);

  const descHtml = blocksToHtml(statement.description);
  const inputHtml = blocksToHtml(statement.input);
  const outputHtml = blocksToHtml(statement.output);
  const noteHtml = statement.note ? blocksToHtml(statement.note) : '';
  const examplesHtml = renderExamples(statement.examples);

  const tagsHtml = meta?.tags?.length
    ? meta.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '<span class="muted">No tags</span>';

  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');

  // Load KaTeX CSS and fonts from the local media directory
  const cssUri = _webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, 'media', 'katex.min.css')).toString();

  console.log('--- renderProblem ---');
  console.log('Contest ID:', contestId, 'Index:', index);
  console.log('CSS Webview URI:', cssUri);

  const html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
content="default-src 'none';
style-src 'nonce-${nonce}' ${_webview.cspSource} 'unsafe-inline';
font-src ${_webview.cspSource} data:;
img-src data: https: ${_webview.cspSource};
script-src 'nonce-${nonce}';">
<title>[${id}] ${esc(statement.title)}</title>

<link rel="stylesheet" href="${cssUri}">

<style nonce="${nonce}">
.katex { line-height: 1.2; }
/* Hide Codeforces MathJax previews which are sometimes left in the HTML */
.MathJax_Preview, .MathJax, .MathJax_Processing, .MathJax_Processed, .MJX_Assistive_MathML { display: none !important; }
.katex, .katex * { box-sizing: content-box; }

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

* { margin: 0; padding: 0; }


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
  font-size: 13px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
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
.tc-row {
  display: flex; padding: 4px 14px;
}
.tc-row.alt-0 {
  background: transparent;
}
.tc-row.alt-1 {
  background: rgba(255, 255, 255, 0.04);
}
.tc-num {
  width: 20px; flex-shrink: 0;
  text-align: right; padding-right: 12px;
  color: var(--muted); font-size: 10px;
  user-select: none; line-height: 1.65;
}
.tc-content {
  flex-grow: 1; white-space: pre;
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
  <div class="contest-pill">${contestId} - ${esc(contestName?.toUpperCase() || `CONTEST`)}</div>
  <div class="prob-title">${esc(statement.title)}</div>
  <button class="detail-btn" id="btn-browser-top" style="margin-top: 8px; font-size: 14px; font-weight: 600; color: var(--accent); text-decoration: underline; cursor: pointer;">View in Browser</button>

  <div class="meta-row">
    <span class="pill"><span>&#9201;</span><strong>${esc(statement.timeLimit)}</strong></span>
    <span class="pill"><span>&#128190;</span><strong>${esc(statement.memoryLimit)}</strong></span>
    ${meta?.rating ? `<span class="pill pill-rating"><strong>${meta.rating}</strong><span style="opacity:.6;font-size:11px;margin-left:3px">${label}</span></span>` : ''}
    <button class="copy-btn" id="btn-code-now-top" style="background: var(--accent); color: #fff; font-weight: bold; border: none; padding: 4px 12px; border-radius: 20px; font-size: 12px; cursor: pointer; margin-left: auto;">Code Now</button>
  </div>

  <!-- Tags (collapsed by default) -->
  <div class="detail">
    <button class="detail-btn" id="btn-tags">
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

<div class="section" style="display: flex; justify-content: flex-end; margin-top: -10px; margin-bottom: 20px;">
  <button class="btn btn-blue" id="btn-code-now-bottom" style="background: linear-gradient(135deg, #007acc, #005a9e); color: #fff; border: none; padding: 10px 20px; font-weight: bold; cursor: pointer; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,122,204,0.3);">Code Now</button>
</div>

${noteHtml ? `
<div class="section">
  <div class="sec-title">Note</div>
  ${noteHtml}
</div>` : ''}

<hr style="border: 0; height: 1px; background: var(--border); margin: 40px 0 20px;">
<div class="section" style="padding-top: 0; margin-top: 0;">
  <p style="font-size: 13px; color: var(--muted); margin-bottom: 10px;">
    See any problem/error in the problem statement?
  </p>
  <div style="display: flex; gap: 10px;">
    <button class="copy-btn" id="btn-report">Report Error</button>
    <button class="copy-btn" id="btn-browser-bottom">View in Browser</button>
  </div>
</div>

<script nonce="${nonce}">
  // ── Collapsible ────────────────────────────────────────────────────────────
  function tog(id) {
    const body = document.getElementById(id);
    const chev = document.getElementById('chev-' + id);
    const open = body.classList.toggle('open');
    if (chev) chev.classList.toggle('open', open);
  }
  document.getElementById('btn-tags')?.addEventListener('click', () => tog('tags'));

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
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => doCopy(btn, btn.getAttribute('data-copy')));
  });

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

  // ── Report & Browser Actions ───────────────────────────────────────────────
  document.getElementById('btn-report')?.addEventListener('click', function() {
    this.textContent = 'Reported!';
    this.classList.add('ok');
    vsApi.postMessage({ type: 'reportError' });
  });
  const openBrowser = () => vsApi.postMessage({ type: 'openBrowser' });
  document.getElementById('btn-browser-top')?.addEventListener('click', openBrowser);
  document.getElementById('btn-browser-bottom')?.addEventListener('click', openBrowser);

  // ── Code Now ───────────────────────────────────────────────────────────────
  const doCodeNow = () => vsApi.postMessage({ type: 'codeNow' });
  document.getElementById('btn-code-now-top')?.addEventListener('click', doCodeNow);
  document.getElementById('btn-code-now-bottom')?.addEventListener('click', doCodeNow);
</script>


</body>
</html>`;

  try {
    const fs = require('fs');
    const path = require('path');
    let debugHtml = html
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '') // Remove CSP so browser doesn't block CSS
      .replace(/href="[^"]+katex\.min\.css"/, 'href="media/katex.min.css"');

    // We also need to remove the <script nonce> block entirely because it uses acquireVsCodeApi() which throws outside vscode
    debugHtml = debugHtml.replace(/<script nonce="[^"]+">[\s\S]*?<\/script>/, '');

    fs.writeFileSync(path.join(_extensionUri.fsPath, 'debug.html'), debugHtml);
  } catch (e) {
    console.error('Failed to dump debug.html', e);
  }

  return html;
}
