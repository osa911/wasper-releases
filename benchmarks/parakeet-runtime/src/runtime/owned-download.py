"""Stream a verified download relative to the inherited owned-directory fd.

Never reopen the destination by pathname. Renaming its parent or replacing it
with a symlink cannot redirect creation, writes, promotion, or cleanup.
"""

import hashlib
import os
import stat
import sys
import uuid


def receive():
    directory = 3
    name, expected_hash, expected_size = sys.argv[1:]
    if name != os.path.basename(name) or name in ("", ".", ".."):
        raise ValueError("unsafe download filename")
    if not stat.S_ISDIR(os.fstat(directory).st_mode):
        raise ValueError("download descriptor is not a directory")
    expected_size = None if expected_size == "-" else int(expected_size)
    # Binary dependency locks may omit size, but never the checksum. Bound
    # those transfers independently; model transfers use their exact size.
    limit = 1024**3 if expected_size is None else expected_size
    partial = name + "." + str(uuid.uuid4()) + ".part"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(partial, flags, 0o600, dir_fd=directory)
    size = 0
    digest = hashlib.sha256()
    with os.fdopen(fd, "wb") as output:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError("download size mismatch")
            digest.update(chunk)
            output.write(chunk)
    if (
        expected_size is not None and size != expected_size
    ) or digest.hexdigest() != expected_hash:
        raise ValueError("download SHA-256 or size mismatch")
    os.link(
        partial,
        name,
        src_dir_fd=directory,
        dst_dir_fd=directory,
        follow_symlinks=False,
    )
    os.unlink(partial, dir_fd=directory)


if __name__ == "__main__":
    try:
        receive()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
