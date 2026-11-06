import SwiftUI

// Drawing of the office. The static layer (desks, monitors, rest armchairs, and every piece of a desk whose owner is
// away) redraws only when the map changes; the moving layer draws the rest every frame from pure positions: lights,
// screens, the chairs and laptops of occupied desks, residents (in their state's colour), emotes and fx. Both draw in
// sprite pixels (the context is scaled by the pixel size), so every edge sits on the device pixel grid.

enum OfficeScreen: Equatable, Sendable { case off, working, waiting, blocked, error }

/// Everything the moving layer needs.
struct OfficeScene {
    var map: OfficeMap
    var cast: OfficeCast
    var plans: [String: OfficeWalkPlan]
    var residents: [String: OfficeResident]
    /// Screen state per desk index.
    var screens: [Int: OfficeScreen]
    /// Desks showing the context warning (문맥 경고).
    var batteries: Set<Int>
    var still: Bool

    func actors(at t: Double) -> [OfficeActor] {
        cast.ids.compactMap { id in
            guard let placement = cast.placements[id], let tone = cast.tones[id] else { return nil }
            return OfficeStage.actor(id, placement: placement, tone: tone, plan: plans[id], map: map, t: t, still: still)
        }
    }

    func bounds(_ actor: OfficeActor) -> CGRect {
        residents[actor.id]?.bounds(actor.frame, at: actor.point, mirrored: actor.mirrored)
            ?? CGRect(x: actor.point.x - 8, y: actor.point.y - 15, width: 16, height: 15)
    }

    /// The resident under a point (front-most first), else the desk under it (nearer rows first).
    func hit(_ point: CGPoint, t: Double) -> String? {
        let actors = actors(at: t).filter { $0.alpha > 0.4 }.sorted { $0.sortY > $1.sortY }
        if let actor = actors.first(where: { bounds($0).insetBy(dx: -1, dy: -1).contains(point) }) { return actor.id }
        return map.desks.sorted { $0.origin.y > $1.origin.y }.first { $0.cell.contains(point) }.map { $0.memberID ?? $0.id }
    }
}

enum OfficeRenderer {
    // MARK: Static layer

    static func drawStatic(_ ctx: inout GraphicsContext, map: OfficeMap) {
        map.shadows.draw(&ctx)
        for item in map.furniture { item.art.draw(&ctx) }
    }

    /// A soft elliptical light: a circular gradient squeezed into `rect`, so it fades smoothly to nothing exactly at
    /// the ellipse's edge on both axes (no visible rim).
    private static func glow(_ ctx: inout GraphicsContext, center: CGPoint, rx: CGFloat, ry: CGFloat, hex: UInt32, alpha: Double) {
        var c = ctx
        c.translateBy(x: center.x, y: center.y)
        c.scaleBy(x: 1, y: ry / rx)
        let color = Color(hex: hex).opacity(alpha)
        // (1 - d²)² falloff: bright in the middle, a long gentle tail.
        let gradient = Gradient(stops: [
            .init(color: color, location: 0), .init(color: color.opacity(0.77), location: 0.35),
            .init(color: color.opacity(0.26), location: 0.7), .init(color: color.opacity(0), location: 1),
        ])
        c.fill(Path(ellipseIn: CGRect(x: -rx, y: -rx, width: 2 * rx, height: 2 * rx)),
               with: .radialGradient(gradient, center: .zero, startRadius: 0, endRadius: rx))
    }

    /// The light of a lit desk: the laptop on a top-row face, the two monitors of the lead, a bottom-row monitor.
    private static func drawGlow(_ ctx: inout GraphicsContext, desk: OfficeDesk, state: OfficeScreen) {
        let work = state == .working
        guard work || state == .error else { return }
        let hex = work ? OfficePalette.glowWork : OfficePalette.glowError
        let o = desk.origin
        switch desk.row {
        case .lead:
            for x in [o.x + 9, o.x + 38] {
                glow(&ctx, center: CGPoint(x: x, y: o.y - 3), rx: work ? 17 : 15, ry: work ? 11 : 10, hex: hex, alpha: work ? 0.3 : 0.2)
            }
        case .top:
            glow(&ctx, center: CGPoint(x: o.x + 14, y: o.y - 2), rx: work ? 16 : 14, ry: work ? 10 : 9, hex: hex, alpha: work ? 0.3 : 0.2)
        case .bottom:
            glow(&ctx, center: CGPoint(x: o.x + 14, y: o.y - 3), rx: work ? 18 : 15, ry: work ? 11 : 10, hex: hex, alpha: work ? 0.32 : 0.2)
        }
    }

    // MARK: Moving layer

    private enum Piece {
        case chair(OfficePieceArt, CGPoint, clip: CGFloat?)
        case lid(Int, closed: Bool)
        case monitors(Int)
        case actor(Int)
    }

