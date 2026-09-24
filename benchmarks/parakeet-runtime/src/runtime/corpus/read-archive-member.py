"""Stream one exact regular tar member to stdout. Never extract archive paths."""

import os
import stat
import sys
import tarfile


def safe_name(name):
    while name.startswith("./"):
        name = name[2:]
    if not name or name.startswith("/") or "\\" in name:
        raise ValueError("unsafe archive member path")
    if any(part in ("", ".", "..") for part in name.rstrip("/").split("/")):
        raise ValueError("unsafe archive member path")
    return name.rstrip("/")


def main():
    archive_path, requested, limit = sys.argv[1:]
    requested = safe_name(requested)
    limit = int(limit)
    descriptor = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("archive must be a regular file")
        found = False
        with tarfile.open(fileobj=source, mode="r|gz") as archive:
            for member in archive:
                if member.name in (".", "./") and member.isdir():
                    continue
                name = safe_name(member.name)
                if name != requested:
                    continue
                if found:
                    raise ValueError("duplicate requested archive member")
                if not member.isfile() or member.issym() or member.islnk():
                    raise ValueError("requested archive member must be a regular file")
                if member.size <= 0 or member.size > limit:
                    raise ValueError("archive member exceeds byte limit")
                found = True
                with archive.extractfile(member) as data:
                    remaining = member.size
                    while remaining:
                        chunk = data.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise ValueError("truncated archive member")
                        sys.stdout.buffer.write(chunk)
                        remaining -= len(chunk)
        if not found:
            raise ValueError("requested archive member is missing")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
