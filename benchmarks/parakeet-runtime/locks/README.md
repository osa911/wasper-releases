# Runtime lock contract

`runtimes.json` is the authority for the seven runtime IDs, their order, model
files, source revisions, launch arguments, language policy, and long-audio
policy. Alternate lock files must match this document exactly. No CLI option
can replace its authority.

Each downloadable model file has one public HTTPS URL, its byte size, and its
SHA-256. Git sources use full commit IDs. The Wasper release record identifies
both the public ZIP and its packaged native-server member. Python bridges and
the Swift bridge inputs also have SHA-256 locks.

## Acquisition interface

```js
const { resolveLayout } = require('../src/config.cjs');
const { loadRuntimeLock } = require('../src/runtime/locks.cjs');
const { bootstrapRuntime } = require('../src/runtime/bootstrap.cjs');

const layout = resolveLayout();
const lock = loadRuntimeLock();
await bootstrapRuntime('handy-gguf-q8', { layout, lock, python: 'python3' });
```

The optional `python` argument selects an existing Python 3 executable.
Every bootstrap download requires its descriptor-relative file operations.
The stdlib-only download and exclusive-write helpers inherit a verified
owned-directory descriptor. Parent-path replacement cannot redirect model or
dependency downloads, staged bridge files, or bootstrap receipts.
Bootstrap also checks each required Python package version. It does not install
Python packages, developer tools, Homebrew, or any system package. MLX requires
`parakeet-mlx==0.5.2` and `mlx==0.32.2`. ONNX requires `onnx-asr==0.12.0`
and `onnxruntime==1.30.0`. Handy uses the selected Python and the binding in its
pinned source checkout. Native builds require CMake and the Xcode Command
Line Tools. Fluid's build recipe requires Swift 6 and macOS 14 or later.

All holder clones and build products live under `layout.holdersRoot`.
Tool caches live under its `.tool-cache` child. Model files live under
`layout.artifactsRoot/<runtimeId>`. Bootstrap requires an owned cache and
refuses an unmarked nonempty root. It does not download or install Wasper.app.
The released app must already be installed for activation.

Bootstrap fetches every locked model, runtime archive, and Swift binary dependency
into `artifacts/<runtimeId>` and checks its SHA-256 before any build. These
archives are also rehashed on reuse and activation. A verified runtime archive is
extracted only into its locked holder build directory; Swift Package Manager still
enforces the checksum in the pinned source manifest for each Swift archive it
consumes. Archive transfers without a locked size have a 1 GiB limit.

`verifyRuntimeInstallation(runtimeId, { layout, lock, python })` verifies an
existing installation without downloading or building. Adapter creation and
activation call this gate before version probes or runtime requests. Checks
include model hashes, unexpected model files, clean source revisions, bridge
hashes, and the build inventory. Locally built executables and companion
libraries are hashed into a local receipt and checked on reuse. These hashes
describe the local build, not a historical binary.

The public adapter rejects `audioChunks`, including an empty chunk list, for
both warmup and transcription. Each accepted request sends one complete
`audioPath` to the runtime. Runtime-internal window settings remain in the
lock and do not enable benchmark-owned splitting or transcript merging.

Changed or partial caches fail closed. Bootstrap does not overwrite a
different checkout or accept a newly computed model hash. A failed attempt
can retain partial files for inspection. The existing marker-aware clean
command can remove the owned generated roots before a fresh attempt.

The optional third argument to bootstrap and verification supplies trusted
test fixtures for the authority, HTTP transport, Git transport, bridge source,
and tool executables. Production callers use the two-argument interface.
Tests exercise real local HTTP, Git, CMake, and Swift operations without
downloading models.

The public CLI orchestrates acquisition and result projection. A complete
full run still requires the two manually authorized long recordings.

## Reproduction limitations

Local MLX INT8 is generated from the pinned MLX Community model with the
checked-in converter. Its generated output hashes are verified before use.

Fluid Core ML uses the pinned public FluidAudio source and model. At the pinned
model revision, the model card frontmatter declares `cc-by-4.0`, while the
License section says `Apache 2.0`.
Both statements remain recorded in the lock. The bridge uses a clean public
FluidAudio commit and a matching `Package.resolved`. This differs from the
modified checkout used in historical measurements.
[Pinned Fluid model card](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml/blob/7dd20fe6b1797d35f5e3307e8b1732d9a178edfe/README.md).

The remaining entries pin publicly retrievable inputs and the published
runtime package versions. Native compiler versions and Python transitive
dependencies are prerequisites, not a recovered historical environment.
No byte-for-byte historical native build or seven-runtime historical rerun
is claimed. The exact Wasper label refers specifically to its 1.8.0 release
and verified native-server hash. Later app releases retain the newer-release
classification.

## Public provenance

- [Wasper 1.8.0 release](https://github.com/osa911/wasper-releases/releases/tag/v1.8.0).
- [Wasper public v6 model](https://huggingface.co/osa911/wasper-parakeet-tdt-0.6b-v3-onnx-int8/tree/6f123e3b29b0fcd3edc305f4700b5cf28a735b96).
- [MLX model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3/tree/ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15).
- [Handy model](https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/tree/90f082450fcbacdb54e5900c44ef697c9ea59622) and [source](https://github.com/handy-computer/transcribe.cpp/tree/63a44d9239d610b3908e8a66b384924cd4a77217).
- [NVIDIA model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/541d1f99c6b0c3cd0b11a95167540bb8edefd82b) and [v0.1.0 macOS Metal runtime archive](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz).
- [Istupakov model](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/tree/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce).
- [Clean FluidAudio source](https://github.com/FluidInference/FluidAudio/tree/69e42dae8ed12a08c9bd6741080dae741d309a09).