    static func drawDynamic(_ ctx: inout GraphicsContext, scene sceneIn: OfficeScene, t: Double) {
        var scene = sceneIn
        let map = scene.map
        let actors = scene.actors(at: t)
        // A desk lights up only once its resident has sat down; an armchair holds whoever sits in it.
        var arrived: [Int: OfficeActor] = [:]
        var seated: [Int: OfficeActor] = [:]
        for actor in actors where actor.alpha >= 1 {
            if let d = actor.desk { arrived[d] = actor }
            if actor.pose == .resting, let i = map.rests.firstIndex(where: { $0.point == actor.point }) { seated[i] = actor }
        }
        for d in map.desks.indices where arrived[d] == nil { scene.screens[d] = .off }
        let lit = scene.screens.filter { map.desks.indices.contains($0.key) && $0.value != .off }.sorted { $0.key < $1.key }
        // Every light first, then every screen, so no light ever washes over a screen.
        for (d, state) in lit { drawGlow(&ctx, desk: map.desks[d], state: state) }
        for (d, state) in lit { drawScreen(&ctx, desk: map.desks[d], state: state, t: t, still: scene.still) }
        // The context warning: a low battery standing on the desk's left end, where no resident, bubble or sweat
        // drop ever goes; residents and emotes draw after it.
        for d in scene.batteries.sorted() where map.desks.indices.contains(d) {
            let o = map.desks[d].origin
            OfficePieces.battery.draw(&ctx, x: o.x + 1, y: o.y + 1)
        }

        // The pieces of occupied desks and armchairs, and every resident, in depth order.
        var pieces: [(y: CGFloat, order: Int, piece: Piece)] = []
        var seatShadows = Path()
        for (d, desk) in map.desks.enumerated() where !desk.away {
            let o = desk.origin
            let here = arrived[d]
            let turned = here.map { [.chairWait0, .chairWait1, .chairBlocked0, .chairBlocked1].contains($0.frame) } ?? false
            switch desk.row {
            case .lead:
                pieces.append((o.y - 8, 0, .chair(OfficePieces.chairLead, CGPoint(x: desk.seat.x - 12, y: o.y - 28), clip: nil)))
                pieces.append((o.y + 2, 2, .monitors(d)))
            case .top:
                // The blob hides the chair behind it; an empty seat shows the chair tucked behind the desk.
                if here == nil {
                    pieces.append((o.y - 1, 0, .chair(OfficePieces.chairFront, CGPoint(x: o.x + 6, y: o.y - 13), clip: o.y)))
                }
                pieces.append((o.y + 2, 2, .lid(d, closed: here?.frame == .deskFrontError)))
            case .bottom:
                seatShadows.addRect(CGRect(x: o.x + 9, y: o.y + 28, width: 10, height: 2))
                seatShadows.addRect(CGRect(x: o.x + 8, y: o.y + 29, width: 12, height: 1))
                if turned {
                    // Turned around to face the viewer: on the chair, its seat front over the blob's bottom.
                    pieces.append((o.y + 21, 0, .chair(OfficePieces.chairFront, CGPoint(x: o.x + 6, y: o.y + 9), clip: nil)))
                    pieces.append((o.y + 22, 2, .chair(OfficePieces.chairFrontLip, CGPoint(x: o.x + 6, y: o.y + 9), clip: nil)))
                } else {
                    // The chair back covers the lower back.
                    pieces.append((o.y + 22, 2, .chair(OfficePieces.chairBack, CGPoint(x: o.x + 7, y: o.y + 18), clip: nil)))
                }
            }
        }
        for (i, _) in seated where map.rests.indices.contains(i) {
            let chair = map.rests[i].chair
            pieces.append((chair.y + 14, 2, .chair(OfficePieces.chairRestFront, chair, clip: nil)))
        }
        if !seatShadows.isEmpty { ctx.fill(seatShadows, with: .color(OfficePalette.shadow.color)) }
        for (i, actor) in actors.enumerated() { pieces.append((actor.sortY, 1, .actor(i))) }
        pieces.sort { $0.y != $1.y ? $0.y < $1.y : $0.order < $1.order }

        for item in pieces {
            switch item.piece {
            case .chair(let art, let at, let clip):
                art.draw(&ctx, x: at.x, y: at.y, clipBottom: clip)
            case .lid(let d, let closed):
                let o = map.desks[d].origin
                let led = OfficePalette.led(scene.screens[d] ?? .off)
                if closed {
                    OfficePieces.lidClosed.draw(&ctx, x: o.x + 9, y: o.y + 2, light: led)
                } else {
                    OfficePieces.lid.draw(&ctx, x: o.x + 9, y: o.y - 2, light: led)
                }
            case .monitors(let d):
                let o = map.desks[d].origin
                let led = OfficePalette.led(scene.screens[d] ?? .off)
                OfficePieces.monitorBack.draw(&ctx, x: o.x + 3, y: o.y - 8, light: led)
                OfficePieces.monitorBack.draw(&ctx, x: o.x + 32, y: o.y - 8, light: led)
            case .actor(let i):
                drawActor(&ctx, actors[i], scene: scene, t: t)
            }
        }

        for actor in actors where actor.alpha > 0.5 {
            if actor.sweat { drawSweat(&ctx, actor, still: scene.still, t: t) }
            if actor.sparkle > 0 { drawSparkle(&ctx, actor) }
            if let emote = actor.emote { drawEmote(&ctx, emote, actor: actor, scene: scene, t: t) }
        }
    }

