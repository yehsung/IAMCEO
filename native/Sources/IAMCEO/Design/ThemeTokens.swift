import SwiftUI
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 기기별 화면 테마(설정 › 일반 › 이 기기). 이 기기의 UserDefaults 에만 저장하고 서버로 보내지 않는다.
//
// - `ThemeID`: 다섯 테마. `.standard`(기본)는 0.2.10 의 모양 그대로이고 어둡게만 있다.
// - `ThemeBrightness`: 테마 기본 · 시스템 따라가기 · 밝게 · 어둡게.
// - `ThemePalette`: 색 토큰. 기본은 0.2.10 의 Color 식을 그대로 쓰고, 나머지는 ThemePalettes.swift 의 값.
// - `ThemeStyle`: 한 테마 × 밝기의 색·글꼴·모서리·밀도·말풍선·사이드바·그림자·상태 모양.
// - `ThemeStore.shared`: 지금 테마. `CE`·`CEFont`·`CERadius`·`CESpace` 가 이것을 읽는다. 관찰 가능한 값이라 화면 본문에서
//   읽은 화면은 테마가 바뀌면 다시 그려진다(앱을 다시 열지 않아도, 상태를 잃지 않고).

/// The five themes. Raw values are the stored keys (the design file's ids).
enum ThemeID: String, CaseIterable, Identifiable, Sendable {
    case standard = "default"
    case frost = "frosted-glass"
    case workbench = "workbench"
    case marshmallow = "marshmallow"
    case contrast = "aaa-contrast"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .standard: String(localized: "기본")
        case .frost: String(localized: "서리 유리")
        case .workbench: String(localized: "작업대")
        case .marshmallow: String(localized: "말랑")
        case .contrast: String(localized: "또렷")
        }
    }

    /// The default theme is the 0.2.10 look, drawn for a dark backdrop only.
    var hasLight: Bool { self != .standard }
    /// The brightness a theme opens in under '테마 기본'.
    var primaryDark: Bool {
        switch self {
        case .standard, .workbench, .contrast: true
        case .frost, .marshmallow: false
        }
    }
}

enum ThemeBrightness: String, CaseIterable, Identifiable, Sendable {
    case theme, system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .theme: String(localized: "테마 기본")
        case .system: String(localized: "시스템 따라가기")
        case .light: String(localized: "밝게")
        case .dark: String(localized: "어둡게")
        }
    }
}

/// How a chat report and the owner's message are drawn.
enum ThemeBubbleStyle: Sendable { case bubble, flat, outline }
/// The Mac sidebar (and the iPhone tab bar's fill): the default's aurora glass, see-through glass, a tint, or a solid colour.
enum ThemeSidebarStyle: Sendable { case aurora, glass, tinted, solid }
/// Card depth: the default's aurora glass card, a soft shadow, a hairline only, or flat colour areas.
enum ThemeElevation: Sendable { case aurora, shadow, hairline, flat }
/// Member state: a tinted capsule, a bar at the row's edge, or a dot with its label.
enum ThemeStatusShape: Sendable { case pill, bar, dot }

/// Colour tokens of one theme in one brightness.
final class ThemePalette: Sendable {
    enum Key: String, CaseIterable, Sendable {
        case bg, bgDeep, plateSolid, plateRaisedSolid, plate, plateRaised, line, lineStrong
        case ink, ink2, ink3, accent, accentFill, onAccent, violet, orchid, indigo, rose, ice
        case live, attention, approval, danger, error, success, warn, idle, dim
        case wash, onSelection, shadow, glassTint, cardTint
        case surface, surfaceAlt, sidebar, chipBg, codeBg, codeText
        case ownerBubble, onOwnerBubble, ownerMuted, ownerCode, leadBubble, onLeadBubble, warmFill, onError
    }

