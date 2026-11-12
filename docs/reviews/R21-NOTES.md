# R21 notes — what the first real VPS deployment found (T10i, 12 Nov 2026)

Source: the owner's first deployment of the fictitious-data staging (image commit `d95b289`, digest `sha256:4cf7f933…`, Ubuntu 24.04, Docker 29, Compose v5). Not an independent review: field notes, with the fix. Real data stays NO-GO.

| # | Finding | Cause | Fix |
| --- | --- | --- | --- |
| 1 | The proxy restarted every ~2 s, "unhealthy": `open /etc/caddy/basic-auth.caddy: permission denied` | `make-basic.sh` wrote the hash 0600, owned by uid 1001; the hardened proxy's root has no `DAC_OVERRIDE`. The macOS rehearsal masked ownership; the adapt test ran unconfined. The owner's `chmod 644` was a temporary workaround. | Decision 228: mode 0644 hash-only file, directory mount, guards in `dc.sh`, `up.sh` diagnosis. Test with the real caddy image, the proxy's flags and a foreign uid (`tests/staging-proxy-readability.int.test.ts`); it fails on the old script. |
| 2 | Trap found while fixing: an atomic rename gives the hash file a new inode; a single-file bind mount keeps the old one, so re-running `make-basic.sh` would have silently left the proxy on the old hash | single-file bind mount of a file replaced by `mv` | The compose mounts the directory read-only; `make-basic.sh` recreates a running proxy through `dc.sh`. Tested (container sees the new file; static check forbids the single-file mount). |
| 3 | `grep -c auth ~/.docker/config.json` printed 1 after `docker logout` | it counts the word `"auths"` even when the object is empty | §8 tests that `"auths"` is empty and prints the expected output. |
| 4 | `ssh deploy@kayas.aliobsil.com` failed from the owner's network | NAT64: the host name does not resolve there | The guide uses the VPS IPv4 for ssh; the name stays for browser/curl. |
| 5 | No certificate line in the Caddy log | no access log, default level hides issuance | §14: rely on the external `curl` checks (401 / 307 or 200 / 308), never `-k`. |
| 6 | Reading the long guide in a terminal | — | §0 tip: `sed -n '/^## N/,/^## M/p' docs/STAGING-VPS.md`. |

Lesson recorded: a test that runs the proxy unconfined, or on a bind mount that masks ownership, does not prove the container can read its files. The new test uses the real flags and a Docker volume.
