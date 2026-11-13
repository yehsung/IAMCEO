import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Connection failures describe recovery without guessing whether the Mac is asleep.
enum ConnectionRecovery {
    static let checklist = String(localized: "같은 Wi-Fi에 연결되어 있거나 두 기기의 Tailscale이 켜져 있는지, Mac의 IAMCEO가 켜져 있는지, 서버 주소가 맞는지 확인해 주세요.")

    /// 401 을 뜻하는 서버 코드. 영어 화면에서는 그 문장이 영어로 오므로(ServerErrorDisplay) 코드의 두 문장으로 알아본다.
    static let unauthorizedCodes = ["unauthorized", "device_revoked", "auth_changed", "agent_token_invalid"]

    static func reason(_ raw: String) -> String {
        let text = raw.lowercased()
        if text.contains("401") || text.contains("인증이 필요") || text.contains("unauthorized")
            || unauthorizedCodes.contains(where: { ServerErrorText.matches(raw, code: $0) }) {
            return String(localized: "접속 코드가 맞지 않거나 바뀌었습니다. Mac에서 새 QR을 만들어 다시 연결해 주세요.")
        }
        if text.contains("timed out") || text.contains("시간이 초과") || text.contains("timeout") {
            return String(localized: "Mac의 응답을 기다리다 시간이 지났습니다.")
        }
        return friendlyLoadError(APIError(status: 0, message: raw), what: "Mac 연결", verb: "확인하지")
    }

    static func showsSavedConnection(endpoint: String, accessCode: String, useQR: Bool) -> Bool {
        !useQR && !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// A consumed/expired QR alone is not evidence of a connected phone.
struct PairingCompletion: Decodable, Sendable {
    let code: String
    let status: String
    func confirms(_ expectedCode: String) -> Bool { code == expectedCode && status == "connected" }
}

/// The link inside the Mac's QR code: `iamceo://pair?c=<one-time code>&u=<tailnet url>&u=…`.
/// It never carries the access code; the phone trades the one-time code for it over Tailscale.
struct PairingLink: Sendable, Equatable {
    static let scheme = "iamceo"
    let code: String
    let urls: [URL]

    init(code: String, urls: [URL]) {
        self.code = code
        self.urls = urls
    }

    init?(url: URL) {
        guard Self.isPairingURL(url),
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let code = items.first { $0.name == "c" }?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Only plain origins on a Tailscale address (or loopback for the simulator / same Mac) are accepted. Any other
        // address in a link is dropped, HTTPS included: a link must not be able to point the app at an outside server.
        // (Typing an address by hand on the connection screen is a separate path and still takes any HTTPS host.)
        let urls = items.filter { $0.name == "u" }.compactMap { $0.value }.compactMap { (try? ServerEndpoint($0))?.url }
            .filter { Self.acceptsHost($0.host ?? "") }
        guard !code.isEmpty, !urls.isEmpty else { return nil }
        self.code = code
        self.urls = urls
    }

    /// An `iamceo://pair` link at all, whether or not its addresses are acceptable (to say why it was not opened).
    static func isPairingURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == "pair"
    }

    /// Tailscale addresses (100.64.0.0/10, the tailnet's IPv6 range, *.ts.net device names) and this device itself.
    static func acceptsHost(_ raw: String) -> Bool {
        let host = raw.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || Tailnet.isTailnetHost(host)
    }

    static let rejectedMessage = String(localized: "연결 링크를 열지 않았습니다. 주소가 Tailscale 주소가 아니거나 링크가 온전하지 않습니다. Mac의 설정 → iPhone 연결에서 나온 QR을 써 주세요.")

    var url: URL {
        var parts = URLComponents()
        parts.scheme = Self.scheme
        parts.host = "pair"
        parts.queryItems = [URLQueryItem(name: "c", value: code)] + urls.map { URLQueryItem(name: "u", value: $0.absoluteString) }
        return parts.url!
    }
}

/// A pairing link held until the owner confirms where it leads. Built by `AppStore.receivePairingLink`.
struct PairingRequest: Sendable, Equatable, Identifiable {
    /// The Mac's one-time code lives five minutes (server `PAIR_CODE_TTL_MS`). A request older than that cannot
    /// succeed, so it is dropped instead of waiting on screen.
    static let lifetimeSeconds: TimeInterval = 300
    static var lifetime: Duration { .seconds(lifetimeSeconds) }
    static let expiredMessage = String(localized: "연결 QR의 유효 시간이 지났습니다. Mac에서 새 QR을 만들어 다시 찍어 주세요.")