    let bg, bgDeep, plateSolid, plateRaisedSolid, plate, plateRaised, line, lineStrong: Color
    let ink, ink2, ink3, accent, accentFill, onAccent, violet, orchid, indigo, rose, ice: Color
    let live, attention, approval, danger, error, success, warn, idle, dim: Color
    /// Overlay ink: hover, pressed, chips and quiet rings are this at a low opacity (white on dark, the text colour on light).
    let wash: Color
    /// Text on a `violet` wash (a selected row, tab or choice).
    let onSelection: Color
    let shadow, glassTint, cardTint: Color
    let surface, surfaceAlt, sidebar, chipBg, codeBg, codeText: Color
    let ownerBubble, onOwnerBubble, ownerMuted, ownerCode, leadBubble, onLeadBubble: Color
    /// The connection-lost strip's fill.
    let warmFill: Color
    /// Text on the `error` fill (count badges of something blocked).
    let onError: Color
    /// sRGB values of a generated palette (the tests measure contrast from them). nil for the standard palette.
    let hex: [Key: UInt32]?

    init(hex: [Key: UInt32]? = nil, _ color: (Key) -> Color) {
        self.hex = hex
        bg = color(.bg); bgDeep = color(.bgDeep); plateSolid = color(.plateSolid); plateRaisedSolid = color(.plateRaisedSolid)
        plate = color(.plate); plateRaised = color(.plateRaised); line = color(.line); lineStrong = color(.lineStrong)
        ink = color(.ink); ink2 = color(.ink2); ink3 = color(.ink3); accent = color(.accent); accentFill = color(.accentFill)
        onAccent = color(.onAccent); violet = color(.violet); orchid = color(.orchid); indigo = color(.indigo); rose = color(.rose)
        ice = color(.ice); live = color(.live); attention = color(.attention); approval = color(.approval); danger = color(.danger)
        error = color(.error); success = color(.success); warn = color(.warn); idle = color(.idle); dim = color(.dim)
        wash = color(.wash); onSelection = color(.onSelection); shadow = color(.shadow); glassTint = color(.glassTint)
        cardTint = color(.cardTint); surface = color(.surface); surfaceAlt = color(.surfaceAlt); sidebar = color(.sidebar)
        chipBg = color(.chipBg); codeBg = color(.codeBg); codeText = color(.codeText); ownerBubble = color(.ownerBubble)
        onOwnerBubble = color(.onOwnerBubble); ownerMuted = color(.ownerMuted); ownerCode = color(.ownerCode)
        leadBubble = color(.leadBubble); onLeadBubble = color(.onLeadBubble); warmFill = color(.warmFill); onError = color(.onError)
    }

    /// A palette from the generated values. Tokens the designs do not set map onto the ones they do.
    convenience init(generated values: [Key: UInt32]) {
        var all = values
        let alias: [Key: Key] = [.plate: .surface, .plateRaised: .surfaceAlt, .orchid: .accent, .indigo: .accent,
                                 .rose: .accent, .ice: .accent, .glassTint: .sidebar, .cardTint: .surface]
        for (key, source) in alias where all[key] == nil { all[key] = values[source] }
        self.init(hex: all) { key in Color(hex: all[key] ?? 0xFF00FF) }
    }

