#!/usr/bin/env python3
"""Delete benchmark-owned entries without following mutable ancestor paths."""

import argparse
from contextlib import ExitStack
import json
import os
import stat
import sys
import uuid


CLEANUP_DIRECTORY_NAMES = ("artifacts", "corpus", "holders", "runs")
DIRECTORY_OPEN_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
OWNER_FILE = ".wasper-parakeet-runtime-benchmark-owner.json"
NAMESPACE_DESCRIPTOR = 3


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


def create_deletion_handoff(parent_fd):
    for _ in range(128):
        name = f".wasper-parakeet-delete-{uuid.uuid4().hex}"
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            continue
        handoff_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        handoff_fd = open_directory_at(
            parent_fd,
            name,
            handoff_stat,
            "generated deletion handoff",
        )
        return name, handoff_stat, handoff_fd
    raise UnsafeCleanupError("could not allocate a generated deletion handoff")


def delete_entry(parent_fd, name, label, expected_stat=None):
    try:
        entry_stat = expected_stat or os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(entry_stat.st_mode):
        # CMake build trees legitimately contain library and executable links.
        # Unlinking by the already-pinned parent descriptor never follows the
        # target, so it removes only the generated link.
        os.unlink(name, dir_fd=parent_fd)
        return True
    if not stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISREG(entry_stat.st_mode):
        raise UnsafeCleanupError(f"{label} has an unsupported file type")

    handoff_name, handoff_stat, handoff_fd = create_deletion_handoff(parent_fd)
    try:
        os.rename(
            name,
            "owned-entry",
            src_dir_fd=parent_fd,
            dst_dir_fd=handoff_fd,
        )
        moved_stat = os.stat("owned-entry", dir_fd=handoff_fd, follow_symlinks=False)
        require_same_identity(entry_stat, moved_stat, label)
        if stat.S_ISDIR(moved_stat.st_mode):
            descriptor = open_directory_at(handoff_fd, "owned-entry", moved_stat, label)
            try:
                for child_name in os.listdir(descriptor):
                    delete_entry(descriptor, child_name, f"{label}/{child_name}")
                os.rmdir("owned-entry", dir_fd=handoff_fd)
            finally:
                os.close(descriptor)
        else:
            descriptor = os.open("owned-entry", FILE_OPEN_FLAGS, dir_fd=handoff_fd)
            try:
                require_same_identity(moved_stat, os.fstat(descriptor), label)
                os.unlink("owned-entry", dir_fd=handoff_fd)
            finally:
                os.close(descriptor)
        current_handoff_stat = os.stat(handoff_name, dir_fd=parent_fd, follow_symlinks=False)
        require_same_identity(handoff_stat, current_handoff_stat, "generated deletion handoff")
        os.rmdir(handoff_name, dir_fd=parent_fd)
    finally:
        os.close(handoff_fd)
    return True


def delete_generated_directory(root_fd, name):
    try:
        directory_stat = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
        raise UnsafeCleanupError(f"generated directory {name} is not a real directory")
    return delete_entry(root_fd, name, f"generated directory {name}", directory_stat)


def inherited_namespace(arguments):
    namespace_stat = os.fstat(NAMESPACE_DESCRIPTOR)
    if not stat.S_ISDIR(namespace_stat.st_mode) or identity(namespace_stat) != (
        arguments.namespace_device,
        arguments.namespace_inode,
    ):
        raise UnsafeCleanupError("benchmark cache namespace changed identity before cleanup")
    return NAMESPACE_DESCRIPTOR


def delete_generated(arguments):
    namespace_fd = inherited_namespace(arguments)
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
    try:
        root_stat = os.stat("owned-cache", dir_fd=container_fd, follow_symlinks=False)
        if identity(root_stat) != (arguments.cache_device, arguments.cache_inode):
            raise UnsafeCleanupError("quarantined owned cache changed identity before cleanup")
        root_fd = open_directory_at(
            container_fd,
            "owned-cache",
            root_stat,
            "quarantined owned cache",
        )
        try:
            removed = []
            for name in CLEANUP_DIRECTORY_NAMES:
                if delete_generated_directory(root_fd, name):
                    removed.append(name)
            return {"removed": removed}
        finally:
            os.close(root_fd)
    finally:
        os.close(container_fd)


def remove_symlink_at(parent_fd, name):
    try:
        entry_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISLNK(entry_stat.st_mode):
        raise UnsafeCleanupError(f"cleanup entry {name} is not a symlink")
    current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    require_same_identity(entry_stat, current_stat, f"cleanup entry {name}")
    os.unlink(name, dir_fd=parent_fd)
    return True