    let id = UUID()
    let link: PairingLink
    let device: String
    /// A Mac is already connected (or saved) and this link leads to a different one.
    let replacesCurrent: Bool
    var receivedAt = Date()

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }

    func isExpired(at now: Date = Date()) -> Bool { now.timeIntervalSince(receivedAt) >= Self.lifetimeSeconds }

    /// The addresses the one-time code would be sent to, as the owner can check them against the Mac's screen.
    var addresses: String {
        var seen: Set<String> = []
        return link.urls.compactMap(\.host).filter { seen.insert($0).inserted }.joined(separator: ", ")
    }
    var title: String { replacesCurrent ? String(localized: "연결할 Mac을 바꿀까요?") : String(localized: "이 Mac에 연결할까요?") }
    var message: String {
        String(localized: "주소: \(addresses)") + (replacesCurrent ? String(localized: "\n지금 연결된 Mac을 끊고 이 서버로 바꿉니다.") : "")
    }
    var confirmTitle: String { replacesCurrent ? String(localized: "이 서버로 바꾸기") : String(localized: "연결") }

    /// True when a server is already in use and the link could lead anywhere else: it is the same Mac only when
    /// every address in the link is one that Mac is known by (the address in use, plus the Tailscale addresses the
    /// Mac itself reported over the signed-in connection). One address outside that set makes it a replacement,
    /// because the one-time code is offered to the link's addresses in order.
    static func replaces(currentEndpoint: String?, serverAddresses: [String] = [], link: PairingLink) -> Bool {
        guard let currentEndpoint, host(currentEndpoint) != nil else { return false }
        let known = knownHosts(endpoint: currentEndpoint, serverAddresses: serverAddresses)
        return !link.urls.allSatisfy { url in host(url.absoluteString).map(known.contains) ?? false }
    }

    /// The hosts one Mac is known by. Of what the server reports, only Tailscale addresses count: every server
    /// also listens on 127.0.0.1, which on another device is not that Mac.
    static func knownHosts(endpoint: String, serverAddresses: [String]) -> Set<String> {
        Set([endpoint].compactMap(host) + serverAddresses.compactMap(host).filter(Tailnet.isTailnetHost))
    }

    private static func host(_ address: String) -> String? {
        guard let host = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines))?.host?
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased(), !host.isEmpty else { return nil }
        return host
    }
}

/// Response of `POST /api/pair/start` (Mac, authenticated).
struct PairStart: Decodable, Sendable {
    let code: String
    let expiresAt: String
    let ttlSeconds: Int
    let urls: [String]
}

private struct PairClaimRequest: Encodable, Sendable { let code: String; let device: String }
private struct PairClaimResponse: Decodable, Sendable { let accessCode: String; let confirmationToken: String? }

