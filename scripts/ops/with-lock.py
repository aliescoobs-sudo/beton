#!/usr/bin/env python3
"""with-lock.py <lockfile> -- <command> [args...]   (T10g, R19B-08)

Takes an exclusive, NON-blocking flock on <lockfile> and then replaces itself with the command. The lock belongs to the open file description, so it
is held for as long as the command (or anything that inherited the descriptor) runs and is released by the kernel when the process dies, however it
dies: there is no stale lock to clean up. Exit 75 (EX_TEMPFAIL) when another holder has it. Portable (Linux and macOS); `flock(1)` is not on macOS.
Run with `python3 -I`.
"""
import fcntl
import os
import sys

if len(sys.argv) < 4 or sys.argv[2] != "--":
    print("usage: with-lock.py <lockfile> -- <command> [args...]", file=sys.stderr)
    sys.exit(2)
path, cmd = sys.argv[1], sys.argv[3:]
fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print("with-lock: another run holds " + path + " (a deployment or a maintenance job is in progress)", file=sys.stderr)
    sys.exit(75)
os.set_inheritable(fd, True)
os.environ["KAYAS_LOCK_FD"] = str(fd)
os.execvp(cmd[0], cmd)
