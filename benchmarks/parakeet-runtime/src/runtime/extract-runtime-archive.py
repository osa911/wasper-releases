#!/usr/bin/env python3
"""Extract one hash-locked runtime tarball through inherited descriptors."""

import hashlib
import os
import stat
import sys
import tarfile


ARCHIVE_DESCRIPTOR = 3
DESTINATION_DESCRIPTOR = 4
CHUNK_SIZE = 1024 * 1024


def safe_parts(name):
    name = name.rstrip("/")
    if not name or name.startswith("/") or "\\" in name:
        raise ValueError("unsafe runtime archive member path")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("unsafe runtime archive member path")
    return parts


def safe_link_target(member_parts, target, root):
    if not target or target.startswith("/") or "\\" in target:
        raise ValueError("runtime archive symlink target escapes its root")
    resolved = list(member_parts[:-1])
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if len(resolved) <= 1:
                raise ValueError("runtime archive symlink target escapes its root")
            resolved.pop()
        else:
            resolved.append(part)
    if not resolved or resolved[0] != root:
        raise ValueError("runtime archive symlink target escapes its root")


def validate_members(archive, root):
    members = archive.getmembers()
    seen = set()
    root_seen = False
    for member in members:
        parts = safe_parts(member.name)
        if parts[0] != root:
            raise ValueError("runtime archive member escapes its locked root")
        name = "/".join(parts)
        if name in seen:
            raise ValueError("runtime archive has duplicate member paths")
        seen.add(name)
        if member.isdir():
            if parts == [root]:
                root_seen = True
            continue
        if member.isfile():
            if member.size < 0:
                raise ValueError("runtime archive has invalid regular-file size")
            continue
        if member.issym():
            safe_link_target(parts, member.linkname, root)
            continue
        raise ValueError("runtime archive contains unsupported member type")
    if not root_seen:
        raise ValueError("runtime archive is missing its locked root directory")
    return members


def open_directory_at(parent, name):
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=parent,
    )
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ValueError("runtime archive parent is not a real directory")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def open_parent(destination, parts):
    descriptor = os.dup(destination)
    try:
        for name in parts:
            child = open_directory_at(descriptor, name)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def create_directory(destination, parts):
    parent = os.dup(destination) if len(parts) == 1 else open_parent(destination, parts[:-1])
    try:
        os.mkdir(parts[-1], 0o755, dir_fd=parent)
    finally:
        os.close(parent)


def write_file(archive, member, destination, parts):
    parent = open_parent(destination, parts[:-1])
    descriptor = None
    try:
        descriptor = os.open(
            parts[-1],
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            member.mode & 0o777,
            dir_fd=parent,
        )
        with os.fdopen(descriptor, "wb") as output:
            descriptor = None
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("runtime archive regular member cannot be read")
            with source:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(remaining, CHUNK_SIZE))
                    if not chunk:
                        raise ValueError("runtime archive member is truncated")
                    output.write(chunk)
                    remaining -= len(chunk)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def create_symlink(destination, member, parts):
    parent = open_parent(destination, parts[:-1])
    try:
        os.symlink(member.linkname, parts[-1], dir_fd=parent)
    finally:
        os.close(parent)


def verify_archive(source, expected_hash, expected_size):
    metadata = os.fstat(source.fileno())
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != expected_size:
        raise ValueError("runtime archive changed before extraction")
    digest = hashlib.sha256()
    source.seek(0)
    while True:
        chunk = source.read(CHUNK_SIZE)
        if not chunk:
            break
        digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError("runtime archive SHA-256 mismatch before extraction")
    source.seek(0)


def main():
    expected_hash, expected_size, root = sys.argv[1:]
    if root in ("", ".", "..") or "/" in root or "\\" in root:
        raise ValueError("runtime archive root must be one path component")
    with os.fdopen(os.dup(ARCHIVE_DESCRIPTOR), "rb") as source:
        if not stat.S_ISDIR(os.fstat(DESTINATION_DESCRIPTOR).st_mode):
            raise ValueError("runtime archive destination is not a directory")
        verify_archive(source, expected_hash, int(expected_size))
        with tarfile.open(fileobj=source, mode="r:gz") as archive:
            members = validate_members(archive, root)
            for member in sorted(
                (member for member in members if member.isdir()),
                key=lambda member: len(safe_parts(member.name)),
            ):
                create_directory(DESTINATION_DESCRIPTOR, safe_parts(member.name))
            for member in members:
                parts = safe_parts(member.name)
                if member.isfile():
                    write_file(archive, member, DESTINATION_DESCRIPTOR, parts)
                elif member.issym():
                    create_symlink(DESTINATION_DESCRIPTOR, member, parts)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
