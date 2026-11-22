// Smoke-tests the built package exactly as npx would run it.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const node = (args, input) => spawnSync(process.execPath, args, { input, encoding: 'utf8' });

const version = node(['dist/bin.js', '--version']);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), pkg.version);

const hook = (filePath) =>
  node(['dist/hooks/guard.js', '--dir', '/tmp/autologin-smoke'], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: filePath } }));
const blocked = hook('/tmp/autologin-smoke/credentials.env');
assert.equal(blocked.status, 2);
assert.match(blocked.stderr, /autologin-mcp blocked Read/);
assert.equal(hook('/tmp/elsewhere.txt').status, 0);

// The MCP server answers initialize over stdio and exits when stdin closes.
const server = spawn(process.execPath, ['dist/bin.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise((resolve) => server.once('exit', resolve));
let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })}\n`,
);
for (let i = 0; i < 100 && !output.includes('"id":1'); i += 1) await new Promise((r) => setTimeout(r, 50));
const reply = JSON.parse(output.split('\n').find((l) => l.includes('"id":1')));
assert.equal(reply.result.serverInfo.name, 'autologin');
assert.match(reply.result.instructions, /never see them/);
server.stdin.end();
const timeout = setTimeout(() => {
  server.kill();
  assert.fail('server did not exit after stdin closed');
}, 5_000);
await exited;
clearTimeout(timeout);
console.log(`smoke ok: autologin-mcp ${pkg.version}`);