    // MARK: Residents

    private static func drawActor(_ ctx: inout GraphicsContext, _ actor: OfficeActor, scene: OfficeScene, t: Double) {
        guard let resident = scene.residents[actor.id] else { return }
        let map = scene.map
        var c = ctx
        if actor.alpha < 1 { c.opacity = max(0, actor.alpha) }
        let feet = actor.point
        if actor.onFoot {
            // On the floor: 12x3 while grounded, 10x2 in the air (the top of a hop).
            let airborne = [.walkFront2, .walkFront3, .walkBack2, .walkBack3, .walkSide2, .walkSide3].contains(actor.frame)
            let shadow = OfficePalette.shadow.color
            var path = Path()
            if airborne {
                path.addRect(CGRect(x: feet.x - 4, y: feet.y - 1, width: 8, height: 1))
                path.addRect(CGRect(x: feet.x - 5, y: feet.y, width: 10, height: 1))
            } else {
                path.addRect(CGRect(x: feet.x - 5, y: feet.y - 1, width: 10, height: 1))
                path.addRect(CGRect(x: feet.x - 6, y: feet.y, width: 12, height: 1))
                path.addRect(CGRect(x: feet.x - 5, y: feet.y + 1, width: 10, height: 1))
            }
            c.fill(path, with: .color(shadow))
        }
        resident.draw(actor.frame, tone: actor.tone, at: feet, mirrored: actor.mirrored, blink: actor.blink, in: &c)
        guard actor.onFoot else { return }
        // Furniture standing in front of the resident covers it again (y-sorted occlusion).
        let rect = scene.bounds(actor)
        for item in map.furniture where item.sortY > feet.y && item.bounds.intersects(rect) {
            item.art.draw(&c)
            if let d = item.desk, let state = scene.screens[d], state != .off, map.desks.indices.contains(d) {
                drawScreen(&c, desk: map.desks[d], state: state, t: t, still: scene.still)
            }
        }
    }

    // MARK: Screens

    /// A bottom-row monitor: code lines scrolling slowly while working (its light is `drawGlow`), a quiet prompt while
    /// waiting, an approval dialog, a red cross on an error.
    private static func drawScreen(_ ctx: inout GraphicsContext, desk: OfficeDesk, state: OfficeScreen, t: Double, still: Bool) {
        guard let screen = desk.screen else { return }
        switch state {
        case .off:
            break
        case .working:
            let x = screen.minX, y = screen.minY
            ctx.fill(Path(screen), with: .color(OfficePalette.screenOn.color))
            let seed = officeHash(desk.id)
            let step = still ? 0 : Int((t + Double(seed % 13) / 13) * 1.5)
            for row in 0..<3 {
                let line = officeMix(seed, UInt64(step + row))
                var cx = 1 + CGFloat(line % 3)
                let first = CGFloat(3 + (line >> 4) % 5)
                let second = CGFloat(2 + (line >> 8) % 4)
                for (k, length) in [first, second].enumerated() {
                    let w = min(length, 13 - cx)
                    guard w >= 2 else { break }
                    let ink = OfficePalette.code[Int((line >> (12 + UInt64(k) * 3)) % 3)]
                    ctx.fill(Path(CGRect(x: x + cx, y: y + 1 + CGFloat(row), width: w, height: 1)), with: .color(ink.color))
                    cx += w + 1
                }
            }
        case .waiting:
            OfficePieces.screenWaiting.draw(&ctx, x: screen.minX, y: screen.minY)
        case .blocked:
            OfficePieces.screenBlocked.draw(&ctx, x: screen.minX, y: screen.minY)
        case .error:
            OfficePieces.screenError.draw(&ctx, x: screen.minX, y: screen.minY)
        }
    }

    // MARK: Emotes

    private static func bob(_ actor: OfficeActor, still: Bool, t: Double) -> CGFloat {
        still ? 0 : (sin((t + actor.phase * 5) * 2 * .pi / 1.4) > 0.3 ? -1 : 0)
    }

