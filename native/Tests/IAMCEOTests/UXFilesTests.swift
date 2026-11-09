import Foundation
import WebKit
import XCTest
@testable import IAMCEO

final class UXFilesTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }

    func testReportFilesPreserveEveryIDAndResolveOldLinksOnlyInCurrentProject() throws {
        let message = try decode(Message.self, #"{"id":"m","fileIds":["a","b","c"]}"#)
        XCTAssertEqual(FileLinks.unique(message.fileIds + ["b", ""]), ["a", "b", "c"])
        let files = [FileDoc(id: "a", projectId: "p"), FileDoc(id: "b", projectId: "p"), FileDoc(id: "c", projectId: "other")]
        let url = try XCTUnwrap(URL(string: "https://fixture.invalid/#/p/p/files/b"))
        XCTAssertEqual(FileLinks.fileID(url, projectID: "p", files: files), "b")
        for address in ["https://fixture.invalid/#/p/other/files/b", "https://fixture.invalid/#/p/p/files/c", "https://fixture.invalid/#/p/p/files/missing", "https://fixture.invalid/#/p/p/files/b/extra"] {
            XCTAssertNil(FileLinks.fileID(try XCTUnwrap(URL(string: address)), projectID: "p", files: files))
        }
        XCTAssertEqual(try decode(Message.self, #"{"id":"old","fileId":"b"}"#).fileIds, ["b"])
    }

    @MainActor func testRelatedConversationPreservesSenderAndExactReportID() {
        let router = Router(destination: .files, usesPhoneNavigation: false)
        router.fileID = "reading"
        FileLinks.openRelated(Message(id: "report", memberId: "conductor", fileIds: ["other", "reading"]), router: router)
        XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "conductor")
        XCTAssertEqual(router.chatMessageID, "report")
        XCTAssertEqual(router.fileID, "reading")
        FileLinks.openRelated(Message(id: "mine", mine: true, targetMemberId: "worker"), router: router)
        XCTAssertEqual(router.chatTarget, "worker")
        XCTAssertEqual(router.chatMessageID, "mine")
    }

    func testArrivalCounterDoesNotTreatInitialSnapshotAsNewOrLoseUnseenOnUpdates() {
        var arrivals = FileListArrivalState()
        arrivals.update([])
        arrivals.update(["reading", "older"])
        XCTAssertTrue(arrivals.unseen.isEmpty)
        arrivals.update(["new", "reading", "older"])
        arrivals.update(["newer", "new", "reading"])
        XCTAssertEqual(arrivals.unseen, ["new", "newer"])
        arrivals.update(["newer", "reading"])
        XCTAssertEqual(arrivals.unseen, ["newer"])
        arrivals.acknowledge()
        XCTAssertTrue(arrivals.unseen.isEmpty)
    }

    @MainActor func testNewFilesDoNotChangePinnedSelectionOrComposerContext() {
        let router = Router(destination: .files, usesPhoneNavigation: false)
        router.fileID = FileLinks.pinnedSelection(current: nil, visibleIDs: ["reading"])
        router.fileID = FileLinks.pinnedSelection(current: router.fileID, visibleIDs: ["new", "reading"])
        var arrivals = FileListArrivalState()
        arrivals.update(["reading"])
        arrivals.update(["new", "reading"])
        XCTAssertEqual(router.fileID, "reading")
        XCTAssertEqual(FileLinks.viewedFileID(router: router), "reading")
        router.go(.chat)
        XCTAssertNil(FileLinks.viewedFileID(router: router))
        let phone = Router(destination: .inbox, usesPhoneNavigation: true)
        phone.openFile("evidence")
        XCTAssertEqual(FileLinks.viewedFileID(router: phone), "evidence")
        phone.phonePaths[.inbox] = []
        XCTAssertNil(FileLinks.viewedFileID(router: phone))
    }

    func testSearchMatchesDetailBodyAsWellAsMetadataAndDoesNotMatchUnrelatedText() {
        let lite = FileDoc(id: "f", title: "매출", who: "직원", summary: "주간 요약")
        XCTAssertFalse(FileLinks.matches(lite, body: nil, query: "본문전용"))
        XCTAssertTrue(FileLinks.matches(lite, body: "CSV 셀에 본문전용 단어", query: "본문전용"))
        for term in ["매출", "직원", "요약", ""] { XCTAssertTrue(FileLinks.matches(lite, body: nil, query: term)) }
        XCTAssertFalse(FileLinks.matches(lite, body: "다른 본문", query: "미존재"))
    }

    func testFinderOnlyAcceptsAbsolutePathsFromLoopbackServers() {
        for host in ["http://127.0.0.1:12345", "http://localhost:12345", "http://[::1]:12345"] {
            XCTAssertEqual(FileHost.localURL("/fixture/report.csv", endpoint: host)?.path, "/fixture/report.csv")
        }
        for host in ["https://remote.invalid", "http://100.64.0.1:12345", "https://localhost.remote.invalid"] {
            XCTAssertNil(FileHost.localURL("/fixture/report.csv", endpoint: host))
        }
        for path in ["~/report.csv", "../report.csv", "//remote/report.csv", "/fixture/\0.csv"] {
            XCTAssertNil(FileHost.localURL(path, endpoint: "http://localhost:12345"))
        }
    }

    func testLocalPreviewKindsDecodeRowsAndUnavailableWorkbookWithoutLosingQuotedCells() throws {
        let csv = try decode(LocalFileInfo.self, #"{"name":"a.csv","path":"/fixture/a.csv","size":20,"modifiedAt":"now","mime":"text/csv","kind":"csv","rows":[["name","note"],["a","line\n\"quoted\", comma"]],"previewAvailable":true}"#)
        XCTAssertEqual(csv.rows?[1][1], "line\n\"quoted\", comma")
        let xlsx = try decode(LocalFileInfo.self, #"{"name":"a.xlsx","path":"/fixture/a.xlsx","size":20,"modifiedAt":"now","mime":"application/octet-stream","kind":"xlsx","previewAvailable":false,"previewNote":"파일을 열어 주세요"}"#)
        XCTAssertEqual(xlsx.previewAvailable, false)
        XCTAssertEqual(xlsx.previewNote, "파일을 열어 주세요")
        XCTAssertNil(xlsx.rows)
        let old = try decode(LocalFileInfo.self, #"{"name":"a.txt","path":"/fixture/a.txt","size":1,"modifiedAt":"now","mime":"text/plain","kind":"text","content":"a"}"#)
        XCTAssertNil(old.previewAvailable)
    }

    func testPDFPreviewUsesAuthenticatedBinaryResponseAndMetadata() async throws {
        let metadata = Data(#"{"name":"a.pdf","path":"/fixture/a.pdf","size":8,"modifiedAt":"now","mime":"application/pdf","kind":"pdf"}"#.utf8).base64EncodedString()
        let bytes = Data("%PDF-1.7".utf8)
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            return IsolatedTestHTTPReply(data: bytes, headers: ["Content-Type": "application/pdf", "X-Local-File-Metadata": metadata])
        }
        let preview: LocalFilePreview = try await network.makeAPIClient().localFile(projectID: "p", path: "a.pdf")
        XCTAssertEqual(preview.pdfData, bytes)
        XCTAssertNil(preview.imageData)
        XCTAssertEqual(preview.info.kind, "pdf")
        await network.close()
    }

    func testHTMLPreviewRequiresServerRenderAndSandboxCSP() async throws {
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            let parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "render" })?.value, "1")
            XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "path" })?.value, "~/한 글/a.html")
            return IsolatedTestHTTPReply(data: Data("<button>동작</button>".utf8), headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'"])
        }
        let html = try await network.makeAPIClient().localFileHTML(projectID: "p", path: "~/한 글/a.html")
        XCTAssertEqual(html, "<button>동작</button>")
        await network.close()
        let unsafe = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data("<script>unsafe</script>".utf8), headers: ["Content-Type": "text/html"]) }
        do { _ = try await unsafe.makeAPIClient().localFileHTML(projectID: "p", path: "a.html"); XCTFail("missing sandbox must fail closed") } catch {}
        await unsafe.close()
    }

    func testPublishDistinguishesNewVersionFromUnchangedContent() async throws {
        for reused in [true, false] {
            let network = try IsolatedTestNetwork { request in
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/projects/p/files/from-path")
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: uxFilesRequestBody(request)) as? [String: String])
                XCTAssertEqual(body["path"], "/fixture/report.md")
                return IsolatedTestHTTPReply(data: Data("{\"id\":\"version\",\"projectId\":\"p\",\"reused\":\(reused)}".utf8))
            }
            let file = try await network.makeAPIClient().publishLocalFile(projectID: "p", path: "/fixture/report.md")
            XCTAssertEqual(file.reused, reused)
            await network.close()
        }
    }

    @MainActor func testColdShareSaveAndReopenReuseAuthenticatedBytesButNeverAnotherAPIActor() async throws {
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            return IsolatedTestHTTPReply(data: Data("original bytes".utf8))
        }
        let attachment = Attachment(id: "cold-file", name: "cold.txt", mime: "text/plain", url: "/api/uploads/cold-file")
        let firstAPI = network.makeAPIClient()
        let cold = try await FileResources.attachment(attachment, api: firstAPI)
        XCTAssertEqual(try Data(contentsOf: cold.url), Data("original bytes".utf8))
        let reopened = try await FileResources.attachment(attachment, api: firstAPI)
        XCTAssertTrue(cold === reopened)
        XCTAssertEqual(network.requests.count, 1)
        _ = try await FileResources.attachment(attachment, api: network.makeAPIClient())
        XCTAssertEqual(network.requests.count, 2)
        await network.close()
    }

    @MainActor func testBoundedCacheEvictsButLivePreviewLeaseKeepsItsFileUntilReleased() throws {
        let network = try IsolatedTestNetwork()
        let api = network.makeAPIClient()
        let cache = FileResourceCache(diskLimit: 6, memoryLimit: 6)
        var first: FileResource? = try FileResource(api: api, data: Data([1, 2, 3, 4]), name: "../safe.txt")
        let firstURL = try XCTUnwrap(first).url
        XCTAssertEqual(firstURL.lastPathComponent, "safe.txt")
        cache.insert(try XCTUnwrap(first), path: "a")
        let second = try FileResource(api: api, data: Data([5, 6, 7, 8]), name: "second")
        cache.insert(second, path: "b")
        XCTAssertNil(cache.resource(api: api, path: "a"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstURL.path))
        XCTAssertLessThanOrEqual(cache.diskBytes, 6)
        XCTAssertLessThanOrEqual(cache.memoryBytes, 6)
        first = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstURL.path))
        let zero = FileResourceCache(diskLimit: -1, memoryLimit: -1)
        zero.insert(second, path: "b")
        XCTAssertNil(zero.resource(api: api, path: "b"))
    }

    @MainActor func testDownloadedResourceMovesLargeFilesWithoutRetainingTheirBytesInMemory() throws {
        let network = try IsolatedTestNetwork()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-t8-download-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let download = folder.appendingPathComponent("download")
        let data = Data(repeating: 7, count: 4 * 1024 * 1024 + 1)
        try data.write(to: download)
        let resource = try FileResource(api: network.makeAPIClient(), downloadedURL: download, name: "movie.mp4")
        XCTAssertNil(resource.memory)
        XCTAssertEqual(resource.size, data.count)
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.path))
        XCTAssertEqual(try resource.read(), data)
        let cache = FileResourceCache()
        cache.insert(resource, path: "movie")
        try FileManager.default.removeItem(at: resource.url)
        XCTAssertNil(cache.resource(api: resource.api!, path: "movie"))
    }

    @MainActor func testEmptyDetailBodyIsStillFetchedAndMemoryCacheIsBoundToAPI() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data(#"{"id":"empty","projectId":"p","body":""}"#.utf8)) }
        let api = network.makeAPIClient()
        let file = try await api.fileBody(id: "empty")
        XCTAssertEqual(file.body, "")
        _ = try await api.fileBody(id: "empty")
        XCTAssertEqual(network.requests.count, 1)
        FileBodyMemory.shared.insert(file, api: api)
        XCTAssertNotNil(FileBodyMemory.shared.get("empty", api: api))
        XCTAssertNil(FileBodyMemory.shared.get("empty", api: network.makeAPIClient()))
        await network.close()
    }

    func testTransferProgressHandlesUnknownLengthsAndClampsOvershoot() {
        XCTAssertNil(FileTransferProgress.fraction(received: 5, expected: -1))
        XCTAssertNil(FileTransferProgress.fraction(received: 0, expected: 0))
        XCTAssertEqual(FileTransferProgress.fraction(received: -1, expected: 10), 0)
        XCTAssertEqual(FileTransferProgress.fraction(received: 5, expected: 10), 0.5)
        XCTAssertEqual(FileTransferProgress.fraction(received: 20, expected: 10), 1)
    }

    @MainActor func testFinderUsesConnectedAPIAndServerPathValidationRatherThanEditableAddress() async throws {
        let remote = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 403, data: Data(#"{"error":"민감한 파일입니다"}"#.utf8)) }
        let api = remote.makeAPIClient()
        let host = await FileHostConnection.current(api)
        XCTAssertNotNil(host?.localURL("/fixture/report.md", current: api))
        XCTAssertNil(host?.localURL("/fixture/report.md", current: remote.makeAPIClient()))
        do { _ = try await host?.validatedURL(path: "/fixture/protected.md", projectID: "p"); XCTFail("server path rejection must be preserved") } catch {}
        XCTAssertEqual(remote.requests.count, 1)
        await remote.close()
    }

    func testDownloadRequestIsOriginCheckedAndKeepsCredentialInHeaderOnly() async throws {
        let network = try IsolatedTestNetwork()
        let api = network.makeAPIClient()
        let request = try await api.attachmentDownloadRequest(Attachment(id: "a", url: "/api/uploads/a"))
        XCTAssertEqual(request.url?.scheme, network.endpoint.url.scheme)
        XCTAssertEqual(request.url?.path, "/api/uploads/a")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
        XCTAssertFalse(request.url!.absoluteString.contains("fixture-only"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        do { _ = try await api.attachmentDownloadRequest(Attachment(id: "bad", url: "https://outside.invalid/file")); XCTFail("must reject cross-origin") } catch {}
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    func testContextFileIDUsesT2ArgumentWithoutChangingRepresentativesText() async throws {
        let network = try IsolatedTestNetwork { request in
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: uxFilesRequestBody(request)) as? [String: Any])
            XCTAssertEqual(body["contextFileId"] as? String, "reading")
            XCTAssertEqual(body["text"] as? String, "  이 자료를 확인해 주세요\n")
            return IsolatedTestHTTPReply(data: Data(#"{"id":"m","contextFileId":"reading"}"#.utf8))
        }
        _ = try await network.makeAPIClient().sendMessage(projectID: "p", request: SendMessageRequest(id: "m", text: "  이 자료를 확인해 주세요\n", targetMemberId: nil, attachmentIds: []), contextFileID: "reading")
        await network.close()
    }
}


private func uxFilesRequestBody(_ request: URLRequest) -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }
    var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
    }
    return data
}

