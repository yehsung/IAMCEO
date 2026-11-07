import SwiftUI

/// Design tokens. Content sits on calm plates; glass is reserved for chrome (sidebar, toolbar, tab bar, composer, sticky bars).
/// Tokens copied from the web client (web/src/styles/tokens.css), which the owner prefers.
enum CE {
    static let bg = Color(hex: 0x090713)
    static let bgDeep = Color(hex: 0x05040B)
    static let plateSolid = Color(hex: 0x16112C)
    static let plateRaisedSolid = Color(hex: 0x1D1638)
    static let plate = Color.white.opacity(0.045)
    static let plateRaised = Color.white.opacity(0.08)
    static let line = Color.white.opacity(0.08)
    static let lineStrong = Color.white.opacity(0.14)
    static let ink = Color(hex: 0xF5F2FF)
    static let ink2 = Color(hex: 0xC2BBDF)
    static let ink3 = Color(hex: 0x8F88B2)
    static let accent = Color(hex: 0xB9A8FF)       // --focus: links, selection rings
    static let accentFill = Color(hex: 0x6D4DF2)   // --accent-fill: fills under white text (badges, send)
    static let violet = Color(hex: 0x7A5BFF)
    static let orchid = Color(hex: 0xB35CFF)
    static let indigo = Color(hex: 0x3D45FF)
    static let rose = Color(hex: 0xFF6FB8)
    static let ice = Color(hex: 0xA8ECFF)
    // Member states (--st-*) and semantic text colours (--ok/--warn/--danger)
    static let live = Color(hex: 0xB9A8FF)         // 일하는 중
    static let attention = Color(hex: 0xFFB070)    // 내 답 기다림
    static let approval = Color(hex: 0xFF8A80)     // 승인 창 앞
    static let danger = Color(hex: 0xFF8A9B)       // 오류 · 실패 (text)
    static let error = Color(hex: 0xFF5A62)        // 오류 dot
    static let success = Color(hex: 0x6FE3B2)      // 받음 · 완료
    static let warn = Color(hex: 0xFFC773)         // 보류
    static let idle = Color(hex: 0xA6A6AE)         // 대기
    static let dim = Color(hex: 0x8F88B2)          // 잠듦 · 안 보임 (hollow ring)
    /// Primary button gradient (web .gbtn--primary).
    static let primaryGradient = LinearGradient(colors: [Color(red: 134/255, green: 104/255, blue: 252/255).opacity(0.88), Color(red: 104/255, green: 68/255, blue: 246/255).opacity(0.84), Color(red: 92/255, green: 54/255, blue: 234/255).opacity(0.88)], startPoint: .top, endPoint: .bottom)
    /// Text-heavy glass tint (web .glass-tint: rgb(9 7 19 / .52)).
    static let glassTint = Color(red: 9/255, green: 7/255, blue: 19/255)
    /// Card tint, used at 55%. The web card is rgb(12 9 28 / .6) over a `saturate(175%)` backdrop; SwiftUI has no
    /// backdrop saturation, so the tint carries the blue that saturation adds to the violet aurora (measured on screen:
    /// card interiors land on the web's dark, saturated violet instead of a neutral navy).
    static let cardTint = Color(red: 13/255, green: 8/255, blue: 46/255)
}

/// Semantic tone: color carries meaning, never decoration.
enum Tone: Sendable, Equatable {
    case neutral, accent, live, attention, approval, danger, success, dim
    var color: Color {
        switch self {
        case .neutral: CE.idle
        case .accent: CE.accent
        case .live: CE.live
        case .attention: CE.attention
        case .approval: CE.approval
        case .danger: CE.danger
        case .success: CE.success
        case .dim: CE.dim
        }
    }
}

extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}