def validate_marker_at(root_fd, cache_root):
    descriptor = os.open(OWNER_FILE, FILE_OPEN_FLAGS | os.O_NONBLOCK, dir_fd=root_fd)
    with os.fdopen(descriptor, encoding="utf-8") as marker_file:
        if not stat.S_ISREG(os.fstat(marker_file.fileno()).st_mode):
            raise UnsafeCleanupError("benchmark ownership marker is not a regular file")
        try:
            marker = json.load(marker_file)
        except (ValueError, UnicodeError) as error:
            raise UnsafeCleanupError("benchmark ownership marker is invalid") from error
    if marker != {
        "schema": "wasper.parakeet-runtime-benchmark.owner.v1",
        "package": "parakeet-runtime",
        "cacheRoot": cache_root,
    }:
        raise UnsafeCleanupError("benchmark ownership marker does not match this cache")


def open_cache_parent(arguments, namespace_fd, descriptors):
    names = (
        []
        if arguments.cache_parent_relative == "."
        else arguments.cache_parent_relative.split(os.sep)
    )
    parent_fd = namespace_fd
    bindings = []
    for name in names:
        require_child_name(name, "cache parent component")
        expected_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        child_fd = open_directory_at(parent_fd, name, expected_stat, "benchmark cache parent")
        descriptors.callback(os.close, child_fd)
        bindings.append((parent_fd, name, expected_stat))
        parent_fd = child_fd
    if identity(os.fstat(parent_fd)) != (
        arguments.cache_parent_device,
        arguments.cache_parent_inode,
    ):
        raise UnsafeCleanupError("benchmark cache parent changed identity before restoration")
    return parent_fd, bindings


def create_quarantine_container(namespace_fd):
    for _ in range(128):
        name = f".parakeet-runtime-clean-{uuid.uuid4().hex}"
        try:
            os.mkdir(name, 0o700, dir_fd=namespace_fd)
        except FileExistsError:
            continue
        container_stat = os.stat(name, dir_fd=namespace_fd, follow_symlinks=False)
        return name, container_stat
    raise UnsafeCleanupError("could not allocate a quarantine container")


def quarantine_cache(arguments):
    require_child_name(arguments.cache_name, "cache name")
    namespace_fd = inherited_namespace(arguments)
    with ExitStack() as descriptors:
        cache_parent_fd, _ = open_cache_parent(arguments, namespace_fd, descriptors)
        source_stat = os.stat(
            arguments.cache_name,
            dir_fd=cache_parent_fd,
            follow_symlinks=False,
        )
        if identity(source_stat) != (arguments.cache_device, arguments.cache_inode):
            raise UnsafeCleanupError("benchmark cache root changed identity before quarantine")
        container_name, container_stat = create_quarantine_container(namespace_fd)
        container_fd = open_directory_at(
            namespace_fd,
            container_name,
            container_stat,
            "quarantine container",
        )
        descriptors.callback(os.close, container_fd)
        os.rename(
            arguments.cache_name,
            "owned-cache",
            src_dir_fd=cache_parent_fd,
            dst_dir_fd=container_fd,
        )
        moved_stat = os.stat("owned-cache", dir_fd=container_fd, follow_symlinks=False)
        if identity(moved_stat) != (arguments.cache_device, arguments.cache_inode):
            raise UnsafeCleanupError("benchmark cache root changed identity during quarantine")
        owned_fd = open_directory_at(container_fd, "owned-cache", moved_stat, "owned cache")
        descriptors.callback(os.close, owned_fd)
        validate_marker_at(owned_fd, arguments.cache_root)
        return {
            "containerName": container_name,
            "containerDevice": str(container_stat.st_dev),
            "containerInode": str(container_stat.st_ino),
        }


def validate_parent_bindings(bindings):
    for parent_fd, name, expected_stat in bindings:
        current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        require_same_identity(expected_stat, current_stat, "benchmark cache parent")


