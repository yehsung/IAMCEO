import SwiftUI

// The office map, in sprite pixels. The lead (총괄) sits alone at the top behind a wide desk, facing the team. Below it
// the team sits in BANDS: a top row facing a bottom row across a few pixels of floor, on an even grid of columns that
// spans the whole width (every desk has the same gap to its neighbours; a band that is not full is centred on the same
// grid). More members than a band holds add another band below, with a clear aisle between bands. The top row sits
// behind its desks facing down (a low laptop in front); the bottom row sits in front of its desks with its back to us
// (a monitor facing the viewer). Nameplates sit on the outer side of each row, each within its own column.
//
// The pixel scale comes from the width, always a whole number of device pixels: as large as fits (iPhone up to about
// 2.33pt per sprite pixel; Mac and iPad up to 2.5pt, and up to 3.5pt for a single band that fills the width), one
// step smaller when that saves a band. A wide column never grows past `cellMax`: a team too small to fill the width
// is centred instead of spread thin. There is no rest area: everyone stays at its own desk, resting or asleep there
// too, so desks depend only on who has one (`OfficeSeating`) and the width, never on anyone's state.
//
// Nothing else is drawn: no wall, no decoration. The walk lattice (every 4px) is logical only.

enum OfficeSeatRow: Sendable { case lead, top, bottom }

/// Where a nameplate goes: centred on `center` when it fits, within [minX, maxX] (its column). Top-row plates hang above
/// the row (their bottom edge on `y`); the lead's and the bottom row's hang below it (top edge on `y`).
struct OfficePlateSlot: Equatable {
    var center: CGFloat
    var minX: CGFloat
    var maxX: CGFloat
    var y: CGFloat
    var above: Bool
}

/// One desk. Every member has one, in `state.members` order; it never moves on a status change.
struct OfficeDesk: Identifiable {
    let id: String
    /// nil for the empty seat shown while a project has no 팀장 yet.
    let memberID: String?
    let row: OfficeSeatRow
    /// The desk's top-left (a 28px desk, or the lead's 47px one).
    let origin: CGPoint
    /// Anchor of the seated frames: the desk's back edge (top row, lead) or the seat point (bottom row, whether the
    /// resident faces the desk or has turned around).
    let seat: CGPoint
    /// Where a walk to this desk ends (feet), and the aisle point it passes through on the way in and out.
    let arrive: CGPoint
    let approach: CGPoint
    /// Hit, highlight and accessibility area (resident, desk, monitor and chair). The two facing cells of a column
    /// meet at the top desk's lower edge, so a bottom-row monitor's screen belongs wholly to its own member.
    let cell: CGRect
    let plate: OfficePlateSlot
    /// The screen of a bottom-row monitor (14x5).
    let screen: CGRect?
    /// The owner is absent (offline, unknown) or there is no owner yet: the desk recedes, its chair is empty.
    let away: Bool
}

/// A piece of static furniture: its art, bounds and the y used to sort it against residents.
struct OfficeFurniture {
    let bounds: CGRect
    let sortY: CGFloat
    let art: PixelArt
    /// The desk index of a bottom-row desk (its lit screen is drawn again when it covers a resident).
    var desk: Int?
}

struct OfficeMap {
    /// In sprite pixels.
    var size: CGSize = .zero
    /// Points per sprite pixel (a whole number of device pixels).
    var pixel: CGFloat = 2
    /// A nameplate's height in sprite pixels.
    var plateHeight = 8
    var desks: [OfficeDesk] = []
    var furniture: [OfficeFurniture] = []
    var shadows = PixelArt()
    var walk = OfficeWalkGrid()
    /// The desks only: walks carry over while it stays the same.
    var layout = ""
}

// MARK: - Walk lattice

/// Points every 4px; a point is open when a small footprint around it touches no furniture.
struct OfficeWalkGrid {
    var columns = 0
    var rows = 0
    var open: [Bool] = []

