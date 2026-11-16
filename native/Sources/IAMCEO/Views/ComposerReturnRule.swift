import Foundation

/// 0.2.7(D5-10): Mac 입력칸의 Return 은 보내기다(줄바꿈은 ⇧↩·⌥↩). 대표가 번호 목록을 '1. …'까지 쓰고 다음 줄로 가려고 Return 을
/// 눌러 덜 쓴 글이 나간 일이 있다(11-13). 대표 글 437건 가운데 번호 목록 첫 항목에서 끝난 글은 그 한 건뿐이라,
/// 캐럿이 '1. 무엇' 줄의 끝에 있을 때만 Return 이 줄을 바꾸고 '2. '를 이어 쓴다. 다른 때(2번째 항목부터 포함)는 지금처럼 보낸다.
/// ⌘↩ 는 언제나 보낸다.
enum ComposerReturnRule {
    /// 넣을 글(줄바꿈과 다음 번호)을 돌려준다. nil 이면 평소대로(보내기).
    /// caret 은 NSString(UTF-16) 위치다. 고른 글이 있으면 쓰지 않는다(부르는 쪽이 nil 을 넘긴다).
    static func listContinuation(text: String, caret: Int) -> String? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        // 캐럿이 줄 끝이어야 한다(줄 가운데서 누른 Return 은 보내기 그대로).
        if caret < ns.length {
            let next = ns.character(at: caret)
            guard next == 0x0A || next == 0x0D else { return nil }
        }
        let previousBreak = ns.rangeOfCharacter(from: .newlines, options: .backwards, range: NSRange(location: 0, length: caret))
        let lineStart = previousBreak.location == NSNotFound ? 0 : previousBreak.location + 1
        let line = ns.substring(with: NSRange(location: lineStart, length: caret - lineStart))
        guard let match = firstItem.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) else { return nil }
        let indent = (line as NSString).substring(with: match.range(at: 1))
        let mark = (line as NSString).substring(with: match.range(at: 2))
        return "\n\(indent)2\(mark) "
    }

    /// 줄 머리의 '1.' 또는 '1)' 뒤에 빈칸과 글이 있다(빈 항목은 아니다).
    private static let firstItem = try! NSRegularExpression(pattern: #"^([ \t]*)1([.)])[ \t]+\S"#)
}