def restore_cache(arguments):
    require_child_name(arguments.cache_name, "cache name")
    require_child_name(arguments.container_name, "quarantine container name")

    # Keep every parent descriptor open through discovery, rename, and cleanup.
    # In particular, the destination parent can be nested below the namespace.
    with ExitStack() as descriptors:
        namespace_fd = inherited_namespace(arguments)
        cache_parent_fd, parent_bindings = open_cache_parent(arguments, namespace_fd, descriptors)
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
        descriptors.callback(os.close, container_fd)

        matches = []
        for name in os.listdir(container_fd):
            entry_stat = os.stat(name, dir_fd=container_fd, follow_symlinks=False)
            if stat.S_ISDIR(entry_stat.st_mode) and identity(entry_stat) == (
                arguments.cache_device,
                arguments.cache_inode,
            ):
                matches.append((name, entry_stat))
        if len(matches) != 1:
            raise UnsafeCleanupError("could not locate the quarantined owned cache by identity")
        owned_name, owned_stat = matches[0]
        owned_fd = open_directory_at(container_fd, owned_name, owned_stat, "owned cache")
        descriptors.callback(os.close, owned_fd)
        validate_marker_at(owned_fd, arguments.cache_root)

        validate_parent_bindings(parent_bindings)
        replacement_removed = remove_symlink_at(cache_parent_fd, arguments.cache_name)
        current_owned_stat = os.stat(owned_name, dir_fd=container_fd, follow_symlinks=False)
        require_same_identity(owned_stat, current_owned_stat, "owned cache")
        os.rename(
            owned_name,
            arguments.cache_name,
            src_dir_fd=container_fd,
            dst_dir_fd=cache_parent_fd,
        )
        restored_stat = os.stat(
            arguments.cache_name, dir_fd=cache_parent_fd, follow_symlinks=False
        )
        require_same_identity(owned_stat, restored_stat, "restored owned cache")
        validate_marker_at(owned_fd, arguments.cache_root)
        validate_parent_bindings(parent_bindings)

        leftover_names = os.listdir(container_fd)
        # Reject all unexpected entries before removing any quarantine leftovers.
        for name in leftover_names:
            entry_stat = os.stat(name, dir_fd=container_fd, follow_symlinks=False)
            if not stat.S_ISLNK(entry_stat.st_mode):
                raise UnsafeCleanupError(f"quarantine retained an unowned entry: {name}")
        for name in leftover_names:
            remove_symlink_at(container_fd, name)

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
    return {
        "restored": True,
        "containerRemoved": True,
        "cacheReplacementRemoved": replacement_removed,
        "ownedCacheDisplaced": owned_name != "owned-cache",
    }


def parse_arguments():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)

    delete_parser = subparsers.add_parser("delete-generated")
    delete_parser.add_argument("--namespace-device", required=True, type=int)
    delete_parser.add_argument("--namespace-inode", required=True, type=int)
    delete_parser.add_argument("--container-name", required=True)
    delete_parser.add_argument("--container-device", required=True, type=int)
    delete_parser.add_argument("--container-inode", required=True, type=int)
    delete_parser.add_argument("--cache-device", required=True, type=int)
    delete_parser.add_argument("--cache-inode", required=True, type=int)

    quarantine_parser = subparsers.add_parser("quarantine-cache")
    quarantine_parser.add_argument("--namespace-device", required=True, type=int)
    quarantine_parser.add_argument("--namespace-inode", required=True, type=int)
    quarantine_parser.add_argument("--cache-parent-relative", required=True)
    quarantine_parser.add_argument("--cache-parent-device", required=True, type=int)
    quarantine_parser.add_argument("--cache-parent-inode", required=True, type=int)
    quarantine_parser.add_argument("--cache-name", required=True)
    quarantine_parser.add_argument("--cache-device", required=True, type=int)
    quarantine_parser.add_argument("--cache-inode", required=True, type=int)
    quarantine_parser.add_argument("--cache-root", required=True)

    restore_parser = subparsers.add_parser("restore-cache")
    restore_parser.add_argument("--cache-parent-relative", required=True)
    restore_parser.add_argument("--cache-parent-device", required=True, type=int)
    restore_parser.add_argument("--cache-parent-inode", required=True, type=int)
    restore_parser.add_argument("--cache-root", required=True)
    restore_parser.add_argument("--cache-name", required=True)
    restore_parser.add_argument("--cache-device", required=True, type=int)
    restore_parser.add_argument("--cache-inode", required=True, type=int)
    restore_parser.add_argument("--namespace-device", required=True, type=int)
    restore_parser.add_argument("--namespace-inode", required=True, type=int)
    restore_parser.add_argument("--container-name", required=True)
    restore_parser.add_argument("--container-device", required=True, type=int)
    restore_parser.add_argument("--container-inode", required=True, type=int)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    operations = {
        "delete-generated": delete_generated,
        "quarantine-cache": quarantine_cache,
        "restore-cache": restore_cache,
    }
    sys.stdout.write(json.dumps(operations[arguments.operation](arguments)) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnsafeCleanupError) as error:
        sys.stderr.write(f"unsafe benchmark cleanup: {error}\n")
        raise SystemExit(1)
