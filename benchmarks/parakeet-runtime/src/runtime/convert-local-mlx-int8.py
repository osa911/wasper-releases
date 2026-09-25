#!/usr/bin/env python3
"""Create the locked Local MLX INT8 derivative from the locked public MLX model."""

import argparse
import json
import shutil
import stat
from pathlib import Path


REQUIRED_INPUTS = ("config.json", "model.safetensors", "vocab.txt")
OUTPUTS = REQUIRED_INPUTS


def regular_file(root, name):
    candidate = root / name
    metadata = candidate.lstat()
    if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{name} must be a regular file")
    return candidate


def empty_directory(directory):
    metadata = directory.lstat()
    if directory.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("output directory must be a real directory")
    if any(directory.iterdir()):
        raise ValueError("output directory must be empty")


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bits", type=int, required=True)
    parser.add_argument("--group-size", type=int, required=True)
    arguments = parser.parse_args()
    if arguments.bits != 8 or arguments.group_size != 64:
        raise ValueError("Local MLX INT8 requires bits=8 and group_size=64")
    return arguments


def main():
    arguments = parse_arguments()
    input_dir = arguments.input_dir.resolve(strict=True)
    output_dir = arguments.output_dir.resolve(strict=True)
    if input_dir == output_dir:
        raise ValueError("input and output directories must differ")
    empty_directory(output_dir)
    config_path, weights_path, vocab_path = (
        regular_file(input_dir, name) for name in REQUIRED_INPUTS
    )
    config = json.loads(config_path.read_text(encoding="utf-8"))

    import mlx.core as mx
    import mlx.nn as nn
    from parakeet_mlx.utils import from_config

    model = from_config(config)
    model.load_weights(str(weights_path))
    mx.eval(model.parameters())
    nn.quantize(model, bits=arguments.bits, group_size=arguments.group_size)
    mx.eval(model.parameters())
    model.save_weights(str(output_dir / "model.safetensors"))

    config["quantization"] = {
        "bits": arguments.bits,
        "group_size": arguments.group_size,
    }
    (output_dir / "config.json").write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copyfile(vocab_path, output_dir / "vocab.txt")

    produced = {entry.name for entry in output_dir.iterdir()}
    if produced != set(OUTPUTS):
        raise ValueError("conversion produced an unexpected artifact set")


if __name__ == "__main__":
    main()
