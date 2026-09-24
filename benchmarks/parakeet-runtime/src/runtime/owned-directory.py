"""Create owned cache directories relative to a pinned descriptor."""

import os
import stat
import sys
import uuid


DIRECTORY = 3


def child_name(name):
    if name != os.path.basename(name) or name in ("", ".", ".."):
        raise ValueError("unsafe owned directory name")


def require_directory():
    if not stat.S_ISDIR(os.fstat(DIRECTORY).st_mode):
        raise ValueError("owned directory descriptor is not a directory")


def make_directory(name):
    child_name(name)
    require_directory()
    os.mkdir(name, 0o700, dir_fd=DIRECTORY)


def make_temporary_directory(prefix):
    if not prefix or os.sep in prefix or prefix in (".", ".."):
        raise ValueError("unsafe owned temporary directory prefix")
    require_directory()
    for _ in range(128):
        name = f"{prefix}{uuid.uuid4().hex}"
        try:
            os.mkdir(name, 0o700, dir_fd=DIRECTORY)
        except FileExistsError:
            continue
        print(name)
        return
    raise ValueError("could not allocate an owned temporary directory")


def main():
    operation, value = sys.argv[1:]
    if operation == "mkdir":
        make_directory(value)
    elif operation == "mkdtemp":
        make_temporary_directory(value)
    else:
        raise ValueError("invalid owned directory operation")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
