import SwiftUI

// Pixel-art primitives for the office scene. Everything here works in sprite pixels (1 sprite pixel = `pixel` points,
// a whole number of device pixels), so a scene drawn with integer coordinates lands on the device pixel grid.

/// One colour of the office art: sRGB hex plus alpha.
struct OfficeInk: Hashable, Sendable {
    let rgb: UInt32
    let alpha: UInt8

    init(_ rgb: UInt32, alpha: Double = 1) {
        self.rgb = rgb
        self.alpha = UInt8(max(0, min(255, (alpha * 255).rounded())))
    }

    var color: Color { Color(hex: rgb).opacity(Double(alpha) / 255) }
    var isOpaque: Bool { alpha == 255 }
}

/// Colours the scene uses outside the art pieces: state lights, glows, screens, bubbles and shadows.
enum OfficePalette {
    static let line = OfficeInk(0x1A1433)
    static let shadow = OfficeInk(0x05030D, alpha: 0.28)
    /// The shadow colour drawn opaque into one layer that is then faded as a whole (overlaps never darken twice).
    static let shadowSolid = OfficeInk(0x05030D)
    static let bubble = OfficeInk(0xF7F4FF)
    static let bubbleShade = OfficeInk(0xD9D2F2)
    static let screenOn = OfficeInk(0x2A1F66)
    static let code: [OfficeInk] = [OfficeInk(0xC9BCFF), OfficeInk(0xB4F0FF), OfficeInk(0x9DEBD2)]
    static let zed = OfficeInk(0xD3C9FF)
    static let glowWork: UInt32 = 0xB9A8FF
    static let glowError: UInt32 = 0xFF5A62

    /// The 2px state light on a laptop lid or a monitor back.
    static func led(_ screen: OfficeScreen) -> UInt32 {
        switch screen {
        case .off: 0x4A3F82
        case .working: 0xB9A8FF
        case .waiting: 0xFFB070
        case .blocked: 0xFF8A80
        case .error: 0xFF5A62
        }
    }
}

/// Pixel art ready to draw: one merged path per opaque ink, then translucent overlays in order. `opacity` fades the
/// whole piece (a desk whose owner is away), so overlapping fills never double up.
struct PixelArt {
    struct Fill {
        let color: Color
        let path: Path
    }
    var fills: [Fill] = []
    var opacity: Double = 1

    func draw(_ ctx: inout GraphicsContext) {
        guard !fills.isEmpty else { return }
        if opacity < 1 {
            ctx.drawLayer { layer in
                layer.opacity = opacity
                for fill in fills { layer.fill(fill.path, with: .color(fill.color)) }
            }
        } else {
            for fill in fills { ctx.fill(fill.path, with: .color(fill.color)) }
        }
    }
}

/// A paint-over grid in sprite pixels (later writes win), turned into one path per ink made of horizontal runs.
/// Translucent inks never replace pixels; they are kept as overlays drawn after the opaque art.
struct PixelCanvas {
    let originX: Int
    let originY: Int
    let width: Int
    let height: Int
    private var cells: [UInt16]
    private var inks: [OfficeInk] = []
    private var lookup: [OfficeInk: UInt16] = [:]
    private var overlays: [(OfficeInk, CGRect)] = []

    init(x: Int, y: Int, width: Int, height: Int) {
        originX = x
        originY = y
        self.width = max(0, width)
        self.height = max(0, height)
        cells = Array(repeating: 0, count: self.width * self.height)
    }

    private mutating func index(of ink: OfficeInk) -> UInt16 {
        if let found = lookup[ink] { return found }
        inks.append(ink)
        let value = UInt16(inks.count)
        lookup[ink] = value
        return value
    }

    mutating func fill(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ ink: OfficeInk) {
        guard w > 0, h > 0 else { return }
        if !ink.isOpaque {
            overlays.append((ink, CGRect(x: x, y: y, width: w, height: h)))
            return
        }
        let x0 = max(x - originX, 0), x1 = min(x - originX + w, width)
        let y0 = max(y - originY, 0), y1 = min(y - originY + h, height)
        guard x0 < x1, y0 < y1 else { return }
        let value = index(of: ink)
        for row in y0..<y1 {
            let base = row * width
            for column in x0..<x1 { cells[base + column] = value }
        }
    }

    /// Paints a piece of the art set with its top-left at (x, y). `light` recolours its '@' state light.
    mutating func stamp(_ piece: OfficeArt.Piece, x: Int, y: Int, light: UInt32? = nil) {
        for (dy, row) in piece.rows.enumerated() {
            var dx = 0
            for char in row {
                defer { dx += 1 }
                guard char != "." else { continue }
                let hex = char == "@" ? (light ?? piece.palette[char] ?? 0) : (piece.palette[char] ?? 0)
                fill(x + dx, y + dy, 1, 1, OfficeInk(hex))
            }
        }
    }