    static let step: CGFloat = 4

    func isOpen(_ i: Int, _ j: Int) -> Bool {
        i >= 0 && j >= 0 && i < columns && j < rows && open[j * columns + i]
    }

    func point(_ i: Int, _ j: Int) -> CGPoint { CGPoint(x: CGFloat(i) * Self.step, y: CGFloat(j) * Self.step) }

    /// The open lattice point closest to `point`.
    func nearestOpen(to point: CGPoint) -> (Int, Int)? {
        let ci = Int((point.x / Self.step).rounded()), cj = Int((point.y / Self.step).rounded())
        if isOpen(ci, cj) { return (ci, cj) }
        for radius in 1..<max(columns, rows, 2) {
            var best: (Int, Int)?
            var bestDistance = CGFloat.infinity
            for j in (cj - radius)...(cj + radius) {
                for i in (ci - radius)...(ci + radius) where abs(i - ci) == radius || abs(j - cj) == radius {
                    guard isOpen(i, j) else { continue }
                    let p = self.point(i, j)
                    let d = hypot(p.x - point.x, p.y - point.y)
                    if d < bestDistance { bestDistance = d; best = (i, j) }
                }
            }
            if let best { return best }
        }
        return nil
    }

    private static let moves = [(1, 0), (-1, 0), (0, 1), (0, -1)]

    /// BFS steps from every open point to `goal`.
    func distances(to goal: (Int, Int)) -> [Int32] {
        var distance = Array(repeating: Int32.max, count: columns * rows)
        guard isOpen(goal.0, goal.1) else { return distance }
        var queue = [goal.1 * columns + goal.0]
        distance[queue[0]] = 0
        var head = 0
        while head < queue.count {
            let current = queue[head]; head += 1
            let ci = current % columns, cj = current / columns
            for (dx, dy) in Self.moves {
                let ni = ci + dx, nj = cj + dy
                guard isOpen(ni, nj) else { continue }
                let next = nj * columns + ni
                if distance[next] == .max {
                    distance[next] = distance[current] + 1
                    queue.append(next)
                }
            }
        }
        return distance
    }

    /// Shortest 4-direction route between two lattice points (BFS from the goal, then a walk down the distance field
    /// that keeps its heading when it can, so routes have few turns). Returns the corner points, start and goal included.
    func route(from start: (Int, Int), to goal: (Int, Int)) -> [CGPoint]? {
        guard isOpen(start.0, start.1), isOpen(goal.0, goal.1) else { return nil }
        if start == goal { return [point(start.0, start.1)] }
        let distance = distances(to: goal)
        guard distance[start.1 * columns + start.0] != .max else { return nil }
        var points = [point(start.0, start.1)]
        var (i, j) = start
        var heading: (Int, Int)?
        while (i, j) != goal {
            let here = distance[j * columns + i]
            var choice: (Int, Int)?
            if let heading, isOpen(i + heading.0, j + heading.1), distance[(j + heading.1) * columns + i + heading.0] == here - 1 {
                choice = heading
            } else {
                for move in Self.moves where isOpen(i + move.0, j + move.1) && distance[(j + move.1) * columns + i + move.0] == here - 1 {
                    choice = move
                    break
                }
            }
            guard let move = choice else { return nil }
            if let heading, heading != move { points.append(point(i, j)) }
            heading = move
            i += move.0; j += move.1
        }
        points.append(point(goal.0, goal.1))
        return points
    }

