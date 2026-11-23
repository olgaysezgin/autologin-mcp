import { describe, expect, it } from 'vitest';
import { clientConfig, CLIENTS, shellQuote } from '../src/clients.ts';

const SPEC = 'autologin-mcp@1.2.3';
const SERVER = { command: 'npx', args: ['-y', SPEC] };

describe('shellQuote', () => {
  it('leaves plain words alone and single-quotes the rest', () => {
    expect(shellQuote('autologin-mcp@1.2.3')).toBe('autologin-mcp@1.2.3');
    expect(shellQuote('file:/tmp/a b.tgz')).toBe("'file:/tmp/a b.tgz'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('clientConfig', () => {
  it('knows every listed client and nothing else', () => {
    for (const id of CLIENTS) expect(clientConfig(id, SPEC)).not.toBeNull();
    expect(clientConfig('claude', SPEC)).toBeNull();
  });

  it('uses the mcpServers JSON format for generic clients, Claude Desktop, Cursor and Gemini CLI', () => {
    expect(JSON.parse(clientConfig('json', SPEC)!.snippet)).toEqual({ mcpServers: { autologin: SERVER } });
    const desktop = clientConfig('claude-desktop', SPEC)!;
    expect(JSON.parse(desktop.snippet)).toEqual({ mcpServers: { autologin: SERVER } });
    expect(desktop.where).toContain('claude_desktop_config.json');
    expect(desktop.note).toContain('restart');
    expect(JSON.parse(clientConfig('cursor', SPEC)!.snippet)).toEqual({ mcpServers: { autologin: { type: 'stdio', ...SERVER } } });
    const gemini = clientConfig('gemini', SPEC)!;
    expect(JSON.parse(gemini.snippet)).toEqual({ mcpServers: { autologin: SERVER } });
    expect(gemini.command).toBe(`gemini mcp add -s user autologin npx -- -y ${SPEC}`);
  });

  it('uses the servers format for VS Code, with a code --add-mcp command', () => {
    const vscode = clientConfig('vscode', SPEC)!;
    expect(JSON.parse(vscode.snippet)).toEqual({ servers: { autologin: { type: 'stdio', ...SERVER } } });
    const json = /^code --add-mcp '(.+)'$/.exec(vscode.command!)![1]!;
    expect(JSON.parse(json)).toEqual({ name: 'autologin', type: 'stdio', ...SERVER });
  });

  it('uses TOML for Codex CLI and YAML for Hermes Agent', () => {
    const codex = clientConfig('codex', SPEC)!;
    expect(codex.snippet).toBe(`[mcp_servers.autologin]\ncommand = "npx"\nargs = ["-y", "${SPEC}"]\n`);
    expect(codex.command).toBe(`codex mcp add autologin -- npx -y ${SPEC}`);
    const hermes = clientConfig('hermes', SPEC)!;
    expect(hermes.snippet).toBe(`mcp_servers:\n  autologin:\n    command: "npx"\n    args: ["-y", "${SPEC}"]\n`);
    expect(hermes.command).toBe(`hermes mcp add autologin --command npx --args -y ${SPEC}`);
    expect(hermes.note).toContain('/reload-mcp');
  });

  it('quotes a package spec that needs it', () => {
    const spec = 'file:/tmp/my builds/autologin-mcp.tgz';
    expect(clientConfig('codex', spec)!.command).toBe(`codex mcp add autologin -- npx -y '${spec}'`);
    expect(clientConfig('codex', spec)!.snippet).toContain(`"${spec}"`);
  });
});
