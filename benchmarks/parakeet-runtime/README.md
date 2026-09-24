# Parakeet runtime benchmark

This package measures native Parakeet transcription servers on the same corpus
and scoring rules. The Wasper row measures the native Parakeet server packaged
with Wasper. It does not measure Wasper.app dictation behavior, such as its UI,
recording pipeline, or text insertion.

## Current reproducibility status

This benchmark cannot complete a clean full run at this commit. `Local MLX
INT8` is blocked because its historical conversion recipe and output identity
do not have a verified public record. `Fluid Core ML` is blocked while its
pinned model has conflicting license metadata and its clean public source is
not the historical modified checkout. In addition, two long recordings require
rights-holder-authorized manual input. The runner and doctor fail closed for
these conditions.

No frozen 2026-09 result is published in this commit. See the
[historical evidence status](results/2026-09-m1-pro/README.md) for why this
commit contains no historical numeric projection.

## Requirements

Use macOS on an Apple Silicon Mac. Install Node.js 22 or later, Xcode Command
Line Tools, Git, Python 3, and CMake. Install Wasper 1.8.0 or a later release.
The 1.8.0 release is the exact published baseline; a later release is accepted
but reported as a later-release comparison.

Run these commands from `benchmarks/parakeet-runtime`:

```sh
xcode-select --install
brew install node@22
brew install python@3.12
brew install cmake
npm ci
npm run doctor
```

`npm run doctor` is read-only. It does not install software, create the cache,
download a model, or fetch a corpus. It prints the hardware, macOS version,
Node version, available disk, cache and output locations, Wasper classification,
and a state for every runtime. It exits nonzero when a prerequisite invalidates
a full run; that is expected at this commit because of the locked runtime and
long-source blockers.

The doctor requires at least 24 GiB of free disk. This is a preflight floor,
not a full-run storage estimate. A reliable elapsed-time and total-storage
estimate is not available while the full cohort is blocked.

If doctor reports a missing requirement, use the command it prints. The manual
remediations documented here are `xcode-select --install`, `brew install
node@22`, `brew install python@3.12`, `brew install cmake`, and `npm run clean`.
Install Wasper manually from the linked release below, then run `npm run doctor`
again. Connect the Mac to the internet before acquiring public models or corpus
sources.

## Run the benchmark when prerequisites are available

The eventual full-run command is:

```sh
npm run benchmark -- full --accept-source-terms
```

`--accept-source-terms` acknowledges the terms and licenses recorded in the
corpus manifests before any long-source download. Read those terms first. The
flag does not authorize reuse beyond a source's license, and it does not bypass
the two manual-authorized inputs. Do not substitute recordings, references, or
transcripts for those inputs: a partial long cohort is not a full-run result.

By default, generated artifacts are kept only in the marker-owned cache:

```text
~/Library/Caches/Wasper/benchmarks/parakeet-runtime-v1
```

Run outputs are under its `runs` directory. `--cache-dir` and `--output-dir`
must remain inside that cache. Treat raw local run output as non-public: do not
commit it or publish it.

To remove generated benchmark data, run:

```sh
npm run clean
```

Cleanup removes only the generated `artifacts`, `corpus`, `holders`, and `runs`
directories after validating the cache ownership marker and containment. It
refuses a missing, altered, or unsafe marker and does not delete a repository,
home directory, or arbitrary custom path.

## Interpret the results

RTF is response time divided by audio duration. Lower than 1.0 means a response
faster than real time. WER is word-edit errors divided by reference words; CER
is character-edit errors divided by reference characters. Lower WER and CER are
better. Warm-up requests establish runtime residency and are excluded from
timing.

Each long recording is sent as one complete recording. The benchmark never
chunks or merges long audio. A runtime may have its own documented long-audio
strategy, but the benchmark does not supply one. When long coverage is
incomplete, the result omits long quality and speed metrics rather than ranking
partial coverage against complete coverage.

## Public runtime and model sources

The exact revisions, files, and SHA-256 values are in
[`locks/runtimes.json`](locks/runtimes.json). Read every model card, runtime
source, and package license before downloading or using an artifact.

| Runtime | Public sources | State at this commit |
| --- | --- | --- |
| Wasper Metal INT8 | [Wasper 1.8.0 release](https://github.com/osa911/wasper-releases/releases/download/v1.8.0/Wasper-1.8.0-arm64-mac.zip); [model](https://huggingface.co/osa911/wasper-parakeet-tdt-0.6b-v3-onnx-int8) | Ready |
| MLX Community F32/BF16 | [model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); [parakeet-mlx](https://pypi.org/project/parakeet-mlx/0.5.2/); [MLX](https://pypi.org/project/mlx/0.32.2/) | Ready |
| Local MLX INT8 | [model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); [parakeet-mlx](https://pypi.org/project/parakeet-mlx/0.5.2/); [MLX](https://pypi.org/project/mlx/0.32.2/) | Blocked: no verified public historical conversion/output identity |
| Handy Q8 | [model](https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf); [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) | Ready |
| NVIDIA Q8 | [model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) | Ready |
| Istupakov ONNX INT8 | [model](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx); [onnx-asr](https://pypi.org/project/onnx-asr/0.12.0/); [onnxruntime](https://pypi.org/project/onnxruntime/1.30.0/) | Ready |
| Fluid Core ML | [model](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml); [FluidAudio](https://github.com/FluidInference/FluidAudio) | Blocked: conflicting model-license metadata and no historical clean-source equivalence |

The short corpus contains 243 automatically recoverable entries. Of the 21
long entries, 19 have automatic public sources and two require
rights-holder-authorized manual input. The manifests record source URLs, terms,
licenses, hashes, and acquisition state:

- [`corpus/short-fleurs.json`](corpus/short-fleurs.json)
- [`corpus/long-sources.json`](corpus/long-sources.json)

Use source material only under its applicable terms and license. The benchmark
does not grant rights to audio, reference text, or derived transcripts.