    /// Route between two arbitrary points: out through `exit`, across the lattice, in through `approach`, to the goal.
    func route(from start: CGPoint, exit: CGPoint? = nil, to goal: CGPoint, via approach: CGPoint? = nil) -> [CGPoint] {
        var points = [start]
        func add(_ p: CGPoint) {
            if hypot(p.x - points[points.count - 1].x, p.y - points[points.count - 1].y) > 0.5 { points.append(p) }
        }
        if let exit { add(exit) }
        let from = exit ?? start, target = approach ?? goal
        if let a = nearestOpen(to: from), let b = nearestOpen(to: target), let corners = route(from: a, to: b) {
            // Square up the first and last legs so walks stay on straight lines.
            let first = corners[0], last = corners[corners.count - 1]
            if abs(first.x - from.x) > 0.5 && abs(first.y - from.y) > 0.5 { add(CGPoint(x: from.x, y: first.y)) }
            corners.forEach(add)
            if abs(last.x - target.x) > 0.5 && abs(last.y - target.y) > 0.5 { add(CGPoint(x: target.x, y: last.y)) }
        }
        if let approach { add(approach) }
        add(goal)
        return points
    }
}

// MARK: - Build

/// Per-desk facts that change the static art.
struct OfficeDeskDecor: Equatable {
    /// The owner is absent (offline, unknown) or there is no owner yet: the desk recedes.
    var away = false
}

struct OfficeDecor: Equatable {
    var desks: [String: OfficeDeskDecor] = [:]
}

/// The inputs of a layout.
struct OfficeLayoutInput {
    /// Display order (lead first).
    var members: [Member]
    /// Add the empty 팀장 seat.
    var placeholder: Bool
    /// The width available, in points.
    var width: CGFloat
    /// Device pixels per point.
    var displayScale: CGFloat
    /// Mac and regular-width iPad: up to as many columns as fit comfortably. iPhone: 3 columns (4 when that saves a band).
    var wide: Bool
    var decor: OfficeDecor
    /// A forced pixel size (DEBUG review hook).
    var forcedPixel: CGFloat?
}

extension OfficeMap {
    static let deskWidth: CGFloat = 28
    /// Distance between the two facing rows' desk tops (13px desk + 4px of floor).
    static let rowGap: CGFloat = 17
    /// The narrowest column (a desk and 6px of floor), and the width a Mac column likes to have at least.
    static let cellMin = 34
    static let cellComfort = 40
    /// The widest column (a desk and 24px of floor): a team that cannot fill the width at that is centred instead.
    static let cellMax = 52
    /// An iPhone band of 4 needs this much, so walkers still pass between its columns.
    static let cellPhone4 = 42
    /// Wide layouts go above 2.5pt a pixel (up to 3.5pt) only for one band of at least two columns whose scene stays
    /// within this height (points).
    static let boostHeight: CGFloat = 520
    /// Floor between two bands (the bottom row's nameplates and the next top row's).
    static let bandAisle: CGFloat = 12
    /// How far a desk that recedes is faded.
    static let awayOpacity = 0.55

    private struct Entry { let id: String; let memberID: String? }

    /// The scale and the column grid.
    private struct Grid {
        var pixel: CGFloat
        /// Map width in sprite pixels.
        var width: Int
        /// Columns of the grid, and the width of one.
        var columns: Int
        var cell: Int
    }

    /// The scene's height in points with `bands` full bands at pixel size `p` (the same arithmetic as `build`).
    private static func sceneHeight(bands: Int, pixel p: CGFloat, lead: Bool) -> CGFloat {
        let ph = CGFloat(Int((16 / p).rounded(.up)))
        let top: CGFloat = lead ? 56 + ph : 6
        let band = ph + 22 + rowGap + 30 + ph
        return (top + CGFloat(bands) * band + CGFloat(max(0, bands - 1)) * bandAisle + 8) * p
    }

