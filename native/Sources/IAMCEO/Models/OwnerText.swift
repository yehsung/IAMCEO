import Foundation

/// 0.2.7 (D5-10): 대표가 쓴 글(대화·결재 메모·할 일 답)에 섞여 들어간 C0·C1 제어문자(백스페이스 0x08 등)를 보내기 전에 지운다.
/// 서버도 같은 규칙으로 지운다(server/text.ts stripControls). 탭·줄바꿈은 남기고 CR·CRLF 는 줄바꿈으로 맞춘다.
/// 이모지의 결합 문자(ZWJ) 같은 보이지 않는 글자는 건드리지 않는다: 대표가 쓴 글 그대로여야 한다.
enum OwnerText {
    static func clean(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var afterCR = false
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if value == 0x0D { out.append("\n"); afterCR = true; continue }
            if value == 0x0A && afterCR { afterCR = false; continue }
            afterCR = false
            let control = value <= 0x08 || value == 0x0B || value == 0x0C || (0x0E...0x1F).contains(value) || (0x7F...0x9F).contains(value)
            if !control { out.append(scalar) }
        }
        return String(out)
    }
}
