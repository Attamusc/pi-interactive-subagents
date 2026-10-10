import errno
import json
import os
import pty
import select
import signal
import sys
import termios
import time

# Offline fixture only: a private test PTY, never the user's terminal/Herdr socket.
script, report, tostop = sys.argv[1:]
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
if tostop == "1":
    attrs[3] |= termios.TOSTOP
termios.tcsetattr(slave, termios.TCSANOW, attrs)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    import fcntl
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.tcsetpgrp(slave, os.getpgrp())
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.execvp("bash", ["bash", script])
os.close(slave)
output = bytearray()
status = None
started = time.monotonic()
try:
    while time.monotonic() - started < 3:
        ready, _, _ = select.select([master], [], [], 0.02)
        if ready:
            try:
                data = os.read(master, 4096)
                output.extend(data[:max(0, 25000 - len(output))])
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        waited, state = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = os.waitstatus_to_exitcode(state)
            break
    # Snapshot before fixture cleanup: the runner must not be credited with
    # terminating descendants that only the PTY owner subsequently reaps.
    live_session = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        child = int(entry)
        try:
            if child != pid and os.getsid(child) == pid:
                live_session.append(child)
        except ProcessLookupError:
            pass
    with open(report, "w") as file:
        json.dump({"status": status, "elapsed": time.monotonic() - started,
                   "output": output.decode("utf-8", errors="replace"), "session": pid,
                   "live_session_before_owner_cleanup": live_session}, file)
finally:
    # All descendants remain in this dedicated test session. Cancel that session,
    # including background groups; never signal a PID from the user's session.
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        child = int(entry)
        try:
            if os.getsid(child) == pid:
                os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if status is None:
        os.waitpid(pid, 0)
    os.close(master)
