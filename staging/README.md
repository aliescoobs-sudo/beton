# staging/

This folder holds the private files of the STAGING proxy. Only this README is in git.

- `basic-auth.caddy` is made on the server by `scripts/staging/make-basic.sh` (hidden prompt, `umask 077`, mode 0600). It holds a bcrypt hash and nothing else.
- `basic-auth.caddy.example` shows its shape with a fake hash.
