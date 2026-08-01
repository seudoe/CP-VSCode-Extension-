import * as https from 'https';
import * as http from 'http';
import * as url from 'url';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

/** Fetches a URL and returns the raw response body as a string. Follows redirects. */
export function fetchHtml(targetUrl: string, redirectsLeft = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      targetUrl,
      {
        headers: {
          // Codeforces returns a stripped page without a browser UA — use a real one
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        // Follow redirects (301, 302, 303, 307, 308)
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const redirectUrl = url.resolve(targetUrl, res.headers.location);
          res.resume(); // drain the response
          resolve(fetchHtml(redirectUrl, redirectsLeft - 1));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          return;
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(body));
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Request timed out: ${targetUrl}`));
    });

    req.on('error', reject);
  });
}

/** Fetches a binary resource (image) and returns it as a Buffer. */
export function fetchBinary(targetUrl: string, redirectsLeft = MAX_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      targetUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const redirectUrl = url.resolve(targetUrl, res.headers.location);
          res.resume();
          resolve(fetchBinary(redirectUrl, redirectsLeft - 1));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Binary fetch timed out: ${targetUrl}`));
    });

    req.on('error', reject);
  });
}
