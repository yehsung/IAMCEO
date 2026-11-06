import SwiftUI

// Who is where. A member's placement follows its CLI state; positions are pure functions of
// (map, placement, walk plan, time), so drawing, hit-testing and accessibility all agree. Only walk plans are state.

enum OfficeSeatMood: Equatable, Sendable { case working, waiting, blocked, error }

enum OfficePlacement: Equatable, Sendable {
    /// At its desk: typing, waiting for an answer (top row: looks up; bottom row: turns its chair around), waving at
    /// an approval prompt (turned around too in the bottom row), or collapsed on an error.
    case seat(Int, OfficeSeatMood)
    /// On a chair in the rest area (index into `OfficeMap.rests`): on a break (쉬는 중) or dozing (잠듦).
    case rest(Int, asleep: Bool)
    /// Offline or unknown: not drawn.
    case hidden
}

struct OfficeCast: Equatable {
    var signature = ""
    var placements: [String: OfficePlacement] = [:]
    /// The body colour of each drawn member: its state (walking residents wear the state they walk into).
    var tones: [String: OfficeTone] = [:]
    /// Members in display order.
    var ids: [String] = []

    /// - previous: the cast drawn so far. On the same desks, residents that stay in the rest area keep their chairs,
    ///   so one member's change never makes the others get up and move.
    static func build(map: OfficeMap, members: [Member], previous: OfficeCast? = nil) -> OfficeCast {
        var cast = OfficeCast(signature: map.layout)
        cast.ids = members.map(\.id)
        let prior = previous.flatMap { $0.signature == map.layout ? $0.placements : nil } ?? [:]
        let resting = members.filter { $0.status == "idle" || $0.status == "asleep" }.map { (id: $0.id, asleep: $0.status == "asleep") }
        let spots = restSpots(resting, count: map.rests.count, prior: prior)
        for member in members {
            guard let desk = map.desks.firstIndex(where: { $0.memberID == member.id }) else { continue }
            let placement: OfficePlacement
            switch member.status {
            case "working": placement = .seat(desk, .working)
            case "waiting": placement = .seat(desk, .waiting)
            case "error": placement = .seat(desk, .error)
            case "blocked": placement = .seat(desk, .blocked)
            case "idle": placement = spots[member.id].map { .rest($0, asleep: false) } ?? .hidden
            case "asleep": placement = spots[member.id].map { .rest($0, asleep: true) } ?? .hidden
            default: placement = .hidden
            }
            cast.placements[member.id] = placement
            if let tone = OfficeTone(status: member.status) { cast.tones[member.id] = tone }
        }
        return cast
    }

    /// Chairs in the rest area per resting member. Members already resting keep theirs (a break turning into sleep
    /// stays put); newcomers take the first free chair. More residents than chairs share the last one.
    static func restSpots(_ resting: [(id: String, asleep: Bool)], count: Int, prior: [String: OfficePlacement]) -> [String: Int] {
        guard count > 0 else { return [:] }
        var spots: [String: Int] = [:]
        var taken = Set<Int>()
        for (id, _) in resting {
            if case .rest(let spot, _)? = prior[id], spot >= 0, spot < count, !taken.contains(spot) {
                spots[id] = spot
                taken.insert(spot)
            }
        }
        var next = 0
        for (id, _) in resting where spots[id] == nil {
            while next < count && taken.contains(next) { next += 1 }
            let spot = min(next, count - 1)
            spots[id] = spot
            taken.insert(spot)
        }
        return spots
    }
}

enum OfficeFacing: Sendable { case down, up, left, right }

/// A walk along lattice lines (or, with Reduce Motion, a 0.2s crossfade between two spots).
struct OfficeWalkPlan: Equatable {
    static let speed: Double = 44   // sprite pixels per second
    /// Distance per walk frame: 4 frames a stride at about 8 fps.
    static let stride: Double = 5.5

    var points: [CGPoint]
    var start: Double
    var fade = false
    var signature: String

