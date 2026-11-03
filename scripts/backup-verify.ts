// Verification and independent signature of backup sets (C2). Used by scripts/ops/backup-pull.sh on the OFFICE machine.
//   keygen <dir>                                      create the ed25519 signing key pair (private key stays on the office machine)
//   check <manifest> [--max-age-hours N]              the set is complete, intact and (optionally) fresh
//   ingest <staging> <store> --key <private key file> [--max-age-hours N] [--keep N]
//                                                     verify the pulled sets, copy the good ones into the store, sign a receipt for
//                                                     each new one, prune; exit 1 with the list of problems otherwise
import { generateSigningKeys, ingestSets, verifySet } from './backup-lib';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));

if (command === 'keygen' && positional[0]) {
  const keys = generateSigningKeys(positional[0]);
  console.log(`Private key (keep it on this machine, never on the server): ${keys.privateKeyFile}`);
  console.log(
    `Public key (set BACKUP_SIGNING_PUBLIC_KEY_FILE for restores and on the server): ${keys.publicKeyFile}`,
  );
} else if (command === 'check' && positional[0]) {
  const hours = flag('--max-age-hours');
  const result = await verifySet(positional[0], hours ? { maxAgeMs: Number(hours) * 3_600_000 } : {});
  console.log(result.ok ? `OK ${positional[0]}` : `PROBLEMS: ${result.problems.join('; ')}`);
  process.exitCode = result.ok ? 0 : 1;
} else if (command === 'ingest' && positional[0] && positional[1] && flag('--key')) {
  const result = await ingestSets({
    staging: positional[0],
    store: positional[1],
    privateKeyFile: flag('--key')!,
    maxAgeMs: Number(flag('--max-age-hours') ?? 30) * 3_600_000,
    keep: Number(flag('--keep') ?? 30),
  });
  console.log(`newest: ${result.newest ?? '(none)'}; new sets: ${result.added.join(', ') || '(none)'}`);
  for (const p of result.problems) console.error(`PROBLEM: ${p}`);
  process.exitCode = result.ok ? 0 : 1;
} else {
  console.error(
    'Usage: backup-verify.ts keygen <dir> | check <manifest> [--max-age-hours N] | ingest <staging> <store> --key <file>',
  );
  process.exitCode = 2;
}
