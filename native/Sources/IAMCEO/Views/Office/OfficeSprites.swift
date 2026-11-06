import SwiftUI

// The office residents: one mascot for everyone, a round pixel blob (about 16-20 x 12-17 sprite pixels). Its body
// colour is its state; members differ only by the one small accessory each wears (the lead always wears the crown).
// Each accessory is composed once into one Path per colour role for every frame (body, face, accessory); drawing a
// resident then only picks the colours of its state.

/// Colour roles of the resident templates (see the legend in OfficeArt).
enum OfficeSpriteRole: Int, CaseIterable, Sendable {
    // Body: recoloured per state.
    case outline, litOutline, shade, base, light, shine, blush
    // Face: the same for everyone.
    case eye, eyeWhite, glint, mouth, mouthInside
    // Accessory: per accessory.
    case accLine, acc, accShade, accLight, acc2, acc2Shade

    static let body: [Character: OfficeSpriteRole] = [
        "o": .outline, "O": .litOutline, "s": .shade, "b": .base, "l": .light, "h": .shine, "c": .blush,
        "E": .eye, "W": .eyeWhite, "i": .glint, "M": .mouth, "m": .mouthInside,
    ]
    static let accessory: [Character: OfficeSpriteRole] = [
        "x": .accLine, "a": .acc, "A": .accShade, "g": .accLight, "k": .acc2, "K": .acc2Shade,
    ]
}

/// A resident's state as a body colour. Offline and unknown states are not drawn.
enum OfficeTone: String, CaseIterable, Sendable {
    case working, waiting, blocked, error, idle, asleep

    init?(status: String) {
        self.init(rawValue: status)
    }
}

// MARK: - Accessories

enum OfficeWear {
    /// One accessory per member, stable per member id: `accessoryOrder[hash(id) % 12]`, stepping on to the next one not
    /// yet taken in this team while any are left (earlier members never change when someone joins at the end). The
    /// lead always wears the crown, and no one else does.
    static func assign(_ ids: [String], lead: String?) -> [String: OfficeAccessory] {
        let order = OfficeArt.accessoryOrder
        var taken = Set<OfficeAccessory>()
        var result: [String: OfficeAccessory] = [:]
        for id in ids where result[id] == nil {
            if id == lead {
                result[id] = .crown
                continue
            }
            let start = Int(officeHash(id) % UInt64(order.count))
            let pick = (0..<order.count).lazy.map { order[(start + $0) % order.count] }.first { !taken.contains($0) }
                ?? order[start]
            taken.insert(pick)
            if taken.count == order.count { taken.removeAll() }
            result[id] = pick
        }
        return result
    }
}

// MARK: - Colours

enum OfficePaint {
    /// Colours indexed by `OfficeSpriteRole.rawValue`, per state and accessory (built once).
    private static let table: [OfficeTone: [OfficeAccessory: [Color]]] = {
        var table: [OfficeTone: [OfficeAccessory: [Color]]] = [:]
        for tone in OfficeTone.allCases {
            let ramp = OfficeArt.states[tone.rawValue] ?? []
            var body: [Character: UInt32] = OfficeArt.faceFixed
            for (i, role) in OfficeArt.stateRoles.enumerated() where ramp.indices.contains(i) { body[role] = ramp[i] }
            for accessory in OfficeAccessory.allCases {
                let palette = OfficeArt.accessories[accessory]?.palette ?? [:]
                table[tone, default: [:]][accessory] = OfficeSpriteRole.allCases.map { role in
                    let hex: UInt32
                    switch role {
                    case .outline: hex = body["o"] ?? 0
                    case .litOutline: hex = body["O"] ?? 0
                    case .shade: hex = body["s"] ?? 0
                    case .base: hex = body["b"] ?? 0
                    case .light: hex = body["l"] ?? 0
                    case .shine: hex = body["h"] ?? 0
                    case .blush: hex = body["c"] ?? 0
                    case .eye: hex = body["E"] ?? 0
                    case .eyeWhite: hex = body["W"] ?? 0
                    case .glint: hex = body["i"] ?? 0
                    case .mouth: hex = body["M"] ?? 0
                    case .mouthInside: hex = body["m"] ?? 0
                    case .accLine: hex = palette["x"] ?? 0
                    case .acc: hex = palette["a"] ?? 0
                    case .accShade: hex = palette["A"] ?? 0
                    case .accLight: hex = palette["g"] ?? 0
                    case .acc2: hex = palette["k"] ?? 0
                    case .acc2Shade: hex = palette["K"] ?? 0
                    }
                    return Color(hex: hex)
                }
            }
        }
        return table
    }()

    static func colors(_ tone: OfficeTone, _ accessory: OfficeAccessory) -> [Color] {
        table[tone]?[accessory] ?? []
    }
}

// MARK: - Composition

extension OfficeFrame {
    /// The frame has a blink face (open eyes that close for a moment now and then).
    var blinks: Bool { art.blink != nil }
}

/// One composed frame: a path per colour role, in sprite pixels relative to the frame's anchor.
struct OfficeSpriteArt: Sendable {
    struct Layer: Sendable {
        let role: OfficeSpriteRole
        let path: Path
    }
    let layers: [Layer]
    /// Bounds of every opaque pixel, relative to the anchor.
    let bounds: CGRect