    /// The pixel size (a whole number of device pixels) and the column grid.
    /// - Mac and iPad: as many columns as fit at `cellComfort` (at least 4 when there are that many), the bands
    ///   balanced; the largest pixel up to 2.5pt, or up to 3.5pt for one band of two or more columns within
    ///   `boostHeight`.
    /// - iPhone: 3 columns at the largest pixel up to 2.33pt, or 4 (at `cellPhone4`) when that saves a band or leaves
    ///   fewer empty places in the last one.
    /// Either way one step down in pixel size is taken when it saves a band (or empty places), never more.
    private static func grid(_ input: OfficeLayoutInput, columnsNeeded c: Int, lead: Bool) -> Grid {
        let scale = max(1, input.displayScale.rounded())
        func px(_ points: CGFloat) -> Int { Int((points * scale + 0.01).rounded(.down)) }
        let base = px(input.wide ? 2.5 : 7.0 / 3.0)
        let top = input.wide ? px(3.5) : base
        let bottom = max(1, Int(((input.wide ? 1.5 : 4.0 / 3.0) * scale).rounded()))

        struct Option {
            var grid: Grid
            var bands: Int
            var empty: Int
            var devicePixels: Int
        }
        /// The grid at `k` device pixels a sprite pixel with `n` columns a band (nil: Mac picks), or nil if it does not fit.
        func option(_ k: Int, columns n: Int?, forced: CGFloat? = nil) -> Option? {
            let p = forced ?? CGFloat(k) / scale
            let width = Int((input.width / p).rounded(.down))
            let band = width
            guard band >= 52, forced != nil || k <= base || c >= 2 else { return nil }
            guard c > 0 else {
                return Option(grid: Grid(pixel: p, width: width, columns: 0, cell: band),
                              bands: 0, empty: 0, devicePixels: k)
            }
            let columns: Int
            if let n {
                guard band / n >= (n >= 4 ? cellPhone4 : cellMin) else { return nil }
                columns = n
            } else {
                let fit = band / cellComfort
                guard fit >= min(c, 4) else { return nil }
                let bands = (c + fit - 1) / fit
                columns = (c + bands - 1) / bands
            }
            let bands = (c + columns - 1) / columns
            if forced == nil, k > base {
                guard bands == 1, sceneHeight(bands: 1, pixel: p, lead: lead) <= boostHeight else { return nil }
            }
            return Option(grid: Grid(pixel: p, width: width, columns: columns, cell: min(band / columns, cellMax)),
                          bands: bands, empty: bands * columns - c, devicePixels: k)
        }

        let choices: [Int?] = input.wide || c == 0 ? [nil] : (c >= 4 ? [3, 4] : [c])
        var options: [Option] = []
        if let forced = input.forcedPixel {
            options = choices.compactMap { option(0, columns: $0, forced: forced) }
        } else {
            // Per column choice: the largest pixel that fits, and the one a step below it.
            for n in choices {
                guard let first = stride(from: top, through: bottom, by: -1).lazy.compactMap({ option($0, columns: n) }).first
                else { continue }
                options.append(first)
                if first.devicePixels > bottom, let next = option(first.devicePixels - 1, columns: n) { options.append(next) }
            }
        }
        if let largest = options.map(\.devicePixels).max() {
            // Within a step of the largest pixel: fewest bands, then fewest empty places, then the larger pixel.
            let pick = options.filter { $0.devicePixels >= largest - 1 }.min { a, b in
                (a.bands, a.empty, -a.devicePixels) < (b.bands, b.empty, -b.devicePixels)
            }
            if let pick { return pick.grid }
        }
        // Very narrow: the smallest pixel, as many columns as fit.
        let p = input.forcedPixel ?? CGFloat(bottom) / scale
        let width = max(60, Int((input.width / p).rounded(.down)))
        let band = max(34, width)
        let n = c == 0 ? 0 : max(1, min(c, band / cellMin))
        return Grid(pixel: p, width: width, columns: n, cell: n == 0 ? band : band / n)
    }

    static func build(_ input: OfficeLayoutInput) -> OfficeMap {
        let leadMember = input.members.first { $0.kind != "worker" }
        var seats = input.members.filter { $0.id != leadMember?.id }.map { Entry(id: $0.id, memberID: $0.id) }
        if input.placeholder { seats.append(Entry(id: "office-placeholder", memberID: nil)) }
        return build(input, lead: leadMember, seats: seats)
    }

