// Terminal prompts for the ops CLIs (T10g, R19B-04). On a terminal the answers are read from the keyboard: ordinary answers are echoed, SECRETS are read in raw
// mode with echo off and are never given to a line reader. Without a terminal (a pipe, `ops.sh --batch`) the answers are read line by line from stdin and nothing is
// echoed back. The two modes never share stdin with a readline interface at the same moment: on a terminal a readline interface used to hold its own copy of the
// typed secret and hand it to the NEXT prompt as an answer, and the secret was shown while it was typed.
import { createInterface } from 'node:readline/promises';

function pipePrompt() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const next = async () => (await lines.next()).value ?? '';
  return {
    ask: async (prompt: string) => {
      process.stdout.write(prompt);
      return (await next()).trim();
    },
    secret: async (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      return next();
    },
    close: () => rl.close(),
  };
}

function ttyPrompt() {
  const stdin = process.stdin;
  const ask = async (prompt: string) => {
    const rl = createInterface({ input: stdin, output: process.stdout, terminal: true });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close(); // releases stdin: no line reader outlives the question
    }
  };
  const secret = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      // raw mode FIRST (echo off), then the prompt: a fast typist cannot beat the switch
      stdin.setRawMode(true);
      stdin.resume();
      process.stdout.write(prompt);
      let value = '';
      const finish = (out: string) => {
        stdin.setRawMode(false);
        stdin.off('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(out);
      };
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') return finish(value);
          if (char === '\u0003') {
            stdin.setRawMode(false);
            process.exit(130); // Ctrl-C
          }
          value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
        }
      };
      stdin.on('data', onData);
    });
  return { ask, secret, close: () => stdin.pause() };
}

export function createPrompt() {
  return process.stdin.isTTY ? ttyPrompt() : pipePrompt();
}
