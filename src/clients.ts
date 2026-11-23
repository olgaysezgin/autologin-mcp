import { SERVER_NAME } from './installer.js';

/**
 * MCP configuration for clients other than Claude Code (which has `install`), as printed by `print-config`.
 * Formats follow each client's own documentation (checked 2026-11):
 *   Claude Desktop  https://modelcontextprotocol.io/docs/develop/connect-local-servers
 *   Cursor          https://cursor.com/docs/context/mcp
 *   VS Code         https://code.visualstudio.com/docs/agents/reference/mcp-configuration
 *   Gemini CLI      https://geminicli.com/docs/tools/mcp-server/
 *   Codex CLI       https://developers.openai.com/codex/mcp
 *   Hermes Agent    https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
 */
export interface ClientConfig {
  name: string;
  /** Where the snippet goes. */
  where: string;
  /** The configuration to add, ending with a newline. */
  snippet: string;
  /** A command of the client that adds the server instead, if it has one. */
  command?: string;
  note?: string;
}

export const CLIENTS = ['json', 'claude-desktop', 'cursor', 'vscode', 'gemini', 'codex', 'hermes'] as const;
export type ClientId = (typeof CLIENTS)[number];

/** Quotes a word for POSIX shells when it needs it. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const list = (items: string[]): string => `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;

export function clientConfig(id: string, packageSpec: string): ClientConfig | null {
  const args = ['-y', packageSpec];
  const server = { command: 'npx', args };
  const npx = `npx ${args.map(shellQuote).join(' ')}`;
  switch (id as ClientId) {
    case 'json':
      return { name: 'your MCP client', where: "your client's MCP configuration (the common mcpServers format)", snippet: json({ mcpServers: { [SERVER_NAME]: server } }) };
    case 'claude-desktop':
      return {
        name: 'Claude Desktop',
        where:
          'claude_desktop_config.json (Settings > Developer > Edit Config): ~/Library/Application Support/Claude/ on macOS, %APPDATA%\\Claude\\ on Windows',
        snippet: json({ mcpServers: { [SERVER_NAME]: server } }),
        note: 'Quit and restart Claude Desktop after saving.',
      };
    case 'cursor':
      return {
        name: 'Cursor',
        where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project)',
        snippet: json({ mcpServers: { [SERVER_NAME]: { type: 'stdio', ...server } } }),
      };
    case 'vscode':
      return {
        name: 'VS Code',
        where: '.vscode/mcp.json (one workspace) or your user mcp.json (command "MCP: Open User Configuration")',
        snippet: json({ servers: { [SERVER_NAME]: { type: 'stdio', ...server } } }),
        command: `code --add-mcp ${shellQuote(JSON.stringify({ name: SERVER_NAME, type: 'stdio', ...server }))}`,
      };
    case 'gemini':
      return {
        name: 'Gemini CLI',
        where: '~/.gemini/settings.json (all projects) or .gemini/settings.json (one project)',
        snippet: json({ mcpServers: { [SERVER_NAME]: server } }),
        command: `gemini mcp add -s user ${SERVER_NAME} npx -- ${args.map(shellQuote).join(' ')}`,
      };
    case 'codex':
      return {
        name: 'Codex CLI',
        where: '~/.codex/config.toml',
        snippet: `[mcp_servers.${SERVER_NAME}]\ncommand = "npx"\nargs = ${list(args)}\n`,
        command: `codex mcp add ${SERVER_NAME} -- ${npx}`,
      };
    case 'hermes':
      return {
        name: 'Hermes Agent',
        where: '~/.hermes/config.yaml (merge it into an existing mcp_servers: block)',
        snippet: `mcp_servers:\n  ${SERVER_NAME}:\n    command: "npx"\n    args: ${list(args)}\n`,
        command: `hermes mcp add ${SERVER_NAME} --command npx --args ${args.map(shellQuote).join(' ')}`,
        note: 'In a running session, /reload-mcp loads it.',
      };
    default:
      return null;
  }
}