    var length: Double {
        zip(points, points.dropFirst()).reduce(0) { $0 + Double(hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y)) }
    }
    var duration: Double { fade ? 0.2 : length / Self.speed }
    var end: Double { start + duration }

    /// Position, heading and distance walked at time `t`.
    func sample(_ t: Double) -> (point: CGPoint, facing: OfficeFacing, travelled: Double) {
        let travelled = max(0, t - start) * Self.speed
        guard var previous = points.first else { return (.zero, .down, 0) }
        var remaining = travelled
        var facing = OfficeFacing.down
        for next in points.dropFirst() {
            let dx = next.x - previous.x, dy = next.y - previous.y
            let segment = Double(hypot(dx, dy))
            facing = abs(dx) > abs(dy) ? (dx > 0 ? .right : .left) : (dy > 0 ? .down : .up)
            if remaining <= segment, segment > 0 {
                let f = CGFloat(remaining / segment)
                return (CGPoint(x: previous.x + dx * f, y: previous.y + dy * f), facing, travelled)
            }
            remaining -= segment
            previous = next
        }
        return (previous, facing, travelled)
    }
}

enum OfficeEmote: Equatable, Sendable { case question, approval, error, sleep }

/// One resident as drawn at one moment.
struct OfficeActor {
    enum Pose: Equatable {
        case walking
        /// Seated at desk `desk`.
        case atDesk(Int)
        /// On a chair in the rest area.
        case resting
    }
    let id: String
    /// Where the frame's anchor goes (sprite pixels).
    var point: CGPoint
    var frame: OfficeFrame
    /// The body colour.
    var tone: OfficeTone
    var mirrored = false
    var alpha: Double = 1
    var blink = false
    var pose: Pose
    var emote: OfficeEmote?
    /// Sweat drop beside the head (an error).
    var sweat = false
    /// A working resident's sparkle now and then (0 = none, else sparkle frame 1 or 2).
    var sparkle = 0
    var phase: Double = 0
    /// Draw order against furniture and other residents.
    var sortY: CGFloat
    /// Where a walk from here starts.
    var walkPoint: CGPoint

    var desk: Int? {
        if case .atDesk(let d) = pose { return d }
        return nil
    }

    /// Hopping across the floor (drawn with a shadow; furniture in front covers it again).
    var onFoot: Bool { pose == .walking }

    /// The head point in the scene (accessories attach there; bubbles, sweat and z's go beside it).
    var head: CGPoint { OfficeResident.head(frame, at: point, mirrored: mirrored) }
}

enum OfficeStage {
    /// A hop cycle: 0 squash on landing, 1 stretch on take-off, 2 the top of the hop, 3 coming down.
    static func walkFrame(_ facing: OfficeFacing, travelled: Double) -> (OfficeFrame, Bool) {
        let step = Int(travelled / OfficeWalkPlan.stride) % 4
        switch facing {
        case .down: return ([OfficeFrame.walkFront0, .walkFront1, .walkFront2, .walkFront3][step], false)
        case .up: return ([OfficeFrame.walkBack0, .walkBack1, .walkBack2, .walkBack3][step], false)
        case .left: return ([OfficeFrame.walkSide0, .walkSide1, .walkSide2, .walkSide3][step], false)
        case .right: return ([OfficeFrame.walkSide0, .walkSide1, .walkSide2, .walkSide3][step], true)
        }
    }

    private static func frac(_ v: Double) -> Double { v - v.rounded(.down) }

    /// Frame `k` of a looping animation at `fps` (frame 0 with Reduce Motion).
    private static func beat(_ frames: [OfficeFrame], fps: Double, t: Double, phase: Double, still: Bool) -> OfficeFrame {
        guard !still, frames.count > 1 else { return frames[0] }
        return frames[Int((t + phase * 7) * fps) % frames.count]
    }