    static let empty = OfficeSpriteArt(layers: [], bounds: .zero)

    init(layers: [Layer], bounds: CGRect) {
        self.layers = layers
        self.bounds = bounds
    }

    /// Composes a frame: the body, its face (or blink face), then the accessory at the head (or face) point.
    init(_ frame: OfficeFrame, accessory: OfficeAccessory?, blink: Bool) {
        let data = frame.art
        // A window larger than any frame plus its accessory, in frame coordinates offset by (ox, oy).
        let ox = 16, oy = 16, w = 56, h = 48
        var cells = [UInt8](repeating: 0, count: w * h)
        func stamp(_ rows: [String], _ x0: Int, _ y0: Int, _ roles: [Character: OfficeSpriteRole]) {
            for (dy, row) in rows.enumerated() {
                var dx = 0
                for char in row {
                    defer { dx += 1 }
                    guard char != ".", let role = roles[char] else { continue }
                    let x = x0 + dx + ox, y = y0 + dy + oy
                    guard x >= 0, y >= 0, x < w, y < h else { continue }
                    cells[y * w + x] = UInt8(role.rawValue + 1)
                }
            }
        }
        stamp(data.rows, 0, 0, OfficeSpriteRole.body)
        if let face = (blink ? data.blink : nil) ?? data.face, let rows = OfficeArt.faces[face] {
            stamp(rows, data.faceX, data.faceY, OfficeSpriteRole.body)
        }
        if let accessory, let art = OfficeArt.accessories[accessory] {
            let overlay = art.overlay(data.view)
            let x = (art.onFace ? data.faceX : data.headX) + overlay.dx
            let y = (art.onFace ? data.faceY : data.headY) + overlay.dy
            stamp(overlay.rows, x, y, OfficeSpriteRole.accessory)
        }

        var paths = [Path](repeating: Path(), count: OfficeSpriteRole.allCases.count)
        var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min
        for y in 0..<h {
            var x = 0
            while x < w {
                let value = cells[y * w + x]
                guard value != 0 else { x += 1; continue }
                var end = x + 1
                while end < w && cells[y * w + end] == value { end += 1 }
                let fx = x - ox - data.anchorX, fy = y - oy - data.anchorY
                paths[Int(value) - 1].addRect(CGRect(x: fx, y: fy, width: end - x, height: 1))
                minX = min(minX, fx); maxX = max(maxX, fx + end - x)
                minY = min(minY, fy); maxY = max(maxY, fy + 1)
                x = end
            }
        }
        layers = OfficeSpriteRole.allCases.compactMap { role in
            paths[role.rawValue].isEmpty ? nil : Layer(role: role, path: paths[role.rawValue])
        }
        bounds = minX == .max ? .zero : CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

/// Every frame (and its blink) composed with one accessory. Shared by every member wearing it.
final class OfficeShapeSet: Sendable {
    private let arts: [OfficeSpriteArt]

    init(accessory: OfficeAccessory?) {
        var arts: [OfficeSpriteArt] = []
        for frame in OfficeFrame.allCases {
            let open = OfficeSpriteArt(frame, accessory: accessory, blink: false)
            arts.append(open)
            arts.append(frame.blinks ? OfficeSpriteArt(frame, accessory: accessory, blink: true) : open)
        }
        self.arts = arts
    }

    func art(_ frame: OfficeFrame, blink: Bool = false) -> OfficeSpriteArt {
        let index = frame.rawValue * 2 + (blink ? 1 : 0)
        return arts.indices.contains(index) ? arts[index] : .empty
    }
}

/// A member as drawn: its accessory and the frames composed with it. The colours come from the state at draw time.
struct OfficeResident: Sendable {
    let accessory: OfficeAccessory
    let shapes: OfficeShapeSet

    /// Draws a frame in the colours of `tone` with its anchor at `point` (sprite pixels). Mirrored frames face right.
    func draw(_ frame: OfficeFrame, tone: OfficeTone, at point: CGPoint, mirrored: Bool = false, blink: Bool = false,
              in ctx: inout GraphicsContext) {
        let art = shapes.art(frame, blink: blink)
        let colors = OfficePaint.colors(tone, accessory)
        guard colors.count == OfficeSpriteRole.allCases.count else { return }
        var c = ctx
        c.translateBy(x: point.x, y: point.y)
        if mirrored { c.scaleBy(x: -1, y: 1) }
        for layer in art.layers { c.fill(layer.path, with: .color(colors[layer.role.rawValue])) }
    }

    /// Bounds of a frame drawn at `point`.
    func bounds(_ frame: OfficeFrame, at point: CGPoint, mirrored: Bool = false) -> CGRect {
        var b = shapes.art(frame).bounds
        if mirrored { b.origin.x = -b.maxX }
        return b.offsetBy(dx: point.x, dy: point.y)
    }

    /// The head point (where accessories attach) of a frame drawn at `point`.
    static func head(_ frame: OfficeFrame, at point: CGPoint, mirrored: Bool = false) -> CGPoint {
        let art = frame.art
        let x = CGFloat(art.headX - art.anchorX)
        return CGPoint(x: point.x + (mirrored ? -x - 1 : x), y: point.y + CGFloat(art.headY - art.anchorY))
    }
}
