import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTotpSecret, totpCode } from '../../src/totp.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Credentials accepted by the fixture app. The password has quotes, spaces and # on purpose. */
export const VALID = { username: 'qa@example.com', password: `p@ss w0rd#'1"` };

/** The fixture app's authenticator secret (totp.html): it accepts the code of the current step, or one step either side. */
export const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const TOTP = (parseTotpSecret(TOTP_SECRET) as { ok: true; config: Parameters<typeof totpCode>[0] }).config;

export interface FixtureServer {
  origin: string;
  /** Every credential pair the app received, to prove what was typed. */
  received: Array<{ username: string; password: string }>;
  /** Every one-time code the app received (totp.html). */
  codes: string[];
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const received: FixtureServer['received'] = [];
  const codes: string[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await readBody(req));
        const pair = { username: form.get('email') ?? '', password: form.get('password') ?? '' };
        received.push(pair);
        if (pair.username === VALID.username && pair.password === VALID.password) {
          res.writeHead(302, { location: '/dashboard.html' }).end();
        } else {
          const html = await fs.readFile(path.join(FIXTURES, 'plain.html'), 'utf8');
          res
            .writeHead(200, { 'content-type': 'text/html' })
            .end(html.replace('<!--ERROR-->', '<p class="error" role="alert">Invalid email or password</p>'));
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/totp') {
        const { code } = JSON.parse(await readBody(req)) as { code: string };
        codes.push(code);
        const ok = [-30_000, 0, 30_000].some((skew) => totpCode(TOTP, Date.now() + skew) === code);
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const pair = JSON.parse(await readBody(req)) as { username: string; password: string };
        received.push(pair);
        const ok = pair.username === VALID.username && pair.password === VALID.password;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
        return;
      }
      try {
        const html = await fs.readFile(path.join(FIXTURES, path.basename(url.pathname)), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html' }).end(html);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    codes,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // Chrome keeps idle connections open; do not wait for them
      }),
  };
}
