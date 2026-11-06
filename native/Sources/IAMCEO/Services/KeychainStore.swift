import Foundation
import Security

enum KeychainStore {
    static func accessCode(for endpoint: String) -> String? {
        var query = base(endpoint)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ code: String, for endpoint: String) throws {
        let query = base(endpoint)
        SecItemDelete(query as CFDictionary)
        var value = query
        value[kSecValueData as String] = Data(code.utf8)
        value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(value as CFDictionary, nil)
        guard status == errSecSuccess else { throw APIError(status: 0, message: "접속 코드를 키체인에 저장하지 못했습니다 (\(status)).") }
    }
    static func remove(for endpoint: String) { SecItemDelete(base(endpoint) as CFDictionary) }
    private static func base(_ endpoint: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.iamceo.native.access-code", kSecAttrAccount as String: endpoint]
    }
}
