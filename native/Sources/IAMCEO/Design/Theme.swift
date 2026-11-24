import SwiftUI

/// Design tokens. Content sits on calm plates; glass is reserved for chrome (sidebar, toolbar, tab bar, composer, sticky bars).
/// Tokens copied from the web client (web/src/styles/tokens.css), which the owner prefers. Every token reads the theme on
/// screen (`ThemeStore`); the default theme's values are 0.2.10's, unchanged.
enum CE {
    /// The theme on screen. Read inside a view body, it subscribes that view to theme changes.
    static var style: ThemeStyle { ThemeStore.shared.style }
    static var palette: ThemePalette { ThemeStore.shared.style.palette }
    /// The default (0.2.10) look: the aurora, its glass cards and violet light.
    static var isStandard: Bool { style.isStandard }

    static var bg: Color { palette.bg }
    static var bgDeep: Color { palette.bgDeep }
    static var plateSolid: Color { palette.plateSolid }
    static var plateRaisedSolid: Color { palette.plateRaisedSolid }
    static var plate: Color { palette.plate }
    static var plateRaised: Color { palette.plateRaised }
    static var line: Color { palette.line }
    static var lineStrong: Color { palette.lineStrong }
    static var ink: Color { palette.ink }
    static var ink2: Color { palette.ink2 }
    static var ink3: Color { palette.ink3 }
    static var accent: Color { palette.accent }       // --focus: links, selection rings
    static var accentFill: Color { palette.accentFill }   // --accent-fill: fills under white text (badges, send)
    /// Text on `accentFill` (white in the default theme).
    static var onAccent: Color { palette.onAccent }
    static var violet: Color { palette.violet }
    static var orchid: Color { palette.orchid }
    static var indigo: Color { palette.indigo }
    static var rose: Color { palette.rose }
    static var ice: Color { palette.ice }
    // Member states (--st-*) and semantic text colours (--ok/--warn/--danger)
    static var live: Color { palette.live }         // 일하는 중
    static var attention: Color { palette.attention }    // 내 답 기다림
    static var approval: Color { palette.approval }     // 승인 창 앞
    static var danger: Color { palette.danger }       // 오류 · 실패 (text)
    static var error: Color { palette.error }        // 오류 dot
    static var success: Color { palette.success }      // 받음 · 완료
    static var warn: Color { palette.warn }         // 보류
    static var idle: Color { palette.idle }         // 대기
    static var dim: Color { palette.dim }          // 잠듦 · 안 보임 (hollow ring)
    /// Overlay ink: what hover, pressed, chips and quiet rings are drawn in at a low opacity. White on a dark theme, the
    /// text colour on a light one (a white .06 hover vanishes on a light background).
    static var wash: Color { palette.wash }
    /// Text on a `violet` wash (selected tab, row or choice): white in the default theme.
    static var onSelection: Color { palette.onSelection }
    /// Shadow colour.
    static var shadow: Color { palette.shadow }
    /// Theme surfaces (the default theme draws its own glass instead; these are its solid equivalents).
    static var surface: Color { palette.surface }
    static var surfaceAlt: Color { palette.surfaceAlt }
    static var chipBg: Color { palette.chipBg }
    static var codeText: Color { palette.codeText }
    /// Primary button gradient (web .gbtn--primary). Other themes: their accent fill.
    static var primaryGradient: LinearGradient {
        if isStandard {
            return LinearGradient(colors: [Color(red: 134/255, green: 104/255, blue: 252/255).opacity(0.88), Color(red: 104/255, green: 68/255, blue: 246/255).opacity(0.84), Color(red: 92/255, green: 54/255, blue: 234/255).opacity(0.88)], startPoint: .top, endPoint: .bottom)
        }
        return LinearGradient(colors: [palette.accentFill, palette.accentFill], startPoint: .top, endPoint: .bottom)
    }
    /// Text-heavy glass tint (web .glass-tint: rgb(9 7 19 / .52)).
    static var glassTint: Color { palette.glassTint }
    /// Card tint, used at 55%. The web card is rgb(12 9 28 / .6) over a `saturate(175%)` backdrop; SwiftUI has no
    /// backdrop saturation, so the tint carries the blue that saturation adds to the violet aurora (measured on screen:
    /// card interiors land on the web's dark, saturated violet instead of a neutral navy).
    static var cardTint: Color { palette.cardTint }
    /// Border width of boxes in this theme (1; 또렷 2).
    static var borderWidth: CGFloat { style.borderWidth }
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
/// Themes: Mac sizes are multiplied by the theme's scale (never below 1), headings take the theme's weight and design,
/// the body its design; the default theme's fonts are 0.2.10's.
enum CEFont {
    private static var style: ThemeStyle { CE.style }
    #if os(macOS)
    static var pageTitle: Font { heading(17) }
    static var title: Font { heading(16.5) }
    static var section: Font { heading(14) }
    static var rowTitle: Font { .ceSystem(size: 14.5, weight: .semibold) }
    static var body: Font { .ceSystem(size: 14.5) }
    /// Notes, hints, errors and status lines (web 13.5px: .tm-note, .form__error, .offline-band).
    static var note: Font { .ceSystem(size: 13.5) }
    /// Row sub-lines (web 13px: .hm-row__sub, .fl-row__summary).
    static var secondary: Font { .ceSystem(size: 13) }
    /// Meta, times, hints (web 12.5px, the most common small size).
    static var meta: Font { .ceSystem(size: 12.5) }
    /// Counts and rail sub-lines, the few places the web really uses 12px.
    static var caption: Font { .ceSystem(size: 12) }
    static var micro: Font { .ceSystem(size: 11.5, weight: .bold) }
    static var mono: Font { .ceSystem(size: 12.5, design: .monospaced) }
    static var number: Font { .ceSystem(size: 20, weight: .semibold, design: .rounded) }
    #else
    static var pageTitle: Font { style.isStandard ? .headline : styled(.headline, heading: true) }
    static var title: Font { style.isStandard ? .headline : styled(.headline, heading: true) }
    static var section: Font { style.isStandard ? .subheadline.weight(.semibold) : styled(.subheadline, heading: true) }
    static var rowTitle: Font { style.isStandard ? .subheadline.weight(.semibold) : styled(.subheadline, weight: .semibold) }
    static var body: Font { style.isStandard ? .subheadline : styled(.subheadline) }
    static var note: Font { style.isStandard ? .footnote : styled(.footnote) }
    static var secondary: Font { style.isStandard ? .footnote : styled(.footnote) }
    static var meta: Font { style.isStandard ? .caption : styled(.caption) }
    static var caption: Font { style.isStandard ? .caption : styled(.caption) }
    static var micro: Font { style.isStandard ? .caption2.weight(.bold) : styled(.caption2, weight: .bold) }
    static var mono: Font { .system(.caption, design: .monospaced) }
    static var number: Font { .system(.title2, design: .rounded, weight: .semibold) }

