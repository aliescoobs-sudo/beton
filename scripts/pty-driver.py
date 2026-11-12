#!/usr/bin/env python3
"""pty-driver.py (test helper, T10g R19B-04): runs a command on a REAL pseudo-terminal, answers its prompts, and reports what the terminal showed.

  python3 -I scripts/pty-driver.py [--timeout 30] [--umask 022] -- <command> [args...]      steps as JSON on stdin:
  [{"expect": "regex", "send": "text"}, ...]        `send` is typed exactly as given (add "\\r" yourself); "expect" is searched in the output since the last step.
Prints one JSON object: {"transcript": "<everything the terminal displayed>", "status": <exit code>, "timeout": false}. The transcript is what a person
would see on the screen (the terminal echoes typed characters unless the program turned echo off), so a secret that appears in it WAS displayed.
"""
import json
import os
import pty
import re
import select
import sys
import time

args = sys.argv[1:]
timeout, umask = 30.0, None
while args and args[0] != "--":
    if args[0] == "--timeout":
        timeout = float(args[1]); args = args[2:]
    elif args[0] == "--umask":
        umask = int(args[1], 8); args = args[2:]
    else:
        print("usage: pty-driver.py [--timeout S] [--umask 022] -- cmd...", file=sys.stderr); sys.exit(2)
cmd = args[1:]
steps = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    if umask is not None:
        os.umask(umask)
    os.execvp(cmd[0], cmd)
buf, shown, status, timed_out = "", "", None, False
deadline = time.time() + timeout

def pump(wait=0.2):
    global buf, shown
    r, _, _ = select.select([fd], [], [], wait)
    if r:
        try:
            data = os.read(fd, 4096).decode("utf8", "replace")
        except OSError:
            return False
        if not data:
            return False
        buf += data; shown += data
    return True

alive = True
for step in steps:
    pat = re.compile(step["expect"])
    while alive and not pat.search(buf):
        if time.time() > deadline:
            timed_out = True; break
        alive = pump()
    if timed_out or not alive and not pat.search(buf):
        timed_out = timed_out or not alive
        break
    buf = buf[pat.search(buf).end():]
    os.write(fd, step["send"].encode("utf8"))
while alive and time.time() < deadline:
    alive = pump(0.2)
if alive and time.time() >= deadline:
    timed_out = True
try:
    if timed_out:
        os.kill(pid, 9)
    _, st = os.waitpid(pid, 0)
    status = os.waitstatus_to_exitcode(st)
except Exception:
    status = -1
print(json.dumps({"transcript": shown, "status": status, "timeout": timed_out}))
