// swift-tools-version: 6.0
import Foundation
import PackageDescription

if ProcessInfo.processInfo.environment["FLUID_AUDIO_PACKAGE_PATH"] != nil {
    fatalError("FLUID_AUDIO_PACKAGE_PATH overrides are not supported")
}

let fluidAudioPath = "/Users/osa911/Library/Developer/Xcode/DerivedData/Fluid-aqilhnudwldgeqahjvopdeclcbti/SourcePackages/checkouts/FluidAudio"
let fluidAudioHead = "edee7154e66d2196be896580c6c26ff81c2c528e"
let fluidAudioDiffSHA256 = "4cc60500448dafbf7b292a5de456381e8a2ee9223c0e8cbc5137e048aa389a19"

func commandOutput(_ executable: String, _ arguments: [String], input: Data? = nil) -> Data {
    let process = Process()
    let standardOutput = Pipe()
    let standardError = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = standardOutput
    process.standardError = standardError
    if let input {
        let standardInput = Pipe()
        process.standardInput = standardInput
        try! process.run()
        standardInput.fileHandleForWriting.write(input)
        try! standardInput.fileHandleForWriting.close()
    } else {
        try! process.run()
    }
    process.waitUntilExit()
    let output = standardOutput.fileHandleForReading.readDataToEndOfFile()
    let error = standardError.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
        let detail = String(data: error, encoding: .utf8) ?? "unknown error"
        fatalError("\(executable) failed: \(detail)")
    }
    return output
}

let observedFluidAudioHead = String(
    data: commandOutput("/usr/bin/git", ["-C", fluidAudioPath, "rev-parse", "HEAD"]),
    encoding: .utf8
)!.trimmingCharacters(in: .whitespacesAndNewlines)
let fluidAudioDiff = commandOutput(
    "/usr/bin/git",
    ["-C", fluidAudioPath, "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
)
let observedFluidAudioDiffSHA256 = String(
    data: commandOutput("/usr/bin/shasum", ["-a", "256"], input: fluidAudioDiff),
    encoding: .utf8
)!.split(separator: " ")[0]

guard observedFluidAudioHead == fluidAudioHead else {
    fatalError("FluidAudio HEAD mismatch: found \(observedFluidAudioHead); expected \(fluidAudioHead)")
}
guard observedFluidAudioDiffSHA256 == fluidAudioDiffSHA256 else {
    fatalError(
        "FluidAudio diff SHA-256 mismatch: found \(observedFluidAudioDiffSHA256); expected \(fluidAudioDiffSHA256)"
    )
}

let package = Package(
    name: "fluid-coreml-server",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: fluidAudioPath)],
    targets: [
        .executableTarget(
            name: "fluid-coreml-server",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
