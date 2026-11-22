// Keeps one version everywhere: package.json, the git tag, npm, CHANGELOG.md, the docs and the website.
//
//   node scripts/release.mjs sync              write the package.json version into README, docs and the website
//                                              (`npm version` runs this before it commits and tags)
//   node scripts/release.mjs check [--offline] fail if a version mention, CHANGELOG.md, the git tags or npm disagree
//   node scripts/release.mjs verify-tag        release workflow: the pushed tag is v<version>, on main, and not on npm yet
//   node scripts/release.mjs publish-guard     prepublishOnly: only the release workflow for tag v<version> may publish
//   node scripts/release.mjs notes [version]   print the CHANGELOG.md section of a version (GitHub release notes)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
/** npm lists a temporary "0.0.0-stage" version while it processes a new package. */
const PLACEHOLDER = /-stage$/;
const SEMVER = String.raw`\d+\.\d+\.\d+`;

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`✓ ${message}`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Every place a reader sees the version; group 1 of each pattern is the version. */
function mentionRules() {
  const docs = fs
    .readdirSync(path.join(root, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`);
  return [
    { files: ['README.md', ...docs], patterns: [new RegExp(`${name}@(${SEMVER})`, 'g'), new RegExp(`${name}-(${SEMVER})\\.tgz`, 'g')] },
    { files: ['docs/index.html'], patterns: [new RegExp(`"softwareVersion": "(${SEMVER})"`, 'g'), new RegExp(`· v(${SEMVER})<`, 'g')] },
  ];
}

function mismatches() {
  const found = [];
  for (const { files, patterns } of mentionRules()) {
    for (const file of files) {
      const text = read(file);
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) if (match[1] !== version) found.push(`${file}: "${match[0]}"`);
      }
    }
  }
  return found;
}

function sync() {
  const today = new Date().toISOString().slice(0, 10);
  for (const { files, patterns } of mentionRules()) {
    for (const file of files) {
      const before = read(file);
      let after = patterns.reduce((text, pattern) => text.replace(pattern, (match, old) => match.replace(old, version)), before);
      if (file === 'docs/index.html') after = after.replace(/"dateModified": "\d{4}-\d{2}-\d{2}"/, `"dateModified": "${today}"`);
      if (after !== before) {
        fs.writeFileSync(path.join(root, file), after);
        ok(`${file} now says ${version}`);
      }
    }
  }
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-llms.mjs')], { cwd: root, stdio: 'inherit' });
}

function changelogSection(wanted) {
  const lines = read('CHANGELOG.md').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${wanted} `) || line === `## ${wanted}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

/** Compares x.y.z versions; a prerelease sorts before its release. */
function compare(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-');
    return [...core.split('.').map(Number), pre === undefined ? 1 : 0];
  };
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < pa.length; i += 1) if (pa[i] !== pb[i]) return Math.sign(pa[i] - pb[i]);
  return 0;
}

async function npmState() {
  const response = await fetch(`https://registry.npmjs.org/${name}`, { headers: { accept: 'application/json' } });
  if (response.status === 404) return { published: [], latest: null };
  if (!response.ok) fail(`npm registry answered ${response.status} for ${name}`);
  const data = await response.json();
  const published = Object.keys(data.versions ?? {}).filter((v) => !PLACEHOLDER.test(v));
  const latest = published.reduce((max, v) => (max === null || compare(v, max) > 0 ? v : max), null);
  return { published, latest };
}

async function check({ offline, forRelease }) {
  const wrong = mismatches();
  if (wrong.length > 0) fail(`these mention another version than package.json (${version}); run: node scripts/release.mjs sync\n  ${wrong.join('\n  ')}`);
  ok(`README, docs and website all say ${version}`);

  if (changelogSection(version) === null) fail(`CHANGELOG.md has no "## ${version}" section`);
  ok(`CHANGELOG.md describes ${version}`);

  if (offline) return;
  const { published, latest } = await npmState();
  const tags = new Set(git('tag', '--list', 'v*').split('\n').filter(Boolean));
  const untagged = published.filter((v) => !tags.has(`v${v}`));
  if (untagged.length > 0) fail(`npm has versions without a git tag: ${untagged.join(', ')}`);
  ok(`every npm version has a git tag (${published.length === 0 ? 'none published yet' : published.join(', ')})`);

  if (latest !== null && compare(version, latest) < 0) fail(`package.json says ${version} but npm already has ${latest}: the repository is behind npm`);
  const isPublished = published.includes(version);
  if (forRelease) {
    if (isPublished) fail(`${version} is already on npm; bump the version with npm version`);
    ok(`${version} is newer than npm (${latest ?? 'nothing published'})`);
  } else if (isPublished) {
    ok(`package.json matches npm latest (${version})`);
  } else {
    ok(`${version} is not on npm yet: push tag ${tag} to release it`);
  }
}

function verifyTag() {
  let pushed = process.env.GITHUB_REF_NAME;
  if (pushed === undefined) {
    try {
      pushed = git('describe', '--tags', '--exact-match');
    } catch {
      fail(`HEAD has no tag; release with npm version, which tags ${tag}`);
    }
  }
  if (pushed !== tag) fail(`tag ${pushed} does not match package.json (${version}); release with npm version, which tags ${tag}`);
  ok(`tag ${pushed} matches package.json`);
  try {
    git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
  } catch {
    fail(`${tag} is not on main; push the release commit to main first`);
  }
  ok(`${tag} is on main`);
}

function publishGuard() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== `refs/tags/${tag}`) {
    fail(`publish only through the release workflow: run "npm version <patch|minor|major>", then "git push --follow-tags" to push ${tag}`);
  }
  ok(`publishing ${name}@${version} from tag ${tag}`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'sync':
    sync();
    break;
  case 'check':
    await check({ offline: args.includes('--offline'), forRelease: false });
    break;
  case 'verify-tag':
    verifyTag();
    await check({ offline: false, forRelease: true });
    break;
  case 'publish-guard':
    publishGuard();
    break;
  case 'notes': {
    const wanted = args[0] ?? version;
    const section = changelogSection(wanted);
    if (section === null) fail(`CHANGELOG.md has no "## ${wanted}" section`);
    console.log(section);
    break;
  }
  default:
    fail('usage: node scripts/release.mjs <sync|check [--offline]|verify-tag|publish-guard|notes [version]>');
}