    /// 0.2.10 exactly: every value is the expression `enum CE` and the screens used before themes existed.
    static let standard = ThemePalette { key in
        switch key {
        case .bg: Color(hex: 0x090713)
        case .bgDeep: Color(hex: 0x05040B)
        case .plateSolid: Color(hex: 0x16112C)
        case .plateRaisedSolid: Color(hex: 0x1D1638)
        case .plate: Color.white.opacity(0.045)
        case .plateRaised: Color.white.opacity(0.08)
        case .line: Color.white.opacity(0.08)
        case .lineStrong: Color.white.opacity(0.14)
        case .ink: Color(hex: 0xF5F2FF)
        case .ink2: Color(hex: 0xC2BBDF)
        case .ink3: Color(hex: 0x8F88B2)
        case .accent: Color(hex: 0xB9A8FF)
        case .accentFill: Color(hex: 0x6D4DF2)
        case .onAccent: Color.white
        case .violet: Color(hex: 0x7A5BFF)
        case .orchid: Color(hex: 0xB35CFF)
        case .indigo: Color(hex: 0x3D45FF)
        case .rose: Color(hex: 0xFF6FB8)
        case .ice: Color(hex: 0xA8ECFF)
        case .live: Color(hex: 0xB9A8FF)
        case .attention: Color(hex: 0xFFB070)
        case .approval: Color(hex: 0xFF8A80)
        case .danger: Color(hex: 0xFF8A9B)
        case .error: Color(hex: 0xFF5A62)
        case .success: Color(hex: 0x6FE3B2)
        case .warn: Color(hex: 0xFFC773)
        case .idle: Color(hex: 0xA6A6AE)
        case .dim: Color(hex: 0x8F88B2)
        case .wash: Color.white
        case .onSelection: Color.white
        case .shadow: Color(red: 4 / 255, green: 2 / 255, blue: 14 / 255)
        case .glassTint: Color(red: 9 / 255, green: 7 / 255, blue: 19 / 255)
        case .cardTint: Color(red: 13 / 255, green: 8 / 255, blue: 46 / 255)
        case .surface: Color(hex: 0x16112C)
        case .surfaceAlt: Color(hex: 0x1D1638)
        case .sidebar: Color(hex: 0x090713)
        case .chipBg: Color.white.opacity(0.07)
        case .codeBg: Color(hex: 0x05040B)
        case .codeText: Color(hex: 0xC2BBDF)
        case .ownerBubble: Color(red: 72 / 255, green: 50 / 255, blue: 176 / 255).opacity(0.9)
        case .onOwnerBubble: Color.white
        case .ownerMuted: Color(hex: 0xDAD2FF)
        case .ownerCode: Color(red: 9 / 255, green: 7 / 255, blue: 19 / 255).opacity(0.35)
        case .leadBubble: Color(red: 15 / 255, green: 11 / 255, blue: 32 / 255).opacity(0.72)
        case .onLeadBubble: Color(hex: 0xF5F2FF)
        case .warmFill: Color(red: 58 / 255, green: 28 / 255, blue: 16 / 255).opacity(0.94)
        case .onError: Color.white
        }
    }
}

/// One theme in one brightness: colours plus the structural choices the designs make.
final class ThemeStyle: Sendable {
    let id: ThemeID
    let dark: Bool
    let palette: ThemePalette
    /// Mac fixed point sizes are multiplied by this (never below 1: the web sizes are the floor). iPhone keeps Dynamic
    /// Type and moves one size step instead (`dynamicTypeStep`).
    let fontScale: CGFloat
    /// iPhone: Dynamic Type steps added for this theme (또렷: one step, so 15pt body text becomes 17pt).
    let dynamicTypeStep: Int
    /// Added to every web line height (never negative: the web line heights are the floor).
    let lineBoost: CGFloat
    let bodyDesign: Font.Design?
    let headingDesign: Font.Design?
    let headingWeight: Font.Weight
    /// Letter spacing for the whole screen; nil leaves the system's.
    let tracking: CGFloat?
    let cardRadius: CGFloat
    let bubbleRadius: CGFloat
    let controlRadius: CGFloat
    /// Capsules (tags, badges, tabs, chips) become rounded rectangles: the squared themes (corner radius under 8).
    let squareCapsules: Bool
    /// Border width of cards and boxes (또렷 draws its 6.9:1 border at 2pt).
    let borderWidth: CGFloat
    /// Spacing scale (CESpace and the main paddings). 1 is the web's; denser than the web is not allowed.
    let spaceScale: CGFloat
    let bubble: ThemeBubbleStyle
    let sidebar: ThemeSidebarStyle
    let elevation: ThemeElevation
    let statusShape: ThemeStatusShape

