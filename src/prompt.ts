import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

export interface Prompter {
  ask(question: string): Promise<string>;
  /** Reads a line without echoing it (for passwords). */
  askHidden(question: string): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

export class InputClosedError extends Error {
  constructor() {
    super('Input closed before an answer was given.');
  }
}

export type PrompterFactory = (input: Readable & { isTTY?: boolean }, output: Writable) => Prompter;

export const createPrompter: PrompterFactory = (input, output) => {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: input.isTTY === true, prompt: '' });
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  const next = (): Promise<string> =>
    new Promise((resolve, reject) => {
      if (lines.length > 0) return resolve(lines.shift()!);
      if (closed) return reject(new InputClosedError());
      waiters.push((line) => (line === null ? reject(new InputClosedError()) : resolve(line)));
    });

  return {
    async ask(question) {
      output.write(question);
      return (await next()).trim();
    },
    async askHidden(question) {
      output.write(question);
      muted = true;
      try {
        return await next();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    async confirm(question, defaultYes) {
      output.write(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
      const answer = (await next()).trim().toLowerCase();
      if (answer === '') return defaultYes;
      return ['y', 'yes', 'e', 'evet'].includes(answer);
    },
    close() {
      rl.close();
    },
  };
};
