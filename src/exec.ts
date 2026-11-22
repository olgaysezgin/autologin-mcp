import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/** Runs a command and resolves with its exit code; rejects only when the command does not exist. */
export function createExec(platform: NodeJS.Platform = process.platform): ExecFn {
  return (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { shell: platform === 'win32' }, (error, stdout, stderr) => {
        if (error?.code === 'ENOENT') return reject(error);
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}