    /// A Dynamic Type style in the theme's design; headings in the heading design and weight.
    private static func styled(_ textStyle: Font.TextStyle, weight: Font.Weight? = nil, heading: Bool = false) -> Font {
        let design = (heading ? style.headingDesign : nil) ?? style.bodyDesign ?? .default
        let font = Font.system(textStyle, design: design)
        if heading { return font.weight(style.headingWeight) }
        if let weight { return font.weight(weight) }
        return font
    }
    #endif

    /// Markdown headings inside reports, decisions and documents: each level clearly above the reading size.
    #if os(macOS)
    static var heading1: Font { heading(16) }
    static var heading2: Font { heading(14.5) }
    static var heading3: Font { heading(13.5) }
    #else
    static var heading1: Font { style.isStandard ? .title3.weight(.semibold) : styled(.title3, heading: true) }
    static var heading2: Font { style.isStandard ? .headline : styled(.headline, heading: true) }
    static var heading3: Font { style.isStandard ? .callout.weight(.semibold) : styled(.callout, heading: true) }
    #endif

    /// A heading at a web size: semibold in the default theme, the theme's heading weight and design otherwise.
    static func heading(_ size: CGFloat) -> Font {
        if style.isStandard { return .ceSystem(size: size, weight: .semibold) }
        return .ceSystem(size: size, weight: style.headingWeight, design: style.headingDesign)
    }
}

extension Font {
    /// `.system(size:weight:design:)` for the theme on screen: Mac sizes scale with the theme (the default theme's scale
    /// is 1, so 0.2.10's sizes), and a theme's body design (말랑: rounded) applies where none is given. Calls the same
    /// `system` overload the plain call would, so the default theme draws exactly as before.
    static func ceSystem(size: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Font {
        let style = ThemeStore.shared.style
        let size = size * style.fixedFontScale
        let design = design ?? style.bodyDesign
        switch (weight, design) {
        case (nil, nil): return .system(size: size)
        case (let weight?, nil): return .system(size: size, weight: weight)
        case (nil, let design?): return .system(size: size, design: design)
        case (let weight?, let design?): return .system(size: size, weight: weight, design: design)
        }
    }
}

/// Line height. SwiftUI's `lineSpacing` is extra space on top of the system font's own line (~1.2), so a web
/// `line-height: L` on `size`-point text becomes `size * (L - 1.2)`. Every Text that can wrap gets one of these:
/// without it multi-line text renders at ~1.2, 2.5-5pt per line tighter than the web.
enum CELeading {
    /// Themes scale the size with their type and add their line-height boost (never below the web's).
    static func spacing(_ size: CGFloat, _ lineHeight: CGFloat) -> CGFloat {
        let style = ThemeStore.shared.style
        let size = size * style.leadingScale
        let lineHeight = lineHeight + style.lineBoost
        return max(0, ((size * (lineHeight - 1.2)) * 2).rounded() / 2)
    }
    /// 14.5 at 1.5 (body paragraphs, row text).
    static var body: CGFloat { spacing(14.5, 1.5) }
    /// 13.5 at 1.45 (notes, errors, hints).
    static var note: CGFloat { spacing(13.5, 1.45) }
    /// 13 at 1.45 (row sub-lines).
    static var secondary: CGFloat { spacing(13, 1.45) }
    /// 12.5 at 1.4 (meta lines that wrap).
    static var meta: CGFloat { spacing(12.5, 1.4) }
    /// 16 at 1.35 (titles that wrap).
    static var title: CGFloat { spacing(16, 1.35) }
}

extension View {
    /// The web line height `lineHeight` for `size`-point text (see `CELeading`).
    func ceLineHeight(_ size: CGFloat, _ lineHeight: CGFloat) -> some View {
        lineSpacing(CELeading.spacing(size, lineHeight))
    }
}

/// Spacing (web steps). Roomier themes scale it; none goes under the web's.
enum CESpace {
    static var xs: CGFloat { scaled(4) }
    static var s: CGFloat { scaled(8) }
    static var m: CGFloat { scaled(12) }
    static var l: CGFloat { scaled(16) }
    static var xl: CGFloat { scaled(20) }
    static var xxl: CGFloat { scaled(28) }
    /// A web spacing value in this theme (rounded to the half point).
    static func scaled(_ value: CGFloat) -> CGFloat {
        let scale = ThemeStore.shared.style.spaceScale
        return scale == 1 ? value : (value * scale * 2).rounded() / 2
    }
}

enum CERadius {
    static var plate: CGFloat { r(22) }     // web .glass--regular
    static var card: CGFloat { r(18) }      // web inner cards (.tm-card, .ibx-card)
    static var control: CGFloat { r(12) }   // inputs, option tiles
    static var row: CGFloat { r(10) }       // list rows
    /// A 0.2.10 corner radius in the theme on screen (the default theme: the same value).
    static func r(_ value: CGFloat) -> CGFloat { ThemeStore.shared.style.radius(value) }
}

/// A capsule, or for the squared themes (작업대, 또렷) a rounded rectangle at the theme's control radius: tags, badges,
/// tabs, chips and the send button lose their pills there. The default theme draws `Capsule`'s own path.
struct CECapsule: InsettableShape {
    private var radius: CGFloat?
    private var inset: CGFloat = 0
    init() {
        let style = ThemeStore.shared.style
        radius = style.squareCapsules ? style.controlRadius : nil
    }
    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: inset, dy: inset)
        if let radius { return RoundedRectangle(cornerRadius: max(0, radius - inset), style: .continuous).path(in: rect) }
        return Capsule().path(in: rect)
    }
    func inset(by amount: CGFloat) -> CECapsule {
        var copy = self
        copy.inset += amount
        return copy
    }
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
            if CE.isStandard {
                aurora(geo, vmax: vmax)
            } else {
                ThemedBackdrop(size: geo.size)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func aurora(_ geo: GeometryProxy, vmax: CGFloat) -> some View {
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
}

/// The backdrop of every theme but the default: the theme's background colour. 서리 유리 lays two faint accent lights on it
/// so its see-through sidebar has something to frost; the flat and hairline themes stay a plain colour. Reduce
/// Transparency: the plain colour.
private struct ThemedBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let size: CGSize
    var body: some View {
        let vmax = max(size.width, size.height)
        ZStack {
            CE.bg
            if CE.style.sidebar == .glass && !reduceTransparency {
                let glow = CE.accent.opacity(CE.style.dark ? 0.16 : 0.12)
                EllipticalGradient(colors: [glow, glow.opacity(0)])
                    .frame(width: vmax * 0.7, height: vmax * 0.5)
                    .position(x: size.width * 0.1, y: size.height * 0.2)
                EllipticalGradient(colors: [glow.opacity(0.7), glow.opacity(0)])
                    .frame(width: vmax * 0.6, height: vmax * 0.42)
                    .position(x: size.width * 0.85, y: size.height * 0.95)
            }
        }
    }
}

/// The web glass rim: bright top-left edge, faint ice glow bottom-right.
struct GlassRim<S: InsettableShape>: View {
    let shape: S
    var strong = false
    var body: some View {
        if CE.isStandard { auroraRim } else {
            // Other themes: the theme's hairline, a touch lighter on top (frost on light glass, a faint edge on dark).
            shape.strokeBorder(LinearGradient(colors: [CE.line, CE.line.opacity(0.7)], startPoint: .top, endPoint: .bottom),
                               lineWidth: strong ? max(1.4, CE.borderWidth) : CE.borderWidth)
                .allowsHitTesting(false)
        }
    }