    /// The resident `id` at time `t`. `still` = Reduce Motion (no walking, typing, waving, blinking or breathing).
    static func actor(_ id: String, placement: OfficePlacement, tone: OfficeTone, plan: OfficeWalkPlan?, map: OfficeMap,
                      t: Double, still: Bool) -> OfficeActor? {
        if case .hidden = placement { return nil }
        let phase = Double(officeHash(id) % 997) / 997
        let plan = plan?.signature == map.layout ? plan : nil
        // A plan owns the resident from the moment it exists: a frame drawn with a timeline date from just before the
        // plan started shows it at the start of the walk, never already at the destination.
        if let plan, t < plan.end {
            if plan.fade {
                let p = max(0, (t - plan.start) / max(plan.duration, 0.01))
                if p < 0.5 {
                    let at = plan.points.first ?? .zero
                    return OfficeActor(id: id, point: at, frame: .standFront, tone: tone, alpha: 1 - p * 2, pose: .walking,
                                       phase: phase, sortY: at.y, walkPoint: at)
                }
                var arrived = settled(id, placement: placement, tone: tone, map: map, t: t, still: still, phase: phase)
                arrived?.alpha = (p - 0.5) * 2
                return arrived
            }
            let sample = plan.sample(t)
            let (frame, mirrored) = walkFrame(sample.facing, travelled: sample.travelled)
            let at = CGPoint(x: sample.point.x.rounded(), y: sample.point.y.rounded())
            let blink = frac((t + phase * 9) / 3.9) < 0.03
            return OfficeActor(id: id, point: at, frame: frame, tone: tone, mirrored: mirrored, blink: blink, pose: .walking,
                               phase: phase, sortY: at.y, walkPoint: sample.point)
        }
        return settled(id, placement: placement, tone: tone, map: map, t: t, still: still, phase: phase)
    }

    private static func settled(_ id: String, placement: OfficePlacement, tone: OfficeTone, map: OfficeMap, t: Double,
                                still: Bool, phase: Double) -> OfficeActor? {
        // About 120 ms every ~4 s.
        let blink = !still && frac((t + phase * 9) / 3.9) < 0.03
        switch placement {
        case .hidden:
            return nil
        case .seat(let d, let mood):
            guard map.desks.indices.contains(d) else { return nil }
            let desk = map.desks[d]
            let front = desk.row != .bottom
            let frame: OfficeFrame
            var emote: OfficeEmote?
            var sparkle = 0
            switch mood {
            case .working:
                // Paws tap at 4 fps: rest, one, rest, the other.
                frame = beat(front ? [.deskFrontType0, .deskFrontType1, .deskFrontType0, .deskFrontType2]
                                   : [.deskBackType0, .deskBackType1, .deskBackType0, .deskBackType2],
                             fps: 4, t: t, phase: phase, still: still)
                // A twinkle beside the head once every 4-6 s: small, big, small (6 fps).
                if !still {
                    let period = 4 + phase * 2
                    let local = (t + phase * 31).truncatingRemainder(dividingBy: period)
                    if local < 0.5 { sparkle = Int(local * 6) == 1 ? 2 : 1 }
                }
            case .waiting:
                // Top row looks up hopefully, swaying a pixel; the bottom row turns around on its chair.
                frame = beat(front ? [.deskFrontWait0, .deskFrontWait1] : [.chairWait0, .chairWait1],
                             fps: 1.5, t: t, phase: phase, still: still)
                emote = .question
            case .blocked:
                // A flipper raised and waving, a pixel of urgent bounce.
                frame = beat(front ? [.deskFrontBlocked0, .deskFrontBlocked1] : [.chairBlocked0, .chairBlocked1],
                             fps: 3, t: t, phase: phase, still: still)
                emote = .approval
            case .error:
                frame = front ? .deskFrontError : .deskBackError
                emote = .error
            }
            return OfficeActor(id: id, point: desk.seat, frame: frame, tone: tone, blink: blink && frame.blinks,
                               pose: .atDesk(d), emote: emote, sweat: mood == .error, sparkle: sparkle, phase: phase,
                               sortY: desk.seat.y, walkPoint: desk.arrive)
        case .rest(let i, let asleep):
            guard map.rests.indices.contains(i) else { return nil }
            let spot = map.rests[i]
            if asleep {
                // Melted into the armchair, nodding a pixel.
                return OfficeActor(id: id, point: spot.point, frame: beat([.restSleep0, .restSleep1], fps: 0.7, t: t, phase: phase, still: still),
                                   tone: tone, pose: .resting, emote: .sleep, phase: phase, sortY: spot.point.y, walkPoint: spot.arrive)
            }
            // Content (^ ^), breathing.
            return OfficeActor(id: id, point: spot.point, frame: beat([.restIdle0, .restIdle1], fps: 0.8, t: t, phase: phase, still: still),
                               tone: tone, pose: .resting, phase: phase, sortY: spot.point.y, walkPoint: spot.arrive)
        }
    }

