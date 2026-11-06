import Foundation
import Observation

/// Unsent text that must survive navigation:
/// - instruction drafts per project + target (shared by every composer), so a draft never moves to another recipient;
/// - decision memos per decision, so switching cards or refreshing never loses a half-written answer.
@MainActor @Observable
final class DraftStore {
    private(set) var texts: [String: String]
    private(set) var attachments: [String: [Attachment]] = [:]
    private(set) var memos: [String: String]
    @ObservationIgnored private let persist: Bool

    init(persist: Bool = true) {
        self.persist = persist
        texts = persist ? (UserDefaults.standard.dictionary(forKey: "iamceo.chatDrafts") as? [String: String] ?? [:]) : [:]
        memos = persist ? (UserDefaults.standard.dictionary(forKey: "iamceo.decisionMemos") as? [String: String] ?? [:]) : [:]
    }

    static func key(project: String?, target: String?) -> String { "\(project ?? "none"):\(target ?? "chief")" }

    func text(for key: String) -> String { texts[key] ?? "" }
    func setText(_ value: String, for key: String) {
        texts[key] = value
        save()
    }
    func files(for key: String) -> [Attachment] { attachments[key] ?? [] }
    func addFile(_ file: Attachment, for key: String) { attachments[key, default: []].append(file) }
    func removeFile(_ id: String, for key: String) { attachments[key]?.removeAll { $0.id == id } }
    func clear(_ key: String) {
        texts[key] = ""
        attachments[key] = []
        save()
    }
    /// After a send was accepted, remove only what was sent: text typed or files attached while the request was in
    /// flight stay in the draft. If the sent text was edited meanwhile, the draft is left as it is.
    func consumeSent(text sent: String, attachmentIDs: [String], for key: String) {
        let current = texts[key] ?? ""
        if current == sent {
            texts[key] = ""
        } else if !sent.isEmpty, current.hasPrefix(sent) {
            texts[key] = String(current.dropFirst(sent.count).drop(while: \.isWhitespace))
        }
        let sentIDs = Set(attachmentIDs)
        attachments[key]?.removeAll { sentIDs.contains($0.id) }
        save()
    }
    /// Number of unsent drafts and memos, shown before signing out.
    var pendingCount: Int { texts.values.filter { !$0.isEmpty }.count + memos.values.filter { !$0.isEmpty }.count }

    /// nil = never edited on this device (use the server's lastNote); "" = deliberately cleared.
    func memo(for decisionID: String) -> String? { memos[decisionID] }
    func setMemo(_ value: String, for decisionID: String) {
        memos[decisionID] = value
        save()
    }
    func clearMemo(_ decisionID: String) {
        memos.removeValue(forKey: decisionID)
        save()
    }
    func removeAll() {
        texts = [:]; attachments = [:]; memos = [:]
        save()
    }

    private func save() {
        guard persist else { return }
        UserDefaults.standard.set(texts.filter { !$0.value.isEmpty }, forKey: "iamceo.chatDrafts")
        UserDefaults.standard.set(memos, forKey: "iamceo.decisionMemos")
    }
}