    private static func build(_ input: OfficeLayoutInput, lead leadMember: Member?, seats: [Entry]) -> OfficeMap {
        var map = OfficeMap()
        let n = seats.count
        let c = (n + 1) / 2
        let grid = grid(input, columnsNeeded: c, lead: leadMember != nil)
        let p = grid.pixel
        let ph = CGFloat(Int((16 / p).rounded(.up)))
        map.pixel = p
        map.plateHeight = Int(ph)
        let mapW = CGFloat(grid.width)
        let bandArea = mapW
        let bandsW = grid.columns > 0 ? CGFloat(grid.columns * grid.cell) : bandArea
        // Leftover pixels (a few, or the room a small team cannot fill at `cellMax`) go evenly to the sides.
        let bandX = ((bandArea - bandsW) / 2).rounded(.down)
        let centerX = (bandX + bandsW / 2).rounded(.down)
        let cell = CGFloat(grid.cell)

        var items: [OfficeFurniture] = []
        var blockers: [CGRect] = []
        var shadows: [CGRect] = []
        func away(_ entry: String) -> Bool { input.decor.desks[entry]?.away ?? true }

        // The lead.
        var rowTop: CGFloat = 6
        if let lead = leadMember {
            let ly: CGFloat = 32
            let lx = centerX - 23
            let cx = lx + 23
            let isAway = away(lead.id)
            map.desks.append(OfficeDesk(
                id: lead.id, memberID: lead.id, row: .lead, origin: CGPoint(x: lx, y: ly),
                seat: CGPoint(x: cx, y: ly), arrive: CGPoint(x: cx, y: ly + 1), approach: CGPoint(x: lx - 6, y: ly - 2),
                cell: CGRect(x: lx - 2, y: ly - 29, width: 51, height: 45),
                plate: OfficePlateSlot(center: cx, minX: 2, maxX: bandArea - 2, y: ly + 16, above: false),
                screen: nil, away: isAway))
            var canvas = PixelCanvas(x: Int(lx), y: Int(ly) - 28, width: 47, height: 42)
            if isAway { canvas.stamp(OfficeArt.chairLead, x: Int(cx) - 12, y: Int(ly) - 28) }
            canvas.stamp(OfficeArt.deskLead, x: Int(lx), y: Int(ly))
            if isAway {
                canvas.stamp(OfficeArt.monitorBack, x: Int(lx) + 3, y: Int(ly) - 8)
                canvas.stamp(OfficeArt.monitorBack, x: Int(lx) + 32, y: Int(ly) - 8)
            }
            items.append(OfficeFurniture(bounds: CGRect(x: lx, y: ly - 28, width: 47, height: 42), sortY: ly + 14,
                                         art: canvas.art(opacity: isAway ? awayOpacity : 1)))
            shadows.append(CGRect(x: lx + 1, y: ly + 12, width: 45, height: 3))
            blockers.append(CGRect(x: lx, y: ly - 26, width: 47, height: 40))
            rowTop = ly + 16 + ph + 8
        }

        // The bands: a column at a time (the top seat, then the bottom seat facing it), `grid.columns` columns a band.
        // A band with fewer columns is centred on the same grid.
        var bottom = leadMember == nil ? rowTop : rowTop - 8
        if c > 0 {
            let perBand = max(1, grid.columns)
            let bands = (c + perBand - 1) / perBand
            var column = 0
            for _ in 0..<bands {
                let k = min(perBand, c - column)
                let offset = (CGFloat(perBand - k) * cell / 2).rounded(.down)
                let ty = rowTop + ph + 22
                let by = ty + rowGap
                let facing = (0..<k).contains { 2 * (column + $0) + 1 < n }
                let rowBottom = facing ? by + 30 + ph : ty + 14
                for j in 0..<k {
                    let cellX = bandX + offset + CGFloat(j) * cell
                    let dx = cellX + ((cell - deskWidth) / 2).rounded(.down)
                    let sx = dx + 14
                    let minX = cellX + 1, maxX = cellX + cell - 1
                    for isTop in [true, false] {
                        let s = 2 * (column + j) + (isTop ? 0 : 1)
                        guard s < n else { continue }
                        let entry = seats[s]
                        let isAway = away(entry.id)
                        let index = map.desks.count
                        if isTop {
                            map.desks.append(OfficeDesk(
                                id: entry.id, memberID: entry.memberID, row: .top, origin: CGPoint(x: dx, y: ty),
                                seat: CGPoint(x: sx, y: ty), arrive: CGPoint(x: sx, y: ty + 1),
                                approach: CGPoint(x: sx, y: rowTop - 4),
                                cell: CGRect(x: dx - 2, y: ty - 21, width: 32, height: 32),
                                plate: OfficePlateSlot(center: sx, minX: minX, maxX: maxX, y: ty - 23, above: true),
                                screen: nil, away: isAway))
                            var canvas = PixelCanvas(x: Int(dx), y: Int(ty) - 13, width: 28, height: 26)
                            if isAway { canvas.stamp(OfficeArt.chairFront, x: Int(dx) + 6, y: Int(ty) - 13) }
                            canvas.stamp(OfficeArt.desk, x: Int(dx), y: Int(ty))
                            if isAway { canvas.stamp(OfficeArt.lid, x: Int(dx) + 9, y: Int(ty) - 2) }
                            items.append(OfficeFurniture(bounds: CGRect(x: dx, y: ty - 13, width: 28, height: 26), sortY: ty + 13,
                                                         art: canvas.art(opacity: isAway ? awayOpacity : 1)))
                            shadows.append(CGRect(x: dx + 1, y: ty + 12, width: 26, height: 2))
                        } else {
                            map.desks.append(OfficeDesk(
                                id: entry.id, memberID: entry.memberID, row: .bottom, origin: CGPoint(x: dx, y: by),
                                seat: CGPoint(x: sx, y: by + 22), arrive: CGPoint(x: sx, y: by + 23),
                                approach: CGPoint(x: sx, y: rowBottom + 4),
                                cell: CGRect(x: dx - 2, y: by - 6, width: 32, height: 36),
                                plate: OfficePlateSlot(center: sx, minX: minX, maxX: maxX, y: by + 30, above: false),
                                screen: CGRect(x: dx + 7, y: by - 6, width: 14, height: 5), away: isAway))
                            var canvas = PixelCanvas(x: Int(dx), y: Int(by) - 8, width: 28, height: 21)
                            canvas.stamp(OfficeArt.desk, x: Int(dx), y: Int(by))
                            canvas.stamp(OfficeArt.monitor, x: Int(dx) + 5, y: Int(by) - 8)
                            canvas.stamp(OfficeArt.keyboard, x: Int(dx) + 8, y: Int(by) + 3)
                            items.append(OfficeFurniture(bounds: CGRect(x: dx, y: by - 8, width: 28, height: 21), sortY: by + 12,
                                                         art: canvas.art(opacity: isAway ? awayOpacity : 1), desk: index))
                            if isAway {
                                // Pushed in under the desk front, as the top row tucks its empty chair behind its desk.
                                var chair = PixelCanvas(x: Int(dx) + 7, y: Int(by) + 11, width: 14, height: 11)
                                chair.stamp(OfficeArt.chairBack, x: Int(dx) + 7, y: Int(by) + 11)
                                items.append(OfficeFurniture(bounds: CGRect(x: dx + 7, y: by + 11, width: 14, height: 11),
                                                             sortY: by + 21, art: chair.art(opacity: awayOpacity)))
                            }
                            shadows.append(CGRect(x: dx + 1, y: by + 12, width: 26, height: 2))
                        }
                    }
                    // A column, nameplates included, is one block for walkers (as wide as its hit area): they cross a
                    // band only in the floor between columns, and step through a nameplate row only at their own column.
                    let columnBottom = 2 * (column + j) + 1 < n ? rowBottom : ty + 14
                    blockers.append(CGRect(x: dx - 2, y: rowTop - 1, width: 32, height: columnBottom - rowTop + 2))
                }
                column += k
                bottom = rowBottom
                rowTop = rowBottom + bandAisle
            }
        }

        let height = (bottom + 8).rounded(.up)
        map.size = CGSize(width: mapW, height: height)
        map.furniture = items.sorted { $0.sortY < $1.sortY }
        var shade = PixelCanvas(x: 0, y: 0, width: Int(mapW), height: Int(height))
        for r in shadows {
            // Soft corners: the end pixels of each band are left out.
            shade.fill(Int(r.minX) + 1, Int(r.minY), Int(r.width) - 2, Int(r.height), OfficePalette.shadowSolid)
            shade.fill(Int(r.minX), Int(r.minY) + 1, Int(r.width), max(0, Int(r.height) - 2), OfficePalette.shadowSolid)
        }
        map.shadows = shade.art()
        map.shadows.opacity = 0.28

        // Walk lattice.
        var lattice = OfficeWalkGrid()
        lattice.columns = Int(mapW / OfficeWalkGrid.step) + 1
        lattice.rows = Int(height / OfficeWalkGrid.step) + 1
        lattice.open = Array(repeating: false, count: lattice.columns * lattice.rows)
        for j in 0..<lattice.rows {
            for i in 0..<lattice.columns {
                let point = lattice.point(i, j)
                guard point.x >= 4, point.x <= mapW - 4, point.y >= 6, point.y <= height - 2 else { continue }
                let foot = CGRect(x: point.x - 4, y: point.y - 2, width: 8, height: 3)
                lattice.open[j * lattice.columns + i] = !blockers.contains { $0.intersects(foot) }
            }
        }
        map.walk = lattice

        map.layout = ["\(grid.width)", "\(p)", "\(grid.columns)x\(grid.cell)", input.wide ? "W" : "N",
                      "\(Int(ph))", map.desks.map(\.id).joined(separator: ",")].joined(separator: "|")
        return map
    }
}

