import sys
import os
from datetime import datetime
from toolkit.accelerator import get_accelerator

# Captured once at import time, before any Logger wrapping happens. Reusing
# sys.stdout/stderr directly in Logger.__init__ would chain through a previous
# Logger on every subsequent setup_log_to_file() call (persistent process
# handing off between jobs), duplicating writes into every prior job's log file.
_REAL_STDOUT = sys.stdout
_REAL_STDERR = sys.stderr


def print_acc(*args, **kwargs):
    if get_accelerator().is_local_main_process:
        print(*args, **kwargs)


def timing_enabled():
    """Startup/phase timing output is opt-in via AITK_PROFILE_STARTUP=1.

    Useful when chasing where time-to-first-step goes, but noise in a normal
    run, so it stays off unless asked for. Read at call time rather than import
    time so it can be toggled for a single job without a restart.
    """
    return os.environ.get('AITK_PROFILE_STARTUP', '0').lower() in ('1', 'true', 'yes')


def print_timing(*args, **kwargs):
    """print_acc, but only when AITK_PROFILE_STARTUP is set."""
    if timing_enabled():
        print_acc(*args, **kwargs)


class Logger:
    def __init__(self, terminal, log_file):
        self.terminal = terminal
        self.log = log_file
        self._at_line_start = True

    def _stamp(self, message):
        """Prefix each new line written to the log file with a wall clock time.

        Without this, working out where startup time goes means hand-adding
        timers to the code and restarting the job for every question. With it,
        the gap between any two log lines is readable directly.

        Only the log file is stamped, not the terminal, and only real line
        starts are: tqdm redraws its progress bars with '\\r' and no newline, so
        splitting on '\\r' too would stamp every single progress tick.
        """
        if not message:
            return message
        ts = datetime.now().strftime('%H:%M:%S.%f')[:-3]
        parts = message.split('\n')
        out = []
        for i, part in enumerate(parts):
            if self._at_line_start and part.strip():
                out.append(f'[{ts}] {part}')
            else:
                out.append(part)
            if i != len(parts) - 1:
                out.append('\n')
                self._at_line_start = True
            else:
                self._at_line_start = (part == '')
        return ''.join(out)

    def write(self, message):
        self.terminal.write(message)
        self.log.write(self._stamp(message))
        self.log.flush()  # Make sure it's written immediately

    def flush(self):
        self.terminal.flush()
        self.log.flush()

    def isatty(self):
        return self.terminal.isatty()


def setup_log_to_file(filename):
    if get_accelerator().is_local_main_process:
        if not os.path.exists(os.path.dirname(filename)):
            os.makedirs(os.path.dirname(filename))
    # Close the previous log file handle before replacing it (persistent process
    # handing off between jobs would otherwise leak one fd per job forever).
    # Both wrappers share a single handle, so closing stdout's covers stderr too.
    if isinstance(sys.stdout, Logger):
        try:
            sys.stdout.log.close()
        except Exception:
            pass
    # Wrap the real streams captured at import time — wrapping the
    # already-replaced sys.stdout would chain through the previous Logger and
    # double-write every message into every prior job's log file.
    log_file = open(filename, 'a')
    sys.stdout = Logger(_REAL_STDOUT, log_file)
    sys.stderr = Logger(_REAL_STDERR, log_file)