enum Tailnet {
    /// Tailscale addresses: IPv4 100.64.0.0/10, IPv6 fd7a:115c:a1e0::/48 and MagicDNS names (<device>.<tailnet>.ts.net).
    /// iOS blocks plain HTTP to raw IPs, so pairing prefers the MagicDNS name (ATS exception for ts.net only).
    static func isTailnetHost(_ raw: String) -> Bool {
        let host = raw.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if host.hasPrefix("fd7a:115c:a1e0:") { return true }
        if host.hasSuffix(".ts.net"), host.split(separator: ".").count >= 4 { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
        return parts[0] == 100 && (64...127).contains(parts[1]) && parts.allSatisfy { (0...255).contains($0) }
    }

    // MARK: C8 — 평문 요청 전 Tailscale 확인

    /// Tailscale 주소(100.64/10, tailnet IPv6, *.ts.net)로 가는 평문(http·ws) 요청인가. 이 요청은 Tailscale(WireGuard)이
    /// 켜져 있어야만 암호화된다. 꺼진 채 보내면 이름을 속이는 Wi-Fi 에서 접속 코드와 대화가 그대로 나갈 수 있다.
    /// https·wss 는 TLS 가 지키고, 같은 기기(127.0.0.1)와 직접 고른 LAN 주소는 여기 해당하지 않는다.
    static func needsTailnet(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "ws" else { return false }
        return isTailnetHost(url.host ?? "")
    }

    #if os(iOS)
    static let offMessage = String(localized: "이 iPhone의 Tailscale이 꺼져 있어 보내지 않았습니다. Tailscale 앱에서 연결을 켜 주세요.")
    #else
    static let offMessage = String(localized: "이 Mac의 Tailscale이 꺼져 있어 보내지 않았습니다. Tailscale을 켜 주세요.")
    #endif
    /// 이 확인이 막은 요청의 표지(URLError 의 userInfo). 앱은 연결이 끊긴 것과 같이 다루고(다시 시도·끊김 표시) 문장만 이것으로 바꾼다.
    static let offErrorKey = "IAMCEOTailnetOff"

    /// '연결 안 됨'으로 다룬다: 처음 연결은 알아서 다시 시도하고, 연결 중이면 끊김 표시를 띄운다. Tailscale 을 켜면 다시 붙는다.
    static func offError() -> URLError {
        URLError(.notConnectedToInternet, userInfo: [NSLocalizedDescriptionKey: offMessage, offErrorKey: true])
    }

    static func isOffError(_ error: Error) -> Bool {
        (error as? URLError)?.userInfo[offErrorKey] as? Bool == true
    }

    /// 평문으로 Tailscale 주소에 보내기 전에 부른다. Tailscale 이 꺼져 있으면 보내지 않고 offError 를 던진다.
    static func checkBeforeSending(_ url: URL, connected: () -> Bool) throws {
        if needsTailnet(url), !connected() { throw offError() }
    }

    /// 인터페이스 이름과 주소 한 쌍(getifaddrs 의 결과). 판정은 이 목록만 보므로 시험이 직접 넣는다.
    struct InterfaceAddress: Equatable, Sendable {
        let name: String
        let address: String
    }

    /// True when this device itself is on the tailnet, i.e. the Tailscale VPN is on and logged in.
    static func isConnected() -> Bool { isConnected(interfaces: interfaceAddresses()) }

    /// Tailscale 은 켜지면 터널 인터페이스(utun*)에 tailnet 전용 IPv6(fd7a:115c:a1e0::/48)를 단다. 그 주소가 utun 에 있을 때만 켜진 것으로 본다.
    /// 100.64.0.0/10 은 통신사 CGNAT(셀룰러 pdp_ip0·Wi-Fi 에 직접 붙기도 한다)와 Cloudflare WARP(100.96/12, utun)도 쓴다.
    /// 그 주소 하나로 켜진 것으로 보면 Tailscale 이 꺼진 채 평문 요청이 그 망으로 나간다. 그래서 100.x 는 같은 utun 에 fd7a 주소가 함께 있을 때만 근거가 된다
    /// (그때는 fd7a 만으로 이미 켜진 것이다).
    static func isConnected(interfaces: [InterfaceAddress]) -> Bool {
        interfaces.contains { $0.name.hasPrefix("utun") && $0.address.lowercased().hasPrefix("fd7a:115c:a1e0:") }
    }

    /// 이 기기의 IPv4·IPv6 주소(인터페이스 이름과 함께). 링크 범위 표시(%en0)는 뗀다.
    static func interfaceAddresses() -> [InterfaceAddress] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var found: [InterfaceAddress] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr else { continue }
            let family = address.pointee.sa_family
            guard family == UInt8(AF_INET) || family == UInt8(AF_INET6) else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let length = socklen_t(family == UInt8(AF_INET) ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size)
            guard getnameinfo(address, length, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let text = String(cString: buffer).split(separator: "%").first.map(String.init) ?? ""
            found.append(InterfaceAddress(name: String(cString: entry.pointee.ifa_name), address: text))
        }
        return found
    }
}

