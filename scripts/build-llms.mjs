// Builds docs/llms-full.txt (all documentation in one plain-text file for AI assistants) and docs/sitemap.xml.
// Usage: node scripts/build-llms.mjs [--check]   (--check fails when the committed files are out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const SITE = 'https://olgaysezgin.github.io/autologin-mcp';

/** Documentation pages in reading order: source file and published URL path. */
export const PAGES = [
  ['README.md', '/docs/'],
  ['getting-started.md', '/getting-started.html'],
  ['how-it-works.md', '/how-it-works.html'],
  ['configuration.md', '/configuration.html'],
  ['mcp-tools.md', '/mcp-tools.html'],
  ['cli.md', '/cli.html'],
  ['security.md', '/security.html'],
  ['clients.md', '/clients.html'],
  ['troubleshooting.md', '/troubleshooting.html'],
  ['faq.md', '/faq.html'],
];

const stripFrontMatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n+/, '');

function llmsFull() {
  const parts = [
    '# autologin-mcp: full documentation',
    '',
    `> Source: ${SITE}/ and https://github.com/olgaysezgin/autologin-mcp. Generated from docs/*.md by scripts/build-llms.mjs.`,
  ];
  for (const [file, url] of PAGES) {
    const body = stripFrontMatter(fs.readFileSync(path.join(docs, file), 'utf8')).trim();
    parts.push('', '---', '', `<!-- ${SITE}${url} -->`, '', body);
  }
  return `${parts.join('\n')}\n`;
}

function sitemap() {
  const urls = ['/', ...PAGES.map(([, url]) => url), '/llms.txt', '/llms-full.txt'];
  const lastmod = new Date().toISOString().slice(0, 10);
  const entries = urls.map((url) => `  <url><loc>${SITE}${url}</loc><lastmod>${lastmod}</lastmod></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...entries, '</urlset>', ''].join('\n');
}

const outputs = [
  ['llms-full.txt', llmsFull()],
  ['sitemap.xml', sitemap()],
];

if (process.argv.includes('--check')) {
  // The sitemap's lastmod is the build date, so only llms-full.txt is compared.
  const [name, expected] = outputs[0];
  const actual = fs.readFileSync(path.join(docs, name), 'utf8');
  if (actual !== expected) {
    console.error(`docs/${name} is out of date: run node scripts/build-llms.mjs`);
    process.exit(1);
  }
  console.log(`docs/${name} is up to date`);
} else {
  for (const [name, content] of outputs) {
    fs.writeFileSync(path.join(docs, name), content);
    console.log(`wrote docs/${name}`);
  }
}
