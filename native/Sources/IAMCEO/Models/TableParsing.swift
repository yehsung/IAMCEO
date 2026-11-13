import Foundation

// 표(CSV·TSV) 해석과 원문 디코딩. 자료 화면(Views/FilesView.swift)의 표·코드 보기가 쓴다. 화면 밖에 두어 시험한다.

/// 원문 앞부분을 글자로 푼다(웹과 같은 순서: UTF-16 BOM → UTF-8 → CP949). 잘린 원문은 끝의 깨진 UTF-8 한 글자를 버린다.
func decodeText(_ data: Data, truncated: Bool) -> String {
    let bytes = Data(data)
    if bytes.starts(with: [0xFF, 0xFE]) { return String(data: bytes.dropFirst(2), encoding: .utf16LittleEndian) ?? "" }
    if bytes.starts(with: [0xFE, 0xFF]) { return String(data: bytes.dropFirst(2), encoding: .utf16BigEndian) ?? "" }
    // A cut head can end inside a UTF-8 sequence; drop up to three trailing bytes before giving up on UTF-8.
    for cut in 0...(truncated ? 3 : 0) where bytes.count >= cut {
        if let text = String(data: bytes.dropLast(cut), encoding: .utf8) { return text }
    }
    let cp949 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.dosKorean.rawValue)))
    return String(data: bytes, encoding: cp949) ?? String(decoding: bytes, as: UTF8.self)
}

/// 표 하나에 그리는 열의 상한(웹과 같다). 넘는 열은 `ParsedTable.hiddenColumns`로 센다.
let tableColumnLimit = 30

struct ParsedTable {
    var header: [String]
    var rows: [[String]]
    var hiddenColumns: Int
    var numeric: [Bool]
}

/// RFC 4180 (quotes, doubled quotes, newlines inside quotes). A cut file drops its unfinished last line.
func parseTable(_ input: String, tab: Bool, truncated: Bool) -> ParsedTable {
    let scalars = Array((input.hasPrefix("\u{FEFF}") ? String(input.dropFirst()) : input).unicodeScalars)
    let delimiter: Unicode.Scalar = tab ? "\t" : sniffDelimiter(scalars)
    var rows: [[String]] = []
    var row: [String] = []
    var cell = String.UnicodeScalarView()
    var quoted = false
    var cells = 0
    var maxCells = 0
    func endCell() {
        if cells < tableColumnLimit { row.append(String(cell)) }
        cells += 1
        cell = String.UnicodeScalarView()
    }
    func endRow() {
        endCell()
        maxCells = max(maxCells, cells)
        cells = 0
        if row.count > 1 || row.first != "" { rows.append(row) }
        row = []
    }
    var index = 0
    while index < scalars.count {
        let c = scalars[index]
        if quoted {
            if c == "\"" {
                if index + 1 < scalars.count, scalars[index + 1] == "\"" { cell.append("\""); index += 2; continue }
                quoted = false
            } else {
                cell.append(c)
            }
            index += 1
            continue
        }
        if c == "\"" && cell.isEmpty { quoted = true }
        else if c == delimiter { endCell() }
        else if c == "\n" || c == "\r" {
            if c == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" { index += 1 }
            endRow()
        } else { cell.append(c) }
        index += 1
    }
    if !truncated && (!cell.isEmpty || !row.isEmpty) { endRow() }
    var header = rows.isEmpty ? [] : rows.removeFirst()
    let width = min(maxCells, tableColumnLimit)
    while header.count < width { header.append("") }
    if header.count > width { header = Array(header.prefix(width)) }
    let numeric = (0..<header.count).map { column in isNumericColumn(rows, column) }
    return ParsedTable(header: header, rows: rows, hiddenColumns: max(0, maxCells - width), numeric: numeric)
}

/// The delimiter seen most often on the first unquoted line (Excel's ; csv included).
func sniffDelimiter(_ scalars: [Unicode.Scalar]) -> Unicode.Scalar {
    var counts: [Unicode.Scalar: Int] = [",": 0, "\t": 0, ";": 0]
    var quoted = false
    for c in scalars.prefix(8192) {
        if c == "\"" { quoted.toggle() }
        else if !quoted && (c == "\n" || c == "\r") { break }
        else if !quoted, counts[c] != nil { counts[c, default: 0] += 1 }
    }
    let candidates: [Unicode.Scalar] = [",", "\t", ";"]
    let best = candidates.max { (counts[$0] ?? 0) < (counts[$1] ?? 0) } ?? ","
    return (counts[best] ?? 0) > 0 ? best : ","
}

