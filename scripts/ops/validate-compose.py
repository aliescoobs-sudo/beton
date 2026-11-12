#!/usr/bin/env python3
"""Strict check of the EFFECTIVE compose configuration (T10g, R19B-02). Reads the output of `config --format json` of the compose CLI on stdin.

  validate-compose.py --stack prod|staging --image <approved digest reference> [--platform linux/amd64]

It reads what compose RESOLVED (env files, shell variables, extra files and overrides all included), so a hostile override cannot hide behind the
file on disk. It prints service names and the name of the rule that failed, NEVER a value from the environment (the configuration holds secrets).
Exit 0: accepted. Exit 1: refused (the reasons are on stderr). Exit 2: usage or unreadable input.
Run with `python3 -I` (no user site, no current directory on the path).
"""
import json
import re
import sys

PG = "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
CADDY = "caddy:2-alpine"

# service -> (image rule, publishes?, allowed bind mounts as (source suffix, target, read_only), allowed extra capabilities)
STACKS = {
    "staging": {
        "project": "kayas-staging",
        "services": {
            "db": {"image": PG, "binds": [("scripts/training/db-init", "/docker-entrypoint-initdb.d", True)],
                   "cap_add": {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}},
            "app": {"image": "APPROVED", "binds": [], "cap_add": set()},
            "proxy": {"image": CADDY, "ports": {("80", "tcp"), ("443", "tcp")},
                      "binds": [("Caddyfile.staging", "/etc/caddy/Caddyfile", True),
                                ("staging/basic-auth.caddy", "/etc/caddy/basic-auth.caddy", True)],
                      "cap_add": {"NET_BIND_SERVICE"}},
            "ops": {"image": "APPROVED", "binds": [], "cap_add": set()},
        },
        "forced_env": {
            "app": {"APP_ENV": "training", "TRAINING_MODE": "true", "STAGING_PROFILE": "true", "REAL_DATA": "false",
                    "SIMULATION_ENABLED": "false", "TRUSTED_PROXY_HOPS": "1", "TRAINING_ALLOW_UNMARKED": "false"},
            "ops": {"APP_ENV": "training", "TRAINING_MODE": "true", "STAGING_PROFILE": "true", "REAL_DATA": "false",
                    "SIMULATION_ENABLED": "false"},
        },
        # none of these may exist in the effective environment of any staging service
        "absent_env": ["ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "E2E_TEST_RUNNER_KEY"],
        "hardened": True,
        "read_only": {"db", "app", "proxy", "ops"},
    },
    "prod": {
        "project": "kayas",
        "services": {
            "db": {"image": PG, "binds": [], "cap_add": {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}},
            "app": {"image": "APPROVED", "binds": [], "cap_add": set()},
            "proxy": {"image": CADDY, "ports": {("80", "tcp"), ("443", "tcp")},
                      "binds": [("Caddyfile", "/etc/caddy/Caddyfile", True)], "cap_add": {"NET_BIND_SERVICE"}},
            "ops": {"image": "APPROVED",
                    "binds": [("backups", "/app/backups", True), ("imports", "/app/imports", True), ("keys", "/app/keys", True),
                              ("reports", "/app/reports", True)], "cap_add": set()},
            "bootstrap": {"image": "APPROVED", "binds": [], "cap_add": set()},
            "backup": {"image": "APPROVED", "binds": [("backups", "/app/backups", False)], "cap_add": set()},
        },
        "forced_env": {
            "app": {"REAL_DATA": "true", "SIMULATION_ENABLED": "false", "TRUSTED_PROXY_HOPS": "1"},
            "ops": {"REAL_DATA": "true", "SIMULATION_ENABLED": "false"},
            "bootstrap": {"REAL_DATA": "true", "SIMULATION_ENABLED": "false"},
        },
        "absent_env": ["TRAINING_MODE", "STAGING_PROFILE", "TRAINING_ALLOW_UNMARKED"],
        "hardened": True,
        # ops, bootstrap and backup keep a writable root: the real backup and import paths were not exercised read-only (docs/STAGING-VPS.md, "not applied")
        "read_only": {"db", "app", "proxy"},
    },
}
DIGEST = re.compile(r"^ghcr\.io/aliescoobs-sudo/kayas@sha256:[0-9a-f]{64}$")
LOCAL_ID = re.compile(r"^sha256:[0-9a-f]{64}$")  # the local rehearsal runs an image by its content id; never accepted without --rehearsal


def main(argv):
    rehearsal = "--rehearsal" in argv
    argv = [a for a in argv if a != "--rehearsal"]
    args = dict(zip(argv[1::2], argv[2::2]))
    stack, image = args.get("--stack"), args.get("--image", "")
    if stack not in STACKS or not (DIGEST.match(image) or (rehearsal and LOCAL_ID.match(image))):
        print("validate-compose: usage: --stack prod|staging --image ghcr.io/aliescoobs-sudo/kayas@sha256:<64 hex>", file=sys.stderr)
        return 2
    try:
        cfg = json.load(sys.stdin)
        services = cfg["services"]
    except Exception:
        print("validate-compose: the compose configuration could not be read", file=sys.stderr)
        return 2
    pol = STACKS[stack]
    bad = []

    def fail(svc, rule):
        bad.append(f"{svc}: {rule}")

    if cfg.get("name") != pol["project"]:
        fail("project", "unexpected compose project name")
    for extra in sorted(set(services) - set(pol["services"])):
        fail(extra, "unexpected service")
    for missing in sorted(set(pol["services"]) - set(services)):
        fail(missing, "expected service is missing")
    for name, rule in pol["services"].items():
        s = services.get(name)
        if s is None:
            continue
        want = image if rule["image"] == "APPROVED" else rule["image"]
        if s.get("image") != want:
            fail(name, "image is not the approved one")
        platform = args.get("--platform", "linux/amd64")
        if name in ("db", "app", "ops", "bootstrap", "backup") and s.get("platform", platform) != platform:
            fail(name, "platform is not the approved one")
        # ports: only the proxy publishes, and only the allowed ones, on any host address
        got = {(str(p.get("published")), p.get("protocol", "tcp")) for p in s.get("ports", [])}
        if rehearsal and name == "proxy":
            # the LOCAL rehearsal: loopback only, unprivileged ports, the same container ports as the host ports (the redirect must point at them)
            for p in s.get("ports", []):
                if p.get("host_ip") != "127.0.0.1" or int(p.get("published") or 0) < 1024 or str(p.get("published")) != str(p.get("target")):
                    fail(name, "a rehearsal port is not loopback / unprivileged / symmetric")
            if len(s.get("ports", [])) != 2:
                fail(name, "the rehearsal must publish exactly two ports")
        else:
            if got != rule.get("ports", set()):
                fail(name, "published ports differ from the allowed ones")
            for p in s.get("ports", []):
                if p.get("host_ip") not in (None, "", "0.0.0.0", "::"):
                    fail(name, "a port is bound to a specific host address")
                if str(p.get("published")) != str(p.get("target")):
                    fail(name, "a published port maps to a different container port")
        # mounts: only the listed bind mounts; named volumes are fine; no docker socket, no host path outside the list
        allowed = {(src, tgt, ro) for src, tgt, ro in rule["binds"]}
        for v in s.get("volumes", []):
            if v.get("type") == "bind":
                src = v.get("source", "")
                ok = any(src.endswith("/" + a_src) and v.get("target") == a_tgt and bool(v.get("read_only")) == a_ro
                         for a_src, a_tgt, a_ro in allowed)
                if not ok:
                    fail(name, f"bind mount to {v.get('target')} is not allowed")
            elif v.get("type") not in ("volume", "tmpfs"):
                fail(name, "unexpected mount type")
        for k in ("privileged", "network_mode", "pid", "ipc", "userns_mode", "devices", "cgroup_parent", "sysctls", "extra_hosts", "dns"):
            if s.get(k):
                fail(name, f"{k} is set")
        if s.get("user") not in (None, "", "10001:10001") and name in ("app", "ops", "backup", "bootstrap"):
            fail(name, "unexpected user")
        extra_caps = set(s.get("cap_add", [])) - rule["cap_add"]
        if extra_caps:
            fail(name, "capabilities beyond the allowed ones")
        if pol["hardened"]:
            if "ALL" not in [c.upper() for c in s.get("cap_drop", [])]:
                fail(name, "cap_drop ALL is missing")
            if not any(o.replace(" ", "") in ("no-new-privileges:true", "no-new-privileges=true") for o in s.get("security_opt", [])):
                fail(name, "no-new-privileges is missing")
            if not s.get("mem_limit") or not s.get("pids_limit"):
                fail(name, "memory or pids limit is missing")
            lg = s.get("logging") or {}
            if lg.get("driver") != "json-file" or not (lg.get("options") or {}).get("max-size"):
                fail(name, "bounded log options are missing")
            if name in pol["read_only"] and not s.get("read_only"):
                fail(name, "read-only root filesystem is missing")
        env = s.get("environment") or {}
        for k, v in pol["forced_env"].get(name, {}).items():
            if str(env.get(k, "")).lower() != v:
                fail(name, f"{k} does not have the required value")
        for k in pol["absent_env"]:
            if env.get(k) not in (None, ""):
                fail(name, f"{k} must be absent")
    # networks: the internal one stays internal; no network may be external
    nets = cfg.get("networks") or {}
    if not (nets.get("internal") or {}).get("internal"):
        fail("networks", "the internal network is not internal")
    for n, d in nets.items():
        if (d or {}).get("external"):
            fail("networks", f"{n} is external")
    if bad:
        for b in bad:
            print("validate-compose: REFUSED " + b, file=sys.stderr)
        return 1
    print(f"validate-compose: {stack} configuration accepted", file=sys.stderr)
    return 0


sys.exit(main(sys.argv))
