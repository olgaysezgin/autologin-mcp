import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/serve.ts', () => ({ serve: vi.fn(async () => undefined) }));

describe('defaultContext', () => {
  it('starts the real MCP server when serving', async () => {
    const { defaultContext } = await import('../src/cli.ts');
    const { serve } = await import('../src/serve.ts');
    await defaultContext().serve();
    expect(serve).toHaveBeenCalledWith();
  });
});
