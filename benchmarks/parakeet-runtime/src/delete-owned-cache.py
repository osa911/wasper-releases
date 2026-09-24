#!/usr/bin/env python3
"""Delete benchmark-owned entries without following mutable ancestor paths."""

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


def require_child_name(name, label):
    if not name or name in (".", "..") or os.sep in name:
        raise UnsafeCleanupError(f"{label} must be a single path component")


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


def open_validated_directory(path, device, inode, label):
    try:
        descriptor = os.open(path, DIRECTORY_OPEN_FLAGS)
    except OSError as error:
        raise UnsafeCleanupError(f"{label} is not a stable real directory") from error
    try:
        actual_stat = os.fstat(descriptor)
        if identity(actual_stat) != (device, inode):
            raise UnsafeCleanupError(f"{label} changed identity before cleanup")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def delete_generated(arguments):
    root_fd = open_validated_directory(
        arguments.root,
        arguments.device,
        arguments.inode,
        "quarantined owned cache",
    )
    removed = []
    try:
        for name in CLEANUP_DIRECTORY_NAMES:
            if delete_generated_directory(root_fd, name):
                removed.append(name)
    finally:
        os.close(root_fd)
    return {"removed": removed}


def remove_symlink(arguments):
    require_child_name(arguments.name, "entry name")
    parent_fd = open_validated_directory(
        arguments.parent,
        arguments.parent_device,
        arguments.parent_inode,
        "cleanup parent",
    )
    try:
        try:
            entry_stat = os.stat(arguments.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"removed": False}
        if not stat.S_ISLNK(entry_stat.st_mode):
            raise UnsafeCleanupError(f"cleanup entry {arguments.name} is not a symlink")
        current_stat = os.stat(arguments.name, dir_fd=parent_fd, follow_symlinks=False)
        require_same_identity(entry_stat, current_stat, f"cleanup entry {arguments.name}")
        os.unlink(arguments.name, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    return {"removed": True}


def remove_quarantine(arguments):
    require_child_name(arguments.container_name, "quarantine container name")
    for name in arguments.entry:
        require_child_name(name, "quarantine entry name")

    namespace_fd = open_validated_directory(
        arguments.namespace,
        arguments.namespace_device,
        arguments.namespace_inode,
        "benchmark cache namespace",
    )
    container_fd = None
    try:
        expected_container_stat = os.stat(
            arguments.container_name,
            dir_fd=namespace_fd,
            follow_symlinks=False,
        )
        if identity(expected_container_stat) != (
            arguments.container_device,
            arguments.container_inode,
        ):
            raise UnsafeCleanupError("quarantine container changed identity before cleanup")
        container_fd = open_directory_at(
            namespace_fd,
            arguments.container_name,
            expected_container_stat,
            "quarantine container",
        )
        actual_entries = os.listdir(container_fd)
        if sorted(actual_entries) != sorted(arguments.entry):
            raise UnsafeCleanupError("quarantine entries changed before cleanup")
        for name in actual_entries:
            entry_stat = os.stat(name, dir_fd=container_fd, follow_symlinks=False)
            if not stat.S_ISLNK(entry_stat.st_mode):
                raise UnsafeCleanupError(f"quarantine entry {name} is not a symlink")
            current_stat = os.stat(name, dir_fd=container_fd, follow_symlinks=False)
            require_same_identity(entry_stat, current_stat, f"quarantine entry {name}")
            os.unlink(name, dir_fd=container_fd)

        current_container_stat = os.stat(
            arguments.container_name,
            dir_fd=namespace_fd,
            follow_symlinks=False,
        )
        require_same_identity(
            expected_container_stat,
            current_container_stat,
            "quarantine container",
        )
        os.rmdir(arguments.container_name, dir_fd=namespace_fd)
    finally:
        if container_fd is not None:
            os.close(container_fd)
        os.close(namespace_fd)
    return {"removed": actual_entries, "containerRemoved": True}


def parse_arguments():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)

    delete_parser = subparsers.add_parser("delete-generated")
    delete_parser.add_argument("--root", required=True)
    delete_parser.add_argument("--device", required=True, type=int)
    delete_parser.add_argument("--inode", required=True, type=int)

    symlink_parser = subparsers.add_parser("remove-symlink")
    symlink_parser.add_argument("--parent", required=True)
    symlink_parser.add_argument("--parent-device", required=True, type=int)
    symlink_parser.add_argument("--parent-inode", required=True, type=int)
    symlink_parser.add_argument("--name", required=True)

    quarantine_parser = subparsers.add_parser("remove-quarantine")
    quarantine_parser.add_argument("--namespace", required=True)
    quarantine_parser.add_argument("--namespace-device", required=True, type=int)
    quarantine_parser.add_argument("--namespace-inode", required=True, type=int)
    quarantine_parser.add_argument("--container-name", required=True)
    quarantine_parser.add_argument("--container-device", required=True, type=int)
    quarantine_parser.add_argument("--container-inode", required=True, type=int)
    quarantine_parser.add_argument("--entry", action="append", default=[])
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    operations = {
        "delete-generated": delete_generated,
        "remove-symlink": remove_symlink,
        "remove-quarantine": remove_quarantine,
    }
    sys.stdout.write(json.dumps(operations[arguments.operation](arguments)) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnsafeCleanupError) as error:
        sys.stderr.write(f"unsafe benchmark cleanup: {error}\n")
        raise SystemExit(1)
