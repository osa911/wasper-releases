// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "fluid-coreml-server",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git",
                 revision: "69e42dae8ed12a08c9bd6741080dae741d309a09")
    ],
    targets: [
        .executableTarget(
            name: "fluid-coreml-server",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