    // MARK: Plans

    /// The walk (or crossfade) from where the resident is now to its new placement. nil = just appear there.
    static func plan(_ id: String, from current: OfficeActor?, old: OfficePlacement?, to new: OfficePlacement, map: OfficeMap,
                     t: Double, still: Bool) -> OfficeWalkPlan? {
        guard let current else { return nil }
        let start = current.walkPoint
        let goal: CGPoint
        let approach: CGPoint?
        switch new {
        case .hidden:
            return nil
        case .seat(let d, _):
            guard map.desks.indices.contains(d) else { return nil }
            goal = map.desks[d].arrive
            approach = map.desks[d].approach
        case .rest(let i, _):
            guard map.rests.indices.contains(i) else { return nil }
            goal = map.rests[i].arrive
            approach = map.rests[i].approach
        }
        // Staying at the same desk (typing -> waving -> waiting …) is not a walk.
        if case .seat(let a, _)? = old, case .seat(let b, _) = new, a == b, current.pose != .walking { return nil }
        if hypot(goal.x - start.x, goal.y - start.y) < 0.5 { return nil }
        if still {
            return OfficeWalkPlan(points: [current.point, goal], start: t, fade: true, signature: map.layout)
        }
        // Leave a desk or a chair the way it was entered: straight out to its aisle point.
        var exit: CGPoint?
        if current.pose != .walking {
            switch old {
            case .seat(let d, _)? where map.desks.indices.contains(d): exit = map.desks[d].approach
            case .rest(let i, _)? where map.rests.indices.contains(i): exit = map.rests[i].approach
            default: break
            }
        }
        let points = map.walk.route(from: start, exit: exit, to: goal, via: approach)
        return OfficeWalkPlan(points: points, start: t, signature: map.layout)
    }
}

/// The clock of the moving layer: `fast` while anyone walks to a new place, `slow` otherwise (typing, code lines,
/// z's and bubbles read fine at that rate), one frame when paused, and one per second in low-frequency mode.
struct OfficeCadence: TimelineSchedule, Sendable {
    var paused = false
    var fast: Double = 1.0 / 30
    var slow: Double = 1.0 / 12
    /// Walks to a new place, in reference-date seconds.
    var walks: [ClosedRange<Double>] = []

    func isFast(_ t: Double) -> Bool {
        // Look one slow step ahead so a walk never starts between two slow frames.
        let ahead = t + slow
        return walks.contains { $0.lowerBound <= ahead && t <= $0.upperBound + 0.05 }
    }

    struct Entries: Sequence, IteratorProtocol {
        let cadence: OfficeCadence
        let low: Bool
        var date: Date?

        mutating func next() -> Date? {
            guard let current = date else { return nil }
            if cadence.paused {
                date = nil
            } else {
                let step = low ? 1 : cadence.isFast(current.timeIntervalSinceReferenceDate) ? cadence.fast : cadence.slow
                date = current.addingTimeInterval(step)
            }
            return current
        }
    }

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(cadence: self, low: mode == .lowFrequency, date: startDate)
    }
}
