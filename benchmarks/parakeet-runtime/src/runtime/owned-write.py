"""Write stdin to a new file through an inherited owned-directory descriptor."""

import os
import stat
import sys


def write_exclusive():
    directory = 3
    name = sys.argv[1]
    if name != os.path.basename(name) or name in ("", ".", ".."):
        raise ValueError("unsafe owned write filename")
    if not stat.S_ISDIR(os.fstat(directory).st_mode):
        raise ValueError("owned write descriptor is not a directory")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(name, flags, 0o600, dir_fd=directory)
    with os.fdopen(fd, "wb") as output:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)


if __name__ == "__main__":
    try:
        write_exclusive()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
