const fs = require('fs');
const katex = require('katex');

function esc(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMathInText(text) {
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false, strict: false });
    } catch {
      return `<span class="math-error">$$${esc(latex)}$$</span>`;
    }
  });

  text = text.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\[\s\S])+?)\$(?!\$)/g, (_, latex) => {
    try {
      return katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false, strict: false });
    } catch {
      return `<span class="math-error">$${esc(latex)}$</span>`;
    }
  });
  return text;
}

const problemJson = JSON.parse(fs.readFileSync('../CF-scraper-python/saved-from-reparse/2200-2300/2254-D.json', 'utf8'));

// Extract some paragraphs
const paragraphs = problemJson.statement.input.map(block => `<p>${renderMathInText(block.text || block.html || '')}</p>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test Codeforces Render</title>
<link rel="stylesheet" href="media/katex.min.css">
<style>
/* ── Tokens ── */
:root {
  --bg: #1e1e1e;
  --fg: #d4d4d4;
  --border: #3a3a3a;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
.katex, .katex * { box-sizing: content-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.8;
  color: var(--fg);
  background: var(--bg);
  padding: 20px;
  max-width: 860px;
  margin: 0 auto;
}
</style>
</head>
<body>
  <h1>Problem Input</h1>
  ${paragraphs}
  
  <h2>Summation Test</h2>
  <p>${renderMathInText('Here is a sum: $\\sum_{i=1}^{n} a_i$')}</p>
</body>
</html>`;

fs.writeFileSync('test.html', html);
console.log('test.html generated!');