/// macOS uses fixed compact sizes for a dense desk; iOS uses Dynamic Type styles.
/// Web type scale (base 15px). macOS uses the same point sizes; iOS maps to Dynamic Type styles of the same size.
enum CEFont {
    #if os(macOS)
    static let pageTitle: Font = .system(size: 17, weight: .semibold)
    static let title: Font = .system(size: 16.5, weight: .semibold)
    static let section: Font = .system(size: 14, weight: .semibold)
    static let rowTitle: Font = .system(size: 14.5, weight: .semibold)
    static let body: Font = .system(size: 14.5)
    /// Notes, hints, errors and status lines (web 13.5px: .tm-note, .form__error, .offline-band).
    static let note: Font = .system(size: 13.5)
    /// Row sub-lines (web 13px: .hm-row__sub, .fl-row__summary).
    static let secondary: Font = .system(size: 13)
    /// Meta, times, hints (web 12.5px, the most common small size).
    static let meta: Font = .system(size: 12.5)
    /// Counts and rail sub-lines, the few places the web really uses 12px.
    static let caption: Font = .system(size: 12)
    static let micro: Font = .system(size: 11.5, weight: .bold)
    static let mono: Font = .system(size: 12.5, design: .monospaced)
    static let number: Font = .system(size: 20, weight: .semibold, design: .rounded)
    #else
    static let pageTitle: Font = .headline
    static let title: Font = .headline
    static let section: Font = .subheadline.weight(.semibold)
    static let rowTitle: Font = .subheadline.weight(.semibold)
    static let body: Font = .subheadline
    static let note: Font = .footnote
    static let secondary: Font = .footnote
    static let meta: Font = .caption
    static let caption: Font = .caption
    static let micro: Font = .caption2.weight(.bold)
    static let mono: Font = .system(.caption, design: .monospaced)
    static let number: Font = .system(.title2, design: .rounded, weight: .semibold)
    #endif

    /// Markdown headings inside reports, decisions and documents: each level clearly above the reading size.
    #if os(macOS)
    static let heading1: Font = .system(size: 16, weight: .semibold)
    static let heading2: Font = .system(size: 14.5, weight: .semibold)
    static let heading3: Font = .system(size: 13.5, weight: .semibold)
    #else
    static let heading1: Font = .title3.weight(.semibold)
    static let heading2: Font = .headline
    static let heading3: Font = .callout.weight(.semibold)
    #endif
}

/// Line height. SwiftUI's `lineSpacing` is extra space on top of the system font's own line (~1.2), so a web
/// `line-height: L` on `size`-point text becomes `size * (L - 1.2)`. Every Text that can wrap gets one of these:
/// without it multi-line text renders at ~1.2, 2.5-5pt per line tighter than the web.
enum CELeading {
    static func spacing(_ size: CGFloat, _ lineHeight: CGFloat) -> CGFloat {
        max(0, ((size * (lineHeight - 1.2)) * 2).rounded() / 2)
    }
    /// 14.5 at 1.5 (body paragraphs, row text).
    static let body = spacing(14.5, 1.5)
    /// 13.5 at 1.45 (notes, errors, hints).
    static let note = spacing(13.5, 1.45)
    /// 13 at 1.45 (row sub-lines).
    static let secondary = spacing(13, 1.45)
    /// 12.5 at 1.4 (meta lines that wrap).
    static let meta = spacing(12.5, 1.4)
    /// 16 at 1.35 (titles that wrap).
    static let title = spacing(16, 1.35)
}

extension View {
    /// The web line height `lineHeight` for `size`-point text (see `CELeading`).
    func ceLineHeight(_ size: CGFloat, _ lineHeight: CGFloat) -> some View {
        lineSpacing(CELeading.spacing(size, lineHeight))
    }
}

enum CESpace {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 28
}

enum CERadius {
    static let plate: CGFloat = 22     // web .glass--regular
    static let card: CGFloat = 18      // web inner cards (.tm-card, .ibx-card)
    static let control: CGFloat = 12   // inputs, option tiles
    static let row: CGFloat = 10       // list rows
}

#if os(macOS)
let isMac = true
#else
let isMac = false
#endif

