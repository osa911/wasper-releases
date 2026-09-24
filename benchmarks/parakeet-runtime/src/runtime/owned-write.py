"""Mutate entries relative to inherited, pinned owned-directory descriptors."""

import os
import stat
import sys
import uuid


DIRECTORY = 3
DESTINATION_DIRECTORY = 4
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


def child_name(name):
    if name != os.path.basename(name) or name in ("", ".", ".."):
        raise ValueError("unsafe owned storage filename")


def identity(metadata):
    return metadata.st_dev, metadata.st_ino


def expected_identity(device, inode):
    return int(device), int(inode)


def require_directory(descriptor):
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        raise ValueError("owned storage descriptor is not a directory")


def require_identity(metadata, device, inode, label):
    if identity(metadata) != expected_identity(device, inode):
        raise ValueError(f"{label} changed identity")


def write_bytes(name, replace):
    child_name(name)
    require_directory(DIRECTORY)
    if not replace:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(name, flags, 0o600, dir_fd=DIRECTORY)
        with os.fdopen(descriptor, "wb") as output:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        return

    temporary = f".{name}.{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=DIRECTORY,
        )
        with os.fdopen(descriptor, "wb") as output:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        os.replace(temporary, name, src_dir_fd=DIRECTORY, dst_dir_fd=DIRECTORY)
    finally:
        try:
            os.unlink(temporary, dir_fd=DIRECTORY)
        except FileNotFoundError:
            pass


def promote(source_name, destination_name, device, inode):
    child_name(source_name)
    child_name(destination_name)
    require_directory(DIRECTORY)
    require_directory(DESTINATION_DIRECTORY)
    descriptor = os.open(source_name, FILE_FLAGS, dir_fd=DIRECTORY)
    try:
        source = os.fstat(descriptor)
        if not stat.S_ISREG(source.st_mode) or source.st_nlink != 1:
            raise ValueError("owned promotion source is not a regular unshared file")
        require_identity(source, device, inode, "owned promotion source")
        try:
            os.stat(destination_name, dir_fd=DESTINATION_DIRECTORY, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("owned promotion destination already exists")
        os.link(
            source_name,
            destination_name,
            src_dir_fd=DIRECTORY,
            dst_dir_fd=DESTINATION_DIRECTORY,
            follow_symlinks=False,
        )
        destination = os.stat(
            destination_name, dir_fd=DESTINATION_DIRECTORY, follow_symlinks=False
        )
        require_identity(destination, device, inode, "owned promotion destination")
        current = os.stat(source_name, dir_fd=DIRECTORY, follow_symlinks=False)
        require_identity(current, device, inode, "owned promotion source")
        os.unlink(source_name, dir_fd=DIRECTORY)
    finally:
        os.close(descriptor)


def move_directory(source_name, destination_name, device, inode):
    child_name(source_name)
    child_name(destination_name)
    require_directory(DIRECTORY)
    require_directory(DESTINATION_DIRECTORY)
    descriptor = os.open(source_name, DIRECTORY_FLAGS, dir_fd=DIRECTORY)
    try:
        source = os.fstat(descriptor)
        if not stat.S_ISDIR(source.st_mode):
            raise ValueError("owned move source is not a directory")
        require_identity(source, device, inode, "owned move source")
        try:
            os.stat(destination_name, dir_fd=DESTINATION_DIRECTORY, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("owned move destination already exists")
        os.rename(
            source_name,
            destination_name,
            src_dir_fd=DIRECTORY,
            dst_dir_fd=DESTINATION_DIRECTORY,
        )
        destination = os.stat(
            destination_name, dir_fd=DESTINATION_DIRECTORY, follow_symlinks=False
        )
        require_identity(destination, device, inode, "owned move destination")
    finally:
        os.close(descriptor)


def remove_file(name, device, inode):
    child_name(name)
    require_directory(DIRECTORY)
    descriptor = os.open(name, FILE_FLAGS, dir_fd=DIRECTORY)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("owned remove target is not a regular unshared file")
        require_identity(metadata, device, inode, "owned remove target")
        current = os.stat(name, dir_fd=DIRECTORY, follow_symlinks=False)
        require_identity(current, device, inode, "owned remove target")
        os.unlink(name, dir_fd=DIRECTORY)
    finally:
        os.close(descriptor)


def remove_directory(name, device, inode):
    child_name(name)
    require_directory(DIRECTORY)
    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=DIRECTORY)
    try:
        metadata = os.fstat(descriptor)
        require_identity(metadata, device, inode, "owned remove directory")
        current = os.stat(name, dir_fd=DIRECTORY, follow_symlinks=False)
        require_identity(current, device, inode, "owned remove directory")
        os.rmdir(name, dir_fd=DIRECTORY)
    finally:
        os.close(descriptor)


def main():
    arguments = sys.argv[1:]
    if len(arguments) == 1:
        write_bytes(arguments[0], replace=False)
        return
    operation, *values = arguments
    if operation == "replace" and len(values) == 1:
        write_bytes(values[0], replace=True)
    elif operation == "promote" and len(values) == 4:
        promote(*values)
    elif operation == "move-directory" and len(values) == 4:
        move_directory(*values)
    elif operation == "remove-file" and len(values) == 3:
        remove_file(*values)
    elif operation == "remove-directory" and len(values) == 3:
        remove_directory(*values)
    else:
        raise ValueError("invalid owned storage operation")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