    private static func drawEmote(_ ctx: inout GraphicsContext, _ emote: OfficeEmote, actor: OfficeActor, scene: OfficeScene,
                                  t: Double) {
        let still = scene.still
        let head = actor.head
        if emote == .sleep {
            // z's drift up and to the right from beside the head.
            let ink = OfficePalette.zed.color
            let x = head.x + 6, top = head.y - 4
            if still {
                ctx.fill(PixelGlyph.path(PixelGlyph.zed, x: Int(x), y: Int(top) - 4), with: .color(ink.opacity(0.8)))
                return
            }
            for i in 0..<2 {
                let raw = (t + actor.phase * 3 + Double(i) * 1.6) / 3.2
                let p = raw - raw.rounded(.down)
                var c = ctx
                c.opacity = sin(p * .pi) * 0.9
                let zx = Int((x + CGFloat(p * 5)).rounded()), zy = Int((top - CGFloat(p * 10)).rounded())
                c.fill(PixelGlyph.path(PixelGlyph.zed, x: zx, y: zy), with: .color(ink))
            }
            return
        }
        guard actor.desk != nil else { return }
        // Beside the head on the right, its tail pointing at the head (an error's a step further out and up).
        let (glyph, ink): ([String], UInt32) = switch emote {
        case .question: (PixelGlyph.question, 0xF08A2E)
        case .approval: (PixelGlyph.bang, 0xFF6B5E)
        default: (PixelGlyph.bang, 0xE8394A)
        }
        let left = actor.point.x + (emote == .error ? 11 : 10)
        let top = head.y - (emote == .error ? 6 : 4) + (emote == .question ? bob(actor, still: still, t: t) : 0)
        bubble(&ctx, glyph: glyph, ink: ink, left: left, top: top, tailLeft: true)
    }

    /// A white speech bubble (11x8) at a top-left corner, its 2px tail leaning down and out of the bottom-left corner
    /// (or the bottom-right one).
    private static func bubble(_ ctx: inout GraphicsContext, glyph: [String], ink: UInt32, left rawLeft: CGFloat, top rawTop: CGFloat,
                               tailLeft: Bool) {
        let left = rawLeft.rounded(), top = rawTop.rounded()
        var outline = Path(), shade = Path()
        outline.addRect(CGRect(x: left + 1, y: top, width: 9, height: 8))
        outline.addRect(CGRect(x: left, y: top + 1, width: 11, height: 6))
        if tailLeft {
            outline.addRect(CGRect(x: left - 1, y: top + 6, width: 2, height: 2))
            outline.addRect(CGRect(x: left - 2, y: top + 8, width: 1, height: 1))
            shade.addRect(CGRect(x: left, y: top + 6, width: 1, height: 1))
        } else {
            outline.addRect(CGRect(x: left + 10, y: top + 6, width: 2, height: 2))
            outline.addRect(CGRect(x: left + 12, y: top + 8, width: 1, height: 1))
            shade.addRect(CGRect(x: left + 10, y: top + 6, width: 1, height: 1))
        }
        shade.addRect(CGRect(x: left + 1, y: top + 6, width: 9, height: 1))
        ctx.fill(outline, with: .color(OfficePalette.line.color))
        ctx.fill(Path(CGRect(x: left + 1, y: top + 1, width: 9, height: 6)), with: .color(OfficePalette.bubble.color))
        ctx.fill(shade, with: .color(OfficePalette.bubbleShade.color))
        let width = glyph.map(\.count).max() ?? 0
        let gx = Int(left) + (11 - width) / 2
        ctx.fill(PixelGlyph.path(glyph, x: gx, y: Int(top) + 1), with: .color(Color(hex: ink)))
    }

    /// A sweat drop on the forehead's left edge of a resident collapsed on an error: it slides down a pixel at a time,
    /// then forms again at the top (still with Reduce Motion).
    private static func drawSweat(_ ctx: inout GraphicsContext, _ actor: OfficeActor, still: Bool, t: Double) {
        var slide: CGFloat = 0
        if !still {
            // 2.4 s: four 0.45 s steps down, then a short gap before the next drop.
            let local = (t + actor.phase * 4).truncatingRemainder(dividingBy: 2.4)
            if local >= 1.8 { return }
            slide = CGFloat(Int(local / 0.45))
        }
        let back = actor.frame == .deskBackError
        OfficePieces.sweat.draw(&ctx, x: actor.point.x - 11, y: actor.head.y + (back ? -1 : 1) + slide)
    }

    /// A working resident's twinkle beside the head: small, big, small.
    private static func drawSparkle(_ ctx: inout GraphicsContext, _ actor: OfficeActor) {
        let x = actor.point.x + 6, y = actor.head.y - 3
        if actor.sparkle == 2 {
            OfficePieces.sparkle1.draw(&ctx, x: x, y: y)
        } else {
            OfficePieces.sparkle0.draw(&ctx, x: x + 1, y: y + 1)
        }
    }
}