/// Web AuroraField: five soft blobs (violet, orchid, indigo, violet, rose) at strength k = .85 over #090713. Static.
struct AmbientBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private struct Blob { let r, g, b: Double; let a: Double; let x, y, w, h: Double }
    private let blobs: [Blob] = [
        Blob(r: 122, g: 91, b: 255, a: 0.50, x: 0.66, y: 0.34, w: 0.92, h: 0.68),
        Blob(r: 179, g: 92, b: 255, a: 0.34, x: 0.92, y: 0.08, w: 0.54, h: 0.42),
        Blob(r: 61, g: 69, b: 255, a: 0.42, x: 0.20, y: 0.96, w: 0.86, h: 0.56),
        Blob(r: 122, g: 91, b: 255, a: 0.24, x: 0.04, y: 0.30, w: 0.52, h: 0.52),
        Blob(r: 255, g: 111, b: 184, a: 0.13, x: 0.80, y: 0.84, w: 0.32, h: 0.24),
    ]
    var body: some View {
        GeometryReader { geo in
            let vmax = max(geo.size.width, geo.size.height)
            ZStack {
                CE.bg
                RadialGradient(colors: [CE.indigo.opacity(0.14), .clear], center: UnitPoint(x: 0.5, y: 1.15), startRadius: 0, endRadius: vmax * 0.7)
                if !reduceTransparency {
                    ForEach(blobs.indices, id: \.self) { index in
                        let blob = blobs[index]
                        let color = Color(red: blob.r / 255, green: blob.g / 255, blue: blob.b / 255)
                        let a = blob.a * 0.85
                        Ellipse()
                            .fill(EllipticalGradient(stops: [
                                .init(color: color.opacity(a), location: 0),
                                .init(color: color.opacity(a * 0.5), location: 0.4),
                                .init(color: color.opacity(a * 0.16), location: 0.68),
                                .init(color: color.opacity(0), location: 1),
                            ]))
                            .frame(width: vmax * blob.w, height: vmax * blob.h)
                            .position(x: geo.size.width * blob.x, y: geo.size.height * blob.y)
                    }
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The web glass rim: bright top-left edge, faint ice glow bottom-right.
struct GlassRim<S: InsettableShape>: View {
    let shape: S
    var strong = false
    var body: some View {
        shape.strokeBorder(
            LinearGradient(stops: [
                .init(color: .white.opacity(strong ? 0.62 : 0.5), location: 0),
                .init(color: .white.opacity(0.12), location: 0.32),
                .init(color: .white.opacity(0.05), location: 0.6),
                .init(color: CE.ice.opacity(0.28), location: 1),
            ], startPoint: .topLeading, endPoint: .bottomTrailing),
            lineWidth: strong ? 1.4 : 1.15
        )
        .allowsHitTesting(false)
    }
}

// MARK: - Glass chrome (Liquid Glass on macOS/iOS 26+, material fallback before)

@available(macOS 26.0, iOS 26.0, *)
private func ceGlass(tint: Color?, interactive: Bool) -> Glass {
    var glass = Glass.regular
    if let tint { glass = glass.tint(tint) }
    if interactive { glass = glass.interactive() }
    return glass
}

private struct GlassChrome<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S
    let tint: Color?
    let interactive: Bool
    func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            content.glassEffect(ceGlass(tint: tint ?? CE.glassTint.opacity(0.45), interactive: interactive), in: shape)
                .overlay { GlassRim(shape: shape) }
        } else if reduceTransparency {
            content.background(CE.plateRaisedSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background((tint ?? CE.glassTint).opacity(0.45), in: shape)
                .background(.ultraThinMaterial, in: shape)
                .overlay { GlassRim(shape: shape) }
        }
    }
}

/// A bar pinned to the top or bottom of a scrolling area. On 26+ it is a `safeAreaBar`, so the system scroll-edge
/// effect sits under the bar and content scrolls beneath it; a plain safe-area inset otherwise. Using a plain VStack
/// row instead makes the 26 edge effect blur the first rows of the content at rest.
private struct CEBar<Bar: View>: ViewModifier {
    let edge: VerticalEdge
    let bar: Bar
    func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            content.safeAreaBar(edge: edge, spacing: 0) { bar }
        } else {
            content.safeAreaInset(edge: edge, spacing: 0) { bar }
        }
    }
}

extension View {
    func ceBar<Bar: View>(_ edge: VerticalEdge, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(CEBar(edge: edge, bar: bar()))
    }

