import Foundation
#if canImport(Darwin)
import Darwin
#endif

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
        guard url.scheme?.lowercased() == Self.scheme, url.host?.lowercased() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let code = items.first { $0.name == "c" }?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Only plain origins on a Tailscale address (or loopback for the simulator / same Mac) are accepted.
        let urls = items.filter { $0.name == "u" }.compactMap { $0.value }.compactMap { (try? ServerEndpoint($0))?.url }
        guard !code.isEmpty, !urls.isEmpty else { return nil }
        self.code = code
        self.urls = urls
    }

    var url: URL {
        var parts = URLComponents()
        parts.scheme = Self.scheme
        parts.host = "pair"
        parts.queryItems = [URLQueryItem(name: "c", value: code)] + urls.map { URLQueryItem(name: "u", value: $0.absoluteString) }
        return parts.url!
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
private struct PairClaimResponse: Decodable, Sendable { let accessCode: String }

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

    /// True when this device itself has a Tailscale address, i.e. the Tailscale VPN is on and logged in.
    static func isConnected() -> Bool {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return false }
        defer { freeifaddrs(head) }
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
            if isTailnetHost(text) { return true }
        }
        return false
    }
}

enum PairingClient {
    /// Trades the one-time code for the access code, trying each address in the QR. Returns the origin that answered.
    static func claim(_ link: PairingLink, device: String, session: URLSession? = nil) async throws -> (endpoint: String, accessCode: String) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.httpShouldSetCookies = false
        let session = session ?? URLSession(configuration: config)
        var lastError: Error = APIError(status: 0, message: "Mac에 닿지 않습니다. Mac과 이 기기 모두 Tailscale이 켜져 있는지 확인하세요.")
        for base in link.urls {
            var request = URLRequest(url: base.appendingPathComponent("pair/claim"))
            request.httpMethod = "POST"
            request.timeoutInterval = 8
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(PairClaimRequest(code: link.code, device: device))
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { continue }
                guard (200..<300).contains(http.statusCode) else {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    // A refused code is final; trying another address would only burn an attempt.
                    throw APIError(status: http.statusCode, message: object?["error"] as? String ?? "짝 맺기를 거절했습니다 (\(http.statusCode)).")
                }
                let result = try JSONDecoder().decode(PairClaimResponse.self, from: data)
                let origin = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                return (origin, result.accessCode)
            } catch let error as APIError {
                throw error
            } catch {
                lastError = APIError(status: 0, message: "Mac에 닿지 않습니다. Mac과 이 기기 모두 Tailscale이 켜져 있는지 확인하세요.")
                continue
            }
        }
        throw lastError
    }
}