final class UXArtifactRuntimeTests: XCTestCase {
    @MainActor func testInteractivePageIsOpaqueNonPersistentAndCannotReachParentOrNativeHandlers() async throws {
        let compiled = await artifactBlockRule()
        let rule = try XCTUnwrap(compiled)
        let ready = expectation(description: "isolated frame reports its rendered height")
        ready.assertForOverFulfill = false
        let delegate = ArtifactNavigationDelegate()
        delegate.onHeight = { _ in ready.fulfill() }
        let html = #"""
        <button id="button" onclick="document.body.dataset.clicked='yes'">동작</button>
        <script>
        document.body.dataset.ran='yes';
        try { parent.document.cookie; document.body.dataset.parent='open'; }
        catch(e) { document.body.dataset.parent='blocked'; }
        document.body.dataset.bridge=String(!!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.artifactLink));
        document.getElementById('button').click();
        </script>
        """#
        let view = makeArtifactWebView(html: html, title: "격리 시험", rule: rule, delegate: delegate, fitted: false)
        XCTAssertFalse(view.configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        XCTAssertFalse(view.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
        await fulfillment(of: [ready], timeout: 15)
        let frame = try XCTUnwrap(delegate.childFrame)
        let result = try await view.evaluateJavaScript("[document.body.dataset.ran,document.body.dataset.clicked,document.body.dataset.parent,document.body.dataset.bridge,typeof RTCPeerConnection].join('|')", in: frame, contentWorld: .page)
        XCTAssertEqual(result as? String, "yes|yes|blocked|false|undefined")
        view.stopLoading()
        view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
    }
}