enum PairingClient {
    /// 서버 루프가 십수 초 막혀도 기다린다. 먼저 포기하면 서버가 뒤늦게 코드를 소비해 QR을 다시 만들어야 한다. 코드 수명(5분) 안이다.
    static let claimTimeout: TimeInterval = 30
    /// C8: TLS 가 맺어지기 전에 끝난 실패. https 요청은 아직 서버에 닿지 않았으므로 코드가 쓰이지 않았고, 다음 주소를 시도해도 된다.
    static let tlsFailures: Set<URLError.Code> = [.secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired]
    #if os(iOS)
    static let tailnetOffMessage = String(localized: "이 iPhone의 Tailscale이 꺼져 있어 연결하지 않았습니다. Tailscale 앱에서 연결을 켠 뒤 QR을 다시 찍어 주세요.")
    #else
    static let tailnetOffMessage = String(localized: "이 Mac의 Tailscale이 꺼져 있어 연결하지 않았습니다. Tailscale을 켠 뒤 연결 링크를 다시 열어 주세요.")
    #endif

    /// Trades the one-time code for the access code, trying each address in the QR. Returns the origin that answered.
    /// C8: Tailscale 주소로 가는 평문 주소는 이 기기의 Tailscale 이 켜져 있을 때만 시도한다(https 주소는 그대로 시도한다).
    static func claim(_ link: PairingLink, device: String, session: URLSession? = nil,
                      tailnetConnected: @Sendable () -> Bool = { Tailnet.isConnected() }) async throws -> (endpoint: String, accessCode: String, confirmationToken: String?) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = claimTimeout
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let ownedSession = session == nil
        let session = session ?? URLSession(configuration: config, delegate: PairingRedirectDelegate(), delegateQueue: nil)
        defer { if ownedSession { session.invalidateAndCancel() } }
        var lastError: Error = APIError(status: 0, message: String(localized: "짝 맺기 응답을 확인하지 못했습니다. Mac과 이 기기의 Tailscale 연결을 확인한 뒤 Mac에서 새 QR을 만들어 주세요."))
        var skippedPlain = false
        for base in link.urls {
            // 보내지 않았으므로 코드는 그대로다. 다음 주소(https)가 있으면 그것을 시도한다.
            if Tailnet.needsTailnet(base), !tailnetConnected() { skippedPlain = true; continue }
            var request = URLRequest(url: base.appendingPathComponent("pair/claim"))
            request.httpMethod = "POST"
            request.timeoutInterval = claimTimeout
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(PairClaimRequest(code: link.code, device: device))
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                guard (200..<300).contains(http.statusCode) else {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    // A refused code is final; trying another address would only burn an attempt.
                    throw APIError(status: http.statusCode, message: (object?["error"] as? String ?? String(localized: "짝 맺기를 거절했습니다 (\(http.statusCode)).")) + String(localized: " 응답을 놓쳤다면 Mac에서 새 QR을 만들어 주세요."))
                }
                let result = try JSONDecoder().decode(PairClaimResponse.self, from: data)
                guard !result.accessCode.isEmpty else { throw URLError(.badServerResponse) }
                let origin = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                return (origin, result.accessCode, result.confirmationToken)
            } catch let error as APIError {
                throw error
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // Only a definite pre-connection failure can safely try another origin.
                // A timeout/invalid response may follow consumption of this one-time code.
                if let network = error as? URLError, [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .notConnectedToInternet].contains(network.code) {
                    lastError = APIError(status: 0, message: String(localized: "Mac에 닿지 않습니다. Tailscale 연결을 확인한 뒤 Mac에서 새 QR을 만들어 주세요."))
                    continue
                }
                // C8: HTTPS 주소의 인증서를 맺지 못했다. 요청이 서버에 닿기 전이라 다음 주소를 시도한다.
                if let network = error as? URLError, base.scheme?.lowercased() == "https", tlsFailures.contains(network.code) {
                    lastError = APIError(status: 0, message: String(localized: "Mac의 HTTPS 주소에 안전하게 연결하지 못했습니다. Mac에서 새 QR을 만들어 다시 찍어 주세요."))
                    continue
                }
                throw APIError(status: 0, message: String(localized: "짝 맺기 응답을 확인하지 못했습니다. 코드는 이미 사용됐을 수 있습니다. Mac에서 새 QR을 만들어 다시 찍어 주세요."))
            }
        }
        if skippedPlain { throw APIError(status: 0, message: tailnetOffMessage) }
        throw lastError
    }
}

private final class PairingRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