    init(id: ThemeID, dark: Bool, palette: ThemePalette, fontScale: CGFloat = 1, dynamicTypeStep: Int = 0, lineBoost: CGFloat = 0,
         bodyDesign: Font.Design? = nil, headingDesign: Font.Design? = nil, headingWeight: Font.Weight = .semibold,
         tracking: CGFloat? = nil, cardRadius: CGFloat = 18, bubbleRadius: CGFloat = 18, controlRadius: CGFloat = 12,
         squareCapsules: Bool = false, borderWidth: CGFloat = 1, spaceScale: CGFloat = 1,
         bubble: ThemeBubbleStyle = .bubble, sidebar: ThemeSidebarStyle = .aurora, elevation: ThemeElevation = .aurora,
         statusShape: ThemeStatusShape = .pill) {
        self.id = id; self.dark = dark; self.palette = palette
        self.fontScale = max(1, fontScale); self.dynamicTypeStep = max(0, dynamicTypeStep); self.lineBoost = max(0, lineBoost)
        self.bodyDesign = bodyDesign; self.headingDesign = headingDesign; self.headingWeight = headingWeight; self.tracking = tracking
        self.cardRadius = cardRadius; self.bubbleRadius = bubbleRadius; self.controlRadius = controlRadius
        self.squareCapsules = squareCapsules; self.borderWidth = borderWidth; self.spaceScale = max(1, spaceScale)
        self.bubble = bubble; self.sidebar = sidebar; self.elevation = elevation; self.statusShape = statusShape
    }

    var isStandard: Bool { id == .standard }
    /// Changes whenever any drawn colour or size changes (caches of styled text key on it).
    var key: String { "\(id.rawValue)|\(dark ? "dark" : "light")" }

    /// Mac fixed sizes get `fontScale`; iPhone sizes stay (Dynamic Type carries the step).
    var fixedFontScale: CGFloat { isMac ? fontScale : 1 }
    /// Line spacing is computed from a web size: scale it with the text it spaces.
    var leadingScale: CGFloat {
        isMac ? fontScale : (dynamicTypeStep > 0 ? 17.0 / 15.0 : 1)
    }

    /// A design corner radius (0.2.10's literal) in this theme. Cards and panels (16 and up) follow the card radius,
    /// controls, rows and chips the control radius.
    func radius(_ value: CGFloat) -> CGFloat {
        if isStandard || value <= 2 { return value }
        if value >= 16 { return (value * cardRadius / 18).rounded() }
        return max(2, (value * controlRadius / 12).rounded())
    }

    // MARK: The five themes

    /// The design values (selected-themes.json): base size 15 (web) → scale 1, 14.5 → 1 (never smaller than the web),
    /// 15.5 → 1.033, 17 → 1.133. Line heights over the web body's 1.55 are added to every line height.
    static func make(_ id: ThemeID, dark: Bool) -> ThemeStyle {
        switch id {
        case .standard:
            return ThemeStyle(id: .standard, dark: true, palette: .standard)
        case .frost:
            return ThemeStyle(id: .frost, dark: dark, palette: dark ? .frostDark : .frostLight,
                              tracking: -0.1, cardRadius: 14, bubbleRadius: 16, controlRadius: 10,
                              bubble: .bubble, sidebar: .glass, elevation: .shadow, statusShape: .pill)
        case .workbench:
            return ThemeStyle(id: .workbench, dark: dark, palette: dark ? .workbenchDark : .workbenchLight,
                              // 제목 고정폭은 뺐다: 한글은 시스템 글꼴로 떨어지는데 띄어쓰기만 고정폭 너비라 "결제  완료"처럼 벌어져 보였다(11-25 화면 확인).
                              cardRadius: 6, bubbleRadius: 6, controlRadius: 5,
                              squareCapsules: true, bubble: .flat, sidebar: .solid, elevation: .hairline, statusShape: .bar)
        case .marshmallow:
            return ThemeStyle(id: .marshmallow, dark: dark, palette: dark ? .marshmallowDark : .marshmallowLight,
                              fontScale: 15.5 / 15, lineBoost: 0.1, bodyDesign: .rounded, headingDesign: .rounded,
                              headingWeight: .bold, cardRadius: 22, bubbleRadius: 24, controlRadius: 16, spaceScale: 1.15,
                              bubble: .bubble, sidebar: .tinted, elevation: .flat, statusShape: .pill)
        case .contrast:
            return ThemeStyle(id: .contrast, dark: dark, palette: dark ? .contrastDark : .contrastLight,
                              fontScale: 17.0 / 15.0, dynamicTypeStep: 1, lineBoost: 0.05, headingWeight: .bold,
                              tracking: 0.2, cardRadius: 4, bubbleRadius: 6, controlRadius: 4, squareCapsules: true,
                              borderWidth: 2, spaceScale: 1.15, bubble: .outline, sidebar: .solid, elevation: .hairline,
                              statusShape: .bar)
        }
    }

