import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli.ts', () => ({ main: vi.fn(async (argv: string[]) => (argv.includes('--fail') ? 1 : 7)) }));

describe('bin', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
  });

  it('passes argv to main and uses its result as the exit code', async () => {
    process.argv = [argv[0]!, 'autologin-mcp', 'list'];
    const { main } = await import('../src/cli.ts');
    await import('../src/bin.ts');
    expect(main).toHaveBeenCalledWith(['list']);
    expect(process.exitCode).toBe(7);
  });
});
