import CoreML
import FluidAudio
import Foundation

let fluidCoreMLBridgeVersion = "3"
let fluidAudioSourceHead = "69e42dae8ed12a08c9bd6741080dae741d309a09"
let fluidAudioSourceVersion = "FluidAudio HEAD \(fluidAudioSourceHead) clean"

struct Request: Decodable {
    let requestId: String
    let type: String
    let audioPath: String?
}

struct Response: Encodable {
    let requestId: String
    var status: String?
    var text: String?
    var runtime: RuntimeIdentity?
    var error: String?
}

struct RuntimeIdentity: Encodable {
    let name = "FluidAudio"
    let bridgeVersion = fluidCoreMLBridgeVersion
    let fluidAudioSourceIdentity = FluidAudioSourceIdentity()
    let computeUnits = [
        "preprocessor": "cpuOnly",
        "encoder": "cpuAndNeuralEngine",
        "decoder": "cpuAndNeuralEngine",
        "joint": "cpuAndNeuralEngine",
    ]
}

struct FluidAudioSourceIdentity: Encodable {
    let head = fluidAudioSourceHead
    let state = "clean"
}

func writeResponse(_ response: Response) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response), let line = String(data: data, encoding: .utf8) else {
        return
    }
    print(line)
    fflush(stdout)
}

@main
struct FluidCoreMLServer {
    static func main() async throws {
        if CommandLine.arguments.dropFirst() == ["--version"] {
            print("fluid-coreml-server \(fluidCoreMLBridgeVersion)")
            return
        }
        if CommandLine.arguments.dropFirst() == ["--fluid-audio-revision"] {
            print(fluidAudioSourceVersion)
            return
        }
        guard let modelIndex = CommandLine.arguments.firstIndex(of: "--model"),
              CommandLine.arguments.indices.contains(modelIndex + 1)
        else {
            throw NSError(domain: "FluidCoreMLServer", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "--model is required"
            ])
        }

        let modelDirectory = URL(fileURLWithPath: CommandLine.arguments[modelIndex + 1])
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        let models = try await AsrModels.load(from: modelDirectory, configuration: configuration, version: .v3)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)

        while let line = readLine() {
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                switch request.type {
                case "health":
                    writeResponse(Response(requestId: request.requestId, status: "ok", runtime: RuntimeIdentity()))
                case "transcribe":
                    guard let audioPath = request.audioPath else {
                        throw NSError(domain: "FluidCoreMLServer", code: 3, userInfo: [
                            NSLocalizedDescriptionKey: "audioPath is required"
                        ])
                    }
                    var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                    let result = try await manager.transcribe(
                        URL(fileURLWithPath: audioPath), decoderState: &decoderState)
                    writeResponse(Response(requestId: request.requestId, text: result.text))
                case "stop":
                    writeResponse(Response(requestId: request.requestId, status: "stopping"))
                    return
                default:
                    throw NSError(domain: "FluidCoreMLServer", code: 4, userInfo: [
                        NSLocalizedDescriptionKey: "unsupported request type: \(request.type)"
                    ])
                }
            } catch {
                let requestId = (try? JSONDecoder().decode(Request.self, from: Data(line.utf8)).requestId) ?? "unknown"
                writeResponse(Response(requestId: requestId, error: error.localizedDescription))
            }
        }
    }
}
