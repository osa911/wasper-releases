#!/usr/bin/env python3
"""Delete fixed benchmark directories without following mutable ancestor paths."""

import argparse
import json
import os
import stat
import sys


CLEANUP_DIRECTORY_NAMES = ("artifacts", "corpus", "holders", "runs")
DIRECTORY_OPEN_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class UnsafeCleanupError(RuntimeError):
    pass


def identity(file_stat):
    return file_stat.st_dev, file_stat.st_ino


def require_same_identity(expected, actual, label):
    if identity(expected) != identity(actual):
        raise UnsafeCleanupError(f"{label} changed identity during cleanup")


def open_directory_at(parent_fd, name, expected_stat, label):
    try:
        descriptor = os.open(name, DIRECTORY_OPEN_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        raise UnsafeCleanupError(f"{label} is not a stable real directory") from error
    try:
        require_same_identity(expected_stat, os.fstat(descriptor), label)
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def delete_entry(parent_fd, name, label):
    try:
        entry_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return

    if stat.S_ISLNK(entry_stat.st_mode):
        raise UnsafeCleanupError(f"{label} is a symlink")

    if stat.S_ISDIR(entry_stat.st_mode):
        descriptor = open_directory_at(parent_fd, name, entry_stat, label)
        try:
            for child_name in os.listdir(descriptor):
                delete_entry(descriptor, child_name, f"{label}/{child_name}")
            current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            require_same_identity(entry_stat, current_stat, label)
        finally:
            os.close(descriptor)
        os.rmdir(name, dir_fd=parent_fd)
        return

    if stat.S_ISREG(entry_stat.st_mode):
        try:
            descriptor = os.open(name, FILE_OPEN_FLAGS, dir_fd=parent_fd)
        except OSError as error:
            raise UnsafeCleanupError(f"{label} is not a stable regular file") from error
        try:
            require_same_identity(entry_stat, os.fstat(descriptor), label)
            current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            require_same_identity(entry_stat, current_stat, label)
        finally:
            os.close(descriptor)
        os.unlink(name, dir_fd=parent_fd)
        return

    raise UnsafeCleanupError(f"{label} has an unsupported file type")


def delete_generated_directory(root_fd, name):
    try:
        directory_stat = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
        raise UnsafeCleanupError(f"generated directory {name} is not a real directory")

    descriptor = open_directory_at(root_fd, name, directory_stat, f"generated directory {name}")
    try:
        for child_name in os.listdir(descriptor):
            delete_entry(descriptor, child_name, f"{name}/{child_name}")
        current_stat = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        require_same_identity(directory_stat, current_stat, f"generated directory {name}")
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=root_fd)
    return True


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--device", required=True, type=int)
    parser.add_argument("--inode", required=True, type=int)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    try:
        root_fd = os.open(arguments.root, DIRECTORY_OPEN_FLAGS)
    except OSError as error:
        raise UnsafeCleanupError("quarantined owned cache is not a stable real directory") from error

    removed = []
    try:
        root_stat = os.fstat(root_fd)
        if identity(root_stat) != (arguments.device, arguments.inode):
            raise UnsafeCleanupError("quarantined owned cache changed identity before deletion")
        for name in CLEANUP_DIRECTORY_NAMES:
            if delete_generated_directory(root_fd, name):
                removed.append(name)
    finally:
        os.close(root_fd)

    sys.stdout.write(json.dumps({"removed": removed}) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnsafeCleanupError) as error:
        sys.stderr.write(f"unsafe benchmark cleanup: {error}\n")
        raise SystemExit(1)
