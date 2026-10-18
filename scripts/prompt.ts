// Terminal prompts for the ops CLIs. Secrets are read without echo on a terminal; piped input is read line by line.
import { createInterface } from 'node:readline/promises';

export function createPrompt() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();

  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    return ((await lines.next()).value ?? '').trim();
  };

  const secret = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) return (await lines.next()).value ?? '';
    return new Promise((resolve) => {
      let value = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.off('data', onData);
            process.stdout.write('\n');
            return resolve(value);
          }
          if (char === '\u0003') process.exit(130); // Ctrl-C
          value = char === '\u007f' ? value.slice(0, -1) : value + char;
        }
      };
      process.stdin.on('data', onData);
    });
  };

  return { ask, secret, close: () => rl.close() };
}
