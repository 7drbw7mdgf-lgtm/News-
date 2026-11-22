import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT_DIR = path.resolve(process.argv[2] || path.join(ROOT, 'build/site/assets/indian-express'));
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; PhemeReader/1.0; +https://pheme24.online/)';

function currentEdition(source) {
  const marker = 'window.DAYBREAK = ';
  const start = source.indexOf(marker);
  const end = source.indexOf(';\nwindow.DAYBREAK_ARCHIVE', start);
  if (start < 0 || end < 0) throw new Error('Could not read the current Pheme edition.');
  return JSON.parse(source.slice(start + marker.length, end));
}

function articleSources(edition) {
  const found = new Map();
  for (const rows of Object.values(edition.COVERAGE || {})) {
    for (const row of rows || []) {
      if (!Array.isArray(row) || row[0] !== 'Indian Express' || typeof row[2] !== 'string') continue;
      let url;
      try {
        url = new URL(row[2]);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.hostname !== 'indianexpress.com' || (url.port && url.port !== '443')) continue;
      if (!/^\/article\/[a-zA-Z0-9/_-]+\/?$/.test(url.pathname) || url.pathname.includes('..')) continue;
      const id = /([0-9]+)\/?$/.exec(url.pathname)?.[1];
      if (!id) continue;
      url.search = '';
      url.hash = '';
      found.set(id, url.href);
    }
  }
  return [...found.entries()].map(([id, url]) => ({ id, url }));
}

async function readHtml(response) {
  if (!response.body) throw new Error('empty response body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error('response exceeded 8 MiB');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function fetchArticle(article) {
  let target = new URL(article.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'User-Agent': USER_AGENT,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS) throw new Error('redirect limit reached');
      const next = new URL(location, target);
      if (next.protocol !== 'https:' || next.hostname !== 'indianexpress.com' || (next.port && next.port !== '443') || next.username || next.password) {
        throw new Error('redirect left the permitted HTTPS host');
      }
      target = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('HTTP ' + response.status);
    }
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error('publisher did not return HTML');
    }
    return { url: target.href, html: await readHtml(response) };
  }
  throw new Error('redirect limit reached');
}

const data = await readFile(path.join(ROOT, 'assets/data.js'), 'utf8');
const articles = articleSources(currentEdition(data));
await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

let fetched = 0;
let unavailable = 0;
for (const article of articles) {
  try {
    const page = await fetchArticle(article);
    const body = JSON.stringify({ ...page, fetchedAt: new Date().toISOString() });
    await writeFile(path.join(OUTPUT_DIR, article.id + '.json'), body, 'utf8');
    fetched += 1;
    console.log('Fetched Indian Express article ' + article.id + ' (' + Buffer.byteLength(page.html, 'utf8') + ' bytes).');
  } catch (error) {
    unavailable += 1;
    console.warn('Indian Express article ' + article.id + ' unavailable (' + error.message + '); Pheme will use its RSS fallback.');
  }
  if (article !== articles[articles.length - 1]) await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.log('Indian Express cache: ' + fetched + ' fetched, ' + unavailable + ' unavailable, ' + articles.length + ' in this edition.');