    /// Built once: every theme × brightness.
    static let all: [String: ThemeStyle] = {
        var result: [String: ThemeStyle] = [:]
        for id in ThemeID.allCases {
            for dark in id.hasLight ? [false, true] : [true] {
                let style = make(id, dark: dark)
                result[style.key] = style
            }
        }
        return result
    }()

    static func lookup(_ id: ThemeID, dark: Bool) -> ThemeStyle {
        let dark = id.hasLight ? dark : true
        return all["\(id.rawValue)|\(dark ? "dark" : "light")"] ?? make(id, dark: dark)
    }
}

/// The theme on screen. Changes are applied at once; the choice is this device's (UserDefaults), never the server's.
@Observable
final class ThemeStore: @unchecked Sendable {
    static let shared = ThemeStore()
    static let themeKey = "iamceo.theme.id"
    static let brightnessKey = "iamceo.theme.brightness"

    private(set) var choice: ThemeID
    private(set) var brightness: ThemeBrightness
    /// The system's appearance, for '시스템 따라가기'.
    private(set) var systemDark: Bool
    /// What every token reads. Only replaced on the main thread.
    private(set) var style: ThemeStyle
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let persists: Bool

    init(defaults: UserDefaults = .standard, systemDark: Bool? = nil, persists: Bool = true) {
        self.defaults = defaults
        self.persists = persists
        let choice = defaults.string(forKey: Self.themeKey).flatMap(ThemeID.init(rawValue:)) ?? .standard
        let brightness = defaults.string(forKey: Self.brightnessKey).flatMap(ThemeBrightness.init(rawValue:)) ?? .theme
        let system = systemDark ?? Self.systemIsDark()
        self.choice = choice
        self.brightness = brightness
        self.systemDark = system
        self.style = ThemeStyle.lookup(choice, dark: Self.resolveDark(choice, brightness, systemDark: system))
    }

    /// Whether a theme shows dark: the default theme always; otherwise by the brightness choice.
    static func resolveDark(_ choice: ThemeID, _ brightness: ThemeBrightness, systemDark: Bool) -> Bool {
        guard choice.hasLight else { return true }
        switch brightness {
        case .theme: return choice.primaryDark
        case .system: return systemDark
        case .light: return false
        case .dark: return true
        }
    }

    func select(_ id: ThemeID) {
        guard id != choice else { return }
        choice = id
        if persists { defaults.set(id.rawValue, forKey: Self.themeKey) }
        apply()
    }

    func setBrightness(_ value: ThemeBrightness) {
        guard value != brightness else { return }
        brightness = value
        if persists { defaults.set(value.rawValue, forKey: Self.brightnessKey) }
        apply()
    }

    func setSystemDark(_ dark: Bool) {
        guard dark != systemDark else { return }
        systemDark = dark
        apply()
    }