/// 표 정렬: 빈 칸은 항상 뒤, 같은 값은 원래 순서. 비교 키(다듬은 글자, 숫자)는 행마다 한 번만 만든다
/// (비교할 때마다 만들면 수천 행 숫자 열 정렬이 몇 초씩 메인 스레드를 막는다).
func sortedTableRows(_ rows: [[String]], column: Int, numeric: Bool, ascending: Bool) -> [[String]] {
    struct Key { let offset: Int; let text: String; let number: Double? }
    let keys = rows.enumerated().map { offset, row in
        let text = column < row.count ? row[column].trimmingCharacters(in: .whitespaces) : ""
        return Key(offset: offset, text: text, number: numeric && !text.isEmpty ? cellNumber(text) : nil)
    }
    return keys.sorted { a, b in
        let x = a.text, y = b.text
        if x.isEmpty || y.isEmpty { return x.isEmpty == y.isEmpty ? a.offset < b.offset : !x.isEmpty }
        let order: ComparisonResult
        if numeric, let nx = a.number, let ny = b.number {
            order = nx == ny ? .orderedSame : nx < ny ? .orderedAscending : .orderedDescending
        } else {
            order = x.localizedStandardCompare(y)
        }
        if order == .orderedSame { return a.offset < b.offset }
        return ascending ? order == .orderedAscending : order == .orderedDescending
    }
    .map { rows[$0.offset] }
}

/// 1,234 · -3.5 · 12% count as numbers; long numbers starting with 0 (phone numbers) do not.
/// 문법은 `[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?` 이고 숫자가 하나는 있어야 한다. 정규식 리터럴은 부를 때마다
/// 다시 컴파일되어 칸 하나에 수십 µs가 들므로(수천 행 표에서 몇 초) 손으로 읽는다.
func cellNumber(_ cell: String) -> Double? {
    let s = cell.trimmingCharacters(in: .whitespaces)
    var digits = [UInt8]()
    digits.reserveCapacity(s.utf8.count)
    var bytes = s.utf8.makeIterator()
    var next = bytes.next()
    func isDigit(_ byte: UInt8?) -> Bool { byte.map { $0 >= 48 && $0 <= 57 } ?? false }
    if next == 45 || next == 43 { digits.append(next!); next = bytes.next() }
    let signLength = digits.count
    var lead = 0
    while isDigit(next) { digits.append(next!); lead += 1; next = bytes.next() }
    if next == 44 {
        // 천 단위 쉼표: 앞 묶음은 1~3자리, 뒤 묶음은 모두 정확히 3자리.
        guard (1...3).contains(lead) else { return nil }
        while next == 44 {
            next = bytes.next()
            var group = 0
            while isDigit(next) { digits.append(next!); group += 1; next = bytes.next() }
            guard group == 3 else { return nil }
        }
    }
    let wholeLength = digits.count - signLength
    if next == 46 {
        digits.append(46); next = bytes.next()
        var fraction = 0
        while isDigit(next) { digits.append(next!); fraction += 1; next = bytes.next() }
        guard fraction > 0 else { return nil }
    }
    if next == 37 { next = bytes.next() }
    guard next == nil, digits.count - signLength > 0 else { return nil }
    // 0으로 시작하는 긴 숫자(전화번호, 우편번호)는 글자다.
    if wholeLength >= 2, digits[signLength] == 48, s.utf8.dropFirst(signLength).dropFirst().first.map({ $0 >= 48 && $0 <= 57 }) == true { return nil }
    return Double(String(decoding: digits, as: UTF8.self))
}

func isNumericColumn(_ rows: [[String]], _ column: Int) -> Bool {
    var seen = false
    for row in rows {
        let value = column < row.count ? row[column] : ""
        if value.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        if cellNumber(value) == nil { return false }
        seen = true
    }
    return seen
}