    /// Use only for controls and chrome that float above content.
    func glassChrome<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(GlassChrome(shape: shape, tint: tint, interactive: interactive))
    }

    /// Prominent action (e.g. submit). Explicit colours on every OS version: content buttons are not chrome, and the
    /// system glass styles fade enabled buttons to look disabled whenever the Mac window is not key.
    func ceProminentButton() -> some View {
        self.buttonStyle(CEFilledButtonStyle())
    }

    /// Secondary action next to content. Same reasoning as `ceProminentButton`.
    func ceSecondaryButton() -> some View {
        self.buttonStyle(CEQuietButtonStyle())
    }

    /// Compact controls: small on Mac, regular on iPhone so touch targets stay at 44pt.
    /// (`ceProminentButton` / `ceSecondaryButton` already keep 44pt on iOS whatever control size is set.)
    @ViewBuilder func ceCompactControl() -> some View {
        #if os(macOS)
        self.controlSize(.small)
        #else
        self.controlSize(.regular)
        #endif
    }

    @ViewBuilder func ceSheetSize(width: CGFloat, height: CGFloat) -> some View {
        #if os(macOS)
        // A Mac sheet opens at its minimum width, so the intended width is the minimum.
        self.frame(minWidth: width, idealWidth: width, minHeight: min(420, height), idealHeight: height)
        #else
        self
        #endif
    }

    /// Text input surface used inside forms and composers (web .input: min-height 44, padding 10/13, 15px text,
    /// rgb(5 4 11 / .5) well, white .12 ring; the focus ring is #B9A8FF). A font set on the field itself still wins.
    func ceField(focused: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        return self.textFieldStyle(.plain)
            #if os(macOS)
            .font(.system(size: 15))
            #else
            .font(CEFont.body)
            #endif
            .padding(.horizontal, 13).padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(CE.bgDeep.opacity(0.5), in: shape)
            .overlay {
                shape.strokeBorder(focused ? CE.accent.opacity(0.85) : Color.white.opacity(0.12), lineWidth: focused ? 1.5 : 1)
            }
    }

    /// Text-only action (취소, 더 불러오기, 다시 읽기): no fill until hovered (web .gbtn--ghost).
    func ceGhostButton() -> some View {
        self.buttonStyle(CEGhostButtonStyle())
    }
}

/// Size of the explicit button styles, the web's .gbtn sizes (every variant 600 weight): small = .gbtn--s 32 / 13.5px,
/// regular = .gbtn--m 44 / 15px, large = .gbtn--l 52 / 16px; mini is a 26pt step for the densest rows. Mac follows
/// `controlSize`; iOS keeps one readable size with a 44pt hit area. A fixed height, not vertical padding, so Korean
/// and Latin labels give the same capsule.
private struct CEButtonMetrics {
    let font: Font
    let horizontal: CGFloat
    let height: CGFloat
    init(_ size: ControlSize, prominent: Bool) {
        #if os(macOS)
        switch size {
        case .mini: font = .system(size: 12.5, weight: .semibold); horizontal = 11; height = 26
        case .small: font = .system(size: 13.5, weight: .semibold); horizontal = 14; height = 32
        case .large, .extraLarge: font = .system(size: 16, weight: .semibold); horizontal = 26; height = 52
        default: font = .system(size: 15, weight: .semibold); horizontal = 20; height = 44
        }
        #else
        font = CEFont.rowTitle.weight(.semibold)
        horizontal = 16; height = 38
        #endif
    }
}

private extension View {
    /// iPhone: at least a 44pt hit target around the visible capsule. Mac: the capsule itself.
    @ViewBuilder func ceButtonHitArea() -> some View {
        #if os(macOS)
        self.contentShape(Capsule())
        #else
        self.frame(minHeight: 44).contentShape(Rectangle())
        #endif
    }
}