// MARK: - Seating

/// Who has a desk. The lead always does; of everyone else at most `workerDesks` do. Members who need the CEO or are
/// working come first, then the most recently active (their CLI's last turn or tool call); the longest unused give up
/// their desks. Desks keep the members' display order, so seating never shuffles who sits where among the seated.
enum OfficeSeating {
    static let workerDesks = 10

    /// - Returns: the members with a desk, in `members` order, and the rest, most recently active first.
    static func split(_ members: [Member], limit: Int = workerDesks) -> (seated: [Member], benched: [Member]) {
        let workers = members.filter { $0.kind == "worker" }
        guard workers.count > limit else { return (members, []) }
        let ranked = workers.enumerated().sorted { a, b in
            let (pa, pb) = (priority(a.element), priority(b.element))
            if pa != pb { return pa < pb }
            let (ta, tb) = (lastActive(a.element), lastActive(b.element))
            if ta != tb { return ta > tb }
            return a.offset < b.offset
        }
        let kept = Set(ranked.prefix(limit).map(\.element.id))
        let seated = members.filter { $0.kind != "worker" || kept.contains($0.id) }
        let benched = ranked.dropFirst(limit).map(\.element)
        return (seated, benched)
    }

    /// 0: needs the CEO or is working, so it must be seen at a desk. 1: everyone else.
    private static func priority(_ member: Member) -> Int {
        ["working", "waiting", "blocked", "error"].contains(member.status) ? 0 : 1
    }

    /// An ISO-8601 time that sorts as text (older servers: when the member last said what it was doing). "" = never.
    private static func lastActive(_ member: Member) -> String {
        member.lastActiveAt ?? member.nowAt ?? ""
    }
}