    private var auroraRim: some View {
        shape.strokeBorder(
            LinearGradient(stops: [
                .init(color: CE.wash.opacity(strong ? 0.62 : 0.5), location: 0),
                .init(color: CE.wash.opacity(0.12), location: 0.32),
                .init(color: CE.wash.opacity(0.05), location: 0.6),
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
            content.glassEffect(ceGlass(tint: tint ?? CE.glassTint.opacity(Self.tintStrength), interactive: interactive), in: shape)
                .overlay { GlassRim(shape: shape) }
        } else if reduceTransparency {
            content.background(CE.plateRaisedSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background((tint ?? CE.glassTint).opacity(Self.tintStrength), in: shape)
                .background(.ultraThinMaterial, in: shape)
                .overlay { GlassRim(shape: shape) }
        }
    }
    /// How much of the chrome tint lies on the glass: 0.45 in the default theme; the see-through theme (서리 유리) less,
    /// the solid and tinted themes nearly all of it (their chrome reads as a colour, not as glass).
    private static var tintStrength: Double {
        switch CE.style.sidebar {
        case .aurora: 0.45
        case .glass: 0.5
        case .tinted: 0.85
        case .solid: 0.94
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
            .font(.ceSystem(size: 15))
            #else
            .font(CEFont.body)
            #endif
            .padding(.horizontal, 13).padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(CE.isStandard ? CE.bgDeep.opacity(0.5) : CE.surface, in: shape)
            .overlay {
                // Other themes: the field is the surface colour with the theme's strong line (it must stand out on a card).
                shape.strokeBorder(focused ? CE.accent.opacity(0.85) : CE.isStandard ? CE.wash.opacity(0.12) : CE.lineStrong,
                                   lineWidth: focused ? max(1.5, CE.borderWidth) : CE.borderWidth)
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
        case .mini: font = .ceSystem(size: 12.5, weight: .semibold); horizontal = 11; height = 26
        case .small: font = .ceSystem(size: 13.5, weight: .semibold); horizontal = 14; height = 32
        case .large, .extraLarge: font = .ceSystem(size: 16, weight: .semibold); horizontal = 26; height = 52
        default: font = .ceSystem(size: 15, weight: .semibold); horizontal = 20; height = 44
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
        self.contentShape(CECapsule())
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
            if CE.isStandard { aurora(metrics) } else { themed(metrics) }
        }

        /// Other themes: the accent fill with its own text colour, a soft shadow only where the theme casts shadows.
        private func themed(_ metrics: CEButtonMetrics) -> some View {
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(CE.onAccent)
                .background {
                    CECapsule().fill(CE.accentFill)
                        .shadow(color: CE.shadow.opacity(isEnabled && CE.style.elevation == .shadow ? 0.22 : 0), radius: 6, y: 3)
                }
                .brightness(isEnabled && hovering && !configuration.isPressed ? (CE.style.dark ? 0.06 : -0.05) : 0)
                .opacity(isEnabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }

        private func aurora(_ metrics: CEButtonMetrics) -> some View {
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
                    CECapsule().fill(CE.primaryGradient)
                        .overlay {
                            CECapsule().fill(LinearGradient(stops: [
                                .init(color: CE.wash.opacity(0.14), location: 0), .init(color: CE.wash.opacity(0.025), location: 0.44),
                                .init(color: .clear, location: 0.52),
                            ], startPoint: .top, endPoint: .bottom))
                        }
                        .overlay {
                            CECapsule().fill(LinearGradient(colors: [.clear, Color(red: 222 / 255, green: 208 / 255, blue: 1).opacity(0.3)],
                                                          startPoint: .center, endPoint: .bottom))
                        }
                        .overlay { GlassRim(shape: CECapsule()) }
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
            if CE.isStandard { aurora(metrics) } else { themed(metrics) }
        }

        /// Other themes: a quiet surface with the theme's line; hover and press deepen it with the overlay ink.
        private func themed(_ metrics: CEButtonMetrics) -> some View {
            let shape = CECapsule()
            return configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                .background(isEnabled ? CE.surface : Color.clear, in: shape)
                .background(CE.wash.opacity(!isEnabled ? 0 : configuration.isPressed ? 0.12 : hovering ? 0.07 : 0), in: shape)
                .overlay { shape.strokeBorder(isEnabled ? CE.lineStrong : CE.line, lineWidth: CE.borderWidth) }
                .shadow(color: CE.shadow.opacity(isEnabled && CE.style.elevation == .shadow ? 0.12 : 0), radius: 4, y: 2)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }

        private func aurora(_ metrics: CEButtonMetrics) -> some View {
            // web .gbtn--glass: a top-lit white gradient over the glass, a rim, and a soft dark shadow under it.
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                .background(LinearGradient(colors: [CE.wash.opacity(fill.top), CE.wash.opacity(fill.bottom)],
                                           startPoint: .top, endPoint: .bottom), in: CECapsule())
                .background(.ultraThinMaterial.opacity(isEnabled ? 1 : 0.5), in: CECapsule())
                .overlay { if isEnabled { GlassRim(shape: CECapsule()) } else { CECapsule().strokeBorder(CE.line) } }
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
                .background(CE.wash.opacity(!isEnabled ? 0 : configuration.isPressed ? 0.10 : hovering ? 0.07 : 0), in: CECapsule())
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
                    if selected && !CE.isStandard {
                        ThemedSelection(shape: shape)
                    } else if selected {
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.34), CE.violet.opacity(0.22)], startPoint: .top, endPoint: .bottom))
                            .overlay {
                                shape.strokeBorder(CE.wash.opacity(0.4), lineWidth: 0.5)
                                    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .clear, location: 0.35)],
                                                         startPoint: .top, endPoint: .bottom))
                            }
                            .overlay { shape.strokeBorder(CE.wash.opacity(0.05)) }
                    } else {
                        shape.fill(CE.wash.opacity(configuration.isPressed ? 0.09 : hovering ? 0.06 : 0))
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}

/// A selected row, tab or item in the themes other than the default: the accent at a light wash, and — where the theme
/// draws state as bars (작업대, 또렷) or as flat colour — a solid accent bar at the leading edge instead of a rim.
struct ThemedSelection<S: InsettableShape>: View {
    let shape: S
    var body: some View {
        let style = CE.style
        ZStack(alignment: .leading) {
            shape.fill(CE.violet.opacity(style.dark ? 0.32 : 0.14))
            if style.statusShape == .bar {
                Rectangle().fill(CE.accent).frame(width: 3)
            } else {
                shape.strokeBorder(CE.violet.opacity(style.dark ? 0.55 : 0.4), lineWidth: style.borderWidth)
            }
        }
        .clipShape(shape)
        .allowsHitTesting(false)
    }
}
