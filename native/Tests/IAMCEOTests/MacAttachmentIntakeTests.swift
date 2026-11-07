#if os(macOS)
import AppKit
import XCTest
import UniformTypeIdentifiers
@testable import IAMCEO

@MainActor
final class MacAttachmentIntakeTests: XCTestCase {
    func testDropClassificationPrefersLocalFilesAndIgnoresRemoteURLs() throws {
        let local = URL(fileURLWithPath: "/private/tmp/example.png")
        let data = Data([1, 2, 3])
        guard case .file(let result) = MacAttachmentItem.classify(fileURL: local, image: data) else {
            return XCTFail("A preview must not duplicate its file")
        }
        XCTAssertEqual(result, local)
        XCTAssertNil(MacAttachmentItem.classify(fileURL: URL(string: "https://example.com/image.png"), image: nil))
        guard case .image(let result) = MacAttachmentItem.classify(fileURL: nil, image: data) else {
            return XCTFail("Image data should be accepted")
        }
        XCTAssertEqual(result, data)
    }

    func testPasteboardFilesImagesAndTextClassification() throws {
        let file = NSPasteboardItem()
        file.setString(URL(fileURLWithPath: "/private/tmp/a.txt").absoluteString, forType: .fileURL)
        file.setData(Data([0]), forType: .png)
        let image = NSPasteboardItem()
        image.setData(Data([1, 2]), forType: .tiff)
        let remote = NSPasteboardItem()
        remote.setString("https://example.com/a.png", forType: .URL)
        let text = NSPasteboardItem()
        text.setString("일반 글", forType: .string)
        let items = MacAttachmentItem.read(items: [file, image, remote, text])
        XCTAssertEqual(items.count, 2)
        guard items.count == 2, case .file = items[0], case .image = items[1] else { return XCTFail("Wrong representations") }
        XCTAssertTrue(MacAttachmentItem.read(items: [text, remote]).isEmpty, "Plain text keeps native text paste")
    }

    func testPasteAndDropAcceptEachImageFormatAndMultipleFiles() {
        for type in [UTType.png, .jpeg, .tiff, .heic, .heif] {
            let item = NSPasteboardItem()
            item.setData(Data([1]), forType: .init(type.identifier))
            let items = MacAttachmentItem.read(items: [item])
            XCTAssertEqual(items.count, 1, type.identifier)
            guard let first = items.first, case .image = first else { return XCTFail(type.identifier) }
        }
        let files = ["a.txt", "b.png"].map { name in
            let item = NSPasteboardItem()
            item.setString(URL(fileURLWithPath: "/private/tmp/" + name).absoluteString, forType: .fileURL)
            return item
        }
        XCTAssertEqual(MacAttachmentItem.read(items: files).count, 2)
    }

    func testReadOnlyReasonsRejectWithoutCallingUploader() {
        let intake = MacAttachmentIntake()
        var received = 0
        intake.receive = { _ in received += 1; return true }
        let items: [MacAttachmentItem] = [.image(Data([1]))]
        let policies = [
            MacAttachmentPolicy(archived: true, demo: false, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: true, connected: true, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: false, connected: false, writable: true, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: false, missingTarget: false),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: true),
            MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: false, composerCovered: true),
        ]
        for policy in policies {
            XCTAssertNotNil(policy.reason)
            XCTAssertFalse(intake.accept(items, policy: policy))
        }
        XCTAssertEqual(received, 0)
        let writable = MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: true, missingTarget: false)
        XCTAssertFalse(intake.accept([], policy: writable))
        XCTAssertTrue(intake.accept(items, policy: writable))
        XCTAssertEqual(received, 1)
    }

    func testFinderFileIsCopiedAndOriginalSurvivesCleanup() async throws {
        let source = try PhotoAttachmentFile.write(Data("file content".utf8), filename: "참고.txt")
        defer { source.cleanup() }
        let files = try await MacAttachmentItem.file(source.url).prepare(date: Date(), index: 1)
        XCTAssertEqual(files.count, 1)
        let file = try XCTUnwrap(files.first)
        XCTAssertNotEqual(file.url, source.url)
        XCTAssertEqual(file.url.lastPathComponent, "참고.txt")
        XCTAssertEqual(try Data(contentsOf: file.url), Data("file content".utf8))
        file.cleanup()
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.url.path))
    }
}
#endif