/// Filled accent capsule. Disabled is drawn explicitly (hairline, dim label) instead of fading, and nothing here
/// depends on whether the window is key.
struct CEFilledButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { FilledBody(configuration: configuration) }
    private struct FilledBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: true)
            // web .gbtn--primary: violet gradient, a glossy top half, a soft lilac glow along the bottom, a deep violet
            // shadow and a dark text shadow; hover brightens 7%, press shrinks to .97; disabled keeps its colour at 40%.
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(Color.white)
                .shadow(color: Color(red: 28 / 255, green: 8 / 255, blue: 92 / 255).opacity(0.45), radius: 0.5, y: 1)
                .background {
                    Capsule().fill(CE.primaryGradient)
                        .overlay {
                            Capsule().fill(LinearGradient(stops: [
                                .init(color: .white.opacity(0.14), location: 0), .init(color: .white.opacity(0.025), location: 0.44),
                                .init(color: .clear, location: 0.52),
                            ], startPoint: .top, endPoint: .bottom))
                        }
                        .overlay {
                            Capsule().fill(LinearGradient(colors: [.clear, Color(red: 222 / 255, green: 208 / 255, blue: 1).opacity(0.3)],
                                                          startPoint: .center, endPoint: .bottom))
                        }
                        .overlay { GlassRim(shape: Capsule()) }
                        .shadow(color: CE.violet.opacity(isEnabled ? 0.55 : 0), radius: 12, y: 8)
                        .shadow(color: Color(red: 16 / 255, green: 6 / 255, blue: 52 / 255).opacity(isEnabled ? 0.5 : 0), radius: 3, y: 2)
                }
                .brightness(isEnabled && hovering && !configuration.isPressed ? 0.06 : 0)
                .opacity(isEnabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
    }
}

/// Quiet capsule for secondary actions. Enabled: bright label on a light fill; disabled: dim label, no fill.
struct CEQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { QuietBody(configuration: configuration) }
    private struct QuietBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: false)
            // web .gbtn--glass: a top-lit white gradient over the glass, a rim, and a soft dark shadow under it.
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                .background(LinearGradient(colors: [Color.white.opacity(fill.top), Color.white.opacity(fill.bottom)],
                                           startPoint: .top, endPoint: .bottom), in: Capsule())
                .background(.ultraThinMaterial.opacity(isEnabled ? 1 : 0.5), in: Capsule())
                .overlay { if isEnabled { GlassRim(shape: Capsule()) } else { Capsule().strokeBorder(CE.line) } }
                .shadow(color: Color(red: 4 / 255, green: 2 / 255, blue: 14 / 255).opacity(isEnabled ? 0.45 : 0), radius: 8, y: 6)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
        private var fill: (top: Double, bottom: Double) {
            guard isEnabled else { return (0, 0) }
            return configuration.isPressed ? (0.18, 0.08) : hovering ? (0.16, 0.06) : (0.10, 0.03)
        }
    }
}

/// Text-only action: no fill or rim until hovered (web .gbtn--ghost). Same sizes as the other buttons.
struct CEGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { GhostBody(configuration: configuration) }
    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: false)
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(!isEnabled ? CE.ink3 : hovering ? CE.ink : CE.ink2)
                .background(Color.white.opacity(!isEnabled ? 0 : configuration.isPressed ? 0.10 : hovering ? 0.07 : 0), in: Capsule())
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
    }
}

/// Plain list row with hover, press and selection feedback (web .fl-row / .pj: hover white .06; the selected row is
/// the rail's violet gradient with a lit top edge).
struct RowButtonStyle: ButtonStyle {
    var selected = false
    var radius: CGFloat = CERadius.control
    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, selected: selected, radius: radius)
    }
    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let radius: CGFloat
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            configuration.label
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.34), CE.violet.opacity(0.22)], startPoint: .top, endPoint: .bottom))
                            .overlay {
                                shape.strokeBorder(Color.white.opacity(0.4), lineWidth: 0.5)
                                    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .clear, location: 0.35)],
                                                         startPoint: .top, endPoint: .bottom))
                            }
                            .overlay { shape.strokeBorder(Color.white.opacity(0.05)) }
                    } else {
                        shape.fill(Color.white.opacity(configuration.isPressed ? 0.09 : hovering ? 0.06 : 0))
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}
