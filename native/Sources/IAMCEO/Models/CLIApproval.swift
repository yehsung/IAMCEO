import Foundation

struct CLIApprovalOption: Decodable, Sendable, Identifiable {
    let n: Int
    let label: String
    let reject: Bool
    var id: Int { n }
}

struct CLIApprovalPrompt: Decodable, Sendable {
    let title: String
    let body: String
    let question: String
    let options: [CLIApprovalOption]
    let fingerprint: String
}

struct CLIApprovalResponse: Decodable, Sendable { let approval: CLIApprovalPrompt? }
struct CLIApprovalAnswer: Encodable, Sendable { let fingerprint: String; let option: Int }
