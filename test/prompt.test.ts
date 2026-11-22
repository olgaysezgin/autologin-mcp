import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter, InputClosedError } from '../src/prompt.ts';

function streams(tty = false) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += String(chunk);
  });
  return { input, output, written: () => written };
}

describe('createPrompter', () => {
  it('asks questions and keeps answers typed ahead of time', async () => {
    const { input, output, written } = streams();
    const prompter = createPrompter(input, output);
    input.write('  staging  \nexample.com\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await prompter.ask('Name: ')).toBe('staging');
    expect(await prompter.ask('URL: ')).toBe('example.com');
    const later = prompter.ask('User: ');
    input.write('me\n');
    expect(await later).toBe('me');
    expect(written()).toBe('Name: URL: User: ');
    prompter.close();
  });

  it('does not echo hidden answers on a terminal', async () => {
    const { input, output, written } = streams(true);
    const prompter = createPrompter(input, output);
    const visible = prompter.ask('User: ');
    input.write('alice\r');
    expect(await visible).toBe('alice');
    const hidden = prompter.askHidden('Password: ');
    input.write(' s3cret \r');
    expect(await hidden).toBe(' s3cret ');
    expect(written()).toContain('alice');
    expect(written()).not.toContain('s3cret');
    expect(written()).toContain('Password: \n');
    prompter.close();
  });

  it('confirms with defaults and yes/evet', async () => {
    const { input, output } = streams();
    const prompter = createPrompter(input, output);
    input.write('\n\ny\nEvet\nno\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await prompter.confirm('A?', true)).toBe(true);
    expect(await prompter.confirm('B?', false)).toBe(false);
    expect(await prompter.confirm('C?', false)).toBe(true);
    expect(await prompter.confirm('D?', false)).toBe(true);
    expect(await prompter.confirm('E?', true)).toBe(false);
    prompter.close();
  });

  it('rejects pending and later questions once the input closes', async () => {
    const { input, output } = streams();
    const prompter = createPrompter(input, output);
    const pending = prompter.ask('Name: ');
    input.end();
    await expect(pending).rejects.toBeInstanceOf(InputClosedError);
    await expect(prompter.askHidden('Password: ')).rejects.toThrow('Input closed');
  });
});