    func art(opacity: Double = 1) -> PixelArt {
        var paths = Array(repeating: Path(), count: inks.count)
        for row in 0..<height {
            var column = 0
            let base = row * width
            while column < width {
                let value = cells[base + column]
                guard value != 0 else { column += 1; continue }
                var end = column + 1
                while end < width && cells[base + end] == value { end += 1 }
                paths[Int(value) - 1].addRect(CGRect(x: originX + column, y: originY + row, width: end - column, height: 1))
                column = end
            }
        }
        var art = PixelArt(opacity: opacity)
        for (index, ink) in inks.enumerated() where !paths[index].isEmpty {
            art.fills.append(PixelArt.Fill(color: ink.color, path: paths[index]))
        }
        for (ink, rect) in overlays {
            art.fills.append(PixelArt.Fill(color: ink.color, path: Path(rect)))
        }
        return art
    }
}

/// A piece of the art set prebuilt once as one path per palette character, with its top-left at the origin; drawn
/// anywhere by translating. Used for what the moving layer draws every frame (chairs, lids, monitor backs, fx).
struct OfficePieceArt: Sendable {
    struct Layer: Sendable {
        let char: Character
        let color: Color
        let path: Path
    }
    let width: Int
    let height: Int
    let layers: [Layer]

    init(_ piece: OfficeArt.Piece) {
        width = piece.width
        height = piece.height
        var paths: [Character: Path] = [:]
        var order: [Character] = []
        for (y, row) in piece.rows.enumerated() {
            let chars = Array(row)
            var x = 0
            while x < chars.count {
                let char = chars[x]
                guard char != "." else { x += 1; continue }
                var end = x + 1
                while end < chars.count && chars[end] == char { end += 1 }
                if paths[char] == nil { order.append(char) }
                paths[char, default: Path()].addRect(CGRect(x: x, y: y, width: end - x, height: 1))
                x = end
            }
        }
        layers = order.map { Layer(char: $0, color: Color(hex: piece.palette[$0] ?? 0), path: paths[$0] ?? Path()) }
    }

    /// Draws with the top-left at (x, y); `light` colours the '@' state light; `clipBottom` cuts everything at and
    /// below that y (a chair tucked behind a desk).
    func draw(_ ctx: inout GraphicsContext, x: CGFloat, y: CGFloat, light: UInt32? = nil, clipBottom: CGFloat? = nil) {
        var c = ctx
        if let clipBottom {
            c.clip(to: Path(CGRect(x: x - 1, y: y - 1, width: CGFloat(width) + 2, height: max(0, clipBottom - y + 1))))
        }
        c.translateBy(x: x, y: y)
        for layer in layers {
            let color = layer.char == "@" ? light.map { Color(hex: $0) } ?? layer.color : layer.color
            c.fill(layer.path, with: .color(color))
        }
    }
}

/// The pieces the moving layer draws, prebuilt once.
enum OfficePieces {
    static let chairFront = OfficePieceArt(OfficeArt.chairFront)
    static let chairLead = OfficePieceArt(OfficeArt.chairLead)
    static let chairBack = OfficePieceArt(OfficeArt.chairBack)
    static let chairFrontLip = OfficePieceArt(OfficeArt.chairFrontLip)
    static let chairRestFront = OfficePieceArt(OfficeArt.chairRestFront)
    static let lid = OfficePieceArt(OfficeArt.lid)
    static let lidClosed = OfficePieceArt(OfficeArt.lidClosed)
    static let monitorBack = OfficePieceArt(OfficeArt.monitorBack)
    static let battery = OfficePieceArt(OfficeArt.battery)
    static let sweat = OfficePieceArt(OfficeArt.sweat)
    static let sparkle0 = OfficePieceArt(OfficeArt.sparkle0)
    static let sparkle1 = OfficePieceArt(OfficeArt.sparkle1)
    static let screenWaiting = OfficePieceArt(OfficeArt.screenWaiting)
    static let screenBlocked = OfficePieceArt(OfficeArt.screenBlocked)
    static let screenError = OfficePieceArt(OfficeArt.screenError)
}

// MARK: - Pixel glyphs

/// Tiny pixel glyphs for the emotes ('#' = ink).
enum PixelGlyph {
    static let question = [".##.", "#..#", "..#.", "....", "..#."]
    static let bang = ["##", "##", "##", "..", "##"]
    static let zed = ["####", "..#.", ".#..", "####"]

    static func path(_ rows: [String], x: Int, y: Int) -> Path {
        var path = Path()
        for (dy, row) in rows.enumerated() {
            var dx = 0
            let chars = Array(row)
            while dx < chars.count {
                guard chars[dx] == "#" else { dx += 1; continue }
                var end = dx + 1
                while end < chars.count && chars[end] == "#" { end += 1 }
                path.addRect(CGRect(x: x + dx, y: y + dy, width: end - dx, height: 1))
                dx = end
            }
        }
        return path
    }
}

/// Stable per-member numbers (djb2). `hashValue` changes per launch, so it would reshuffle accessories on every start.
func officeHash(_ value: String) -> UInt64 {
    var hash: UInt64 = 5381
    for byte in value.utf8 { hash = (hash &<< 5) &+ hash &+ UInt64(byte) }
    return hash
}

/// A second, independent stream from the same seed (splitmix64 finaliser).
func officeMix(_ seed: UInt64, _ salt: UInt64) -> UInt64 {
    var z = seed &+ salt &* 0x9E3779B97F4A7C15
    z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
    z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
    return z ^ (z >> 31)
}