    /// The colour scheme windows are drawn in (system menus, sheets, scroll bars and Liquid Glass follow it).
    var colorScheme: ColorScheme { style.dark ? .dark : .light }
    /// Whether the brightness choice applies (the default theme has no light version).
    var brightnessEnabled: Bool { choice.hasLight }

    private func apply() {
        let next = ThemeStyle.lookup(choice, dark: Self.resolveDark(choice, brightness, systemDark: systemDark))
        if next !== style { style = next }
    }

    /// Tests and screenshots: show a theme without saving it.
    func preview(_ id: ThemeID, dark: Bool) {
        choice = id
        brightness = id.hasLight ? (dark ? .dark : .light) : .theme
        apply()
    }

    static func systemIsDark() -> Bool {
        #if os(macOS)
        // The global setting, not NSApp's appearance: the app's own windows are drawn in the theme's scheme.
        return UserDefaults.standard.string(forKey: "AppleInterfaceStyle")?.lowercased() == "dark"
        #else
        return UITraitCollection.current.userInterfaceStyle != .light
        #endif
    }
}

// MARK: - Screen roots

/// Every window root (main, settings, terminal): the theme's colour scheme, accent tint and type. The default theme gets
/// exactly 0.2.10's modifiers (`.preferredColorScheme(.dark)`, `.tint(CE.accent)`) plus neutral values.
struct ThemeRoot: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    #if os(iOS)
    @Environment(\.colorScheme) private var environmentScheme
    #endif

    func body(content: Content) -> some View {
        let store = ThemeStore.shared
        let style = store.style
        content
            .fontDesign(style.bodyDesign)
            .modifier(ThemeTracking(tracking: style.tracking))
            #if os(iOS)
            .dynamicTypeSize(Self.stepped(typeSize, by: style.dynamicTypeStep))
            // System mode on iPhone: no override, so the environment carries the system's appearance into the store.
            .preferredColorScheme(store.choice.hasLight && store.brightness == .system ? nil : store.colorScheme)
            .onChange(of: environmentScheme, initial: true) { _, scheme in
                if store.choice.hasLight && store.brightness == .system { store.setSystemDark(scheme == .dark) }
            }
            #else
            .preferredColorScheme(store.colorScheme)
            .onReceive(DistributedNotificationCenter.default().publisher(for: Notification.Name("AppleInterfaceThemeChangedNotification"))) { _ in
                store.setSystemDark(ThemeStore.systemIsDark())
            }
            #endif
            .tint(CE.accent)
    }

    /// One Dynamic Type step up per `step`, capped at the largest non-accessibility size the user did not already pass.
    static func stepped(_ size: DynamicTypeSize, by step: Int) -> DynamicTypeSize {
        guard step > 0 else { return size }
        let all = DynamicTypeSize.allCases
        guard let index = all.firstIndex(of: size) else { return size }
        return all[min(all.count - 1, index + step)]
    }
}

private struct ThemeTracking: ViewModifier {
    let tracking: CGFloat?
    func body(content: Content) -> some View {
        content.tracking(tracking ?? 0)
    }
}

extension View {
    func themeRoot() -> some View { modifier(ThemeRoot()) }
}

/// The terminal surface's colours, the same in every theme. What a CLI prints (Claude Code, Codex and Antigravity colour
/// their output with ANSI colours chosen for a dark terminal: dim grey hints, pale yellow and cyan) is unreadable on a
/// light background, so the terminal stays dark even when the window around it is light. These are 0.2.10's values.
enum TerminalColors {
    static let background = Color(red: 11 / 255, green: 9 / 255, blue: 24 / 255)
    static let ink = Color(hex: 0xF5F2FF)
    /// Secondary text on the terminal surface (the default theme's ink2, so 0.2.10 looks the same).
    static let ink2 = Color(hex: 0xC2BBDF)
    static let caret = Color(hex: 0xB9A8FF)
}
