# staging/

This folder is mounted READ-ONLY, as a whole, into the STAGING proxy container (`/etc/caddy/staging`). Everything in it is visible to that container. `scripts/staging/dc.sh` refuses to start the proxy if anything other than the files below is here.

Tracked in git: this README and `basic-auth.caddy.example`. Never tracked: `basic-auth.caddy` and the temporaries.

- `basic-auth.caddy` is made on the server by `scripts/staging/make-basic.sh` (hidden prompt). It holds a bcrypt HASH and nothing else, and it is written atomically (a temporary file, then a rename) with **mode 0644**: the hardened proxy container has no `DAC_OVERRIDE`, so it can read the file only as "other". The hash is readable by every local user of the host (accepted for fictitious data; a production gate). The folder itself must belong to the deploy user and not be writable by group or others.
- `basic-auth.caddy.example` shows its shape with a fake hash.
- `.basic-auth.XXXXXX` (six letters or digits) are the helper's temporary files while it works. A killed run can leave one behind; the next `make-basic.sh` run removes it, and `dc.sh` tolerates only this exact pattern.

Put **nothing else here**: no backups, no exports, no other secrets, no notes, no copies of the hash (`basic-auth.caddy.bak` is refused). The proxy would see them.

After `make-basic.sh` replaces the hash, a running proxy still serves the OLD password until it is recreated; the script does that and reports a non-zero exit if it cannot confirm it (`docs/STAGING-VPS.md`, section 11).
