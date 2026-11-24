import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO

/// 0.2.11 기기별 화면 테마: 기본값·저장·불러오기, 기본 테마가 0.2.10 값과 같음, 모든 테마 × 밝기의 대비(글자 4.5,
/// 또렷 7, 상태 3)와 상태 색 구별, 웹 기준선 아래로 내려가지 않음.
final class ThemeTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "ThemeTests-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        suite.removePersistentDomain(forName: suiteName)
        // The shared store backs every token: leave it on the default theme for the other tests.
        ThemeStore.shared.preview(.standard, dark: true)
        super.tearDown()
    }

    // MARK: Choice, saving and loading

    func testDefaultIsTheStandardThemeInDark() {
        let store = ThemeStore(defaults: suite, systemDark: false)
        XCTAssertEqual(store.choice, .standard)
        XCTAssertEqual(store.brightness, .theme)
        XCTAssertTrue(store.style.isStandard)
        XCTAssertTrue(store.style.dark, "기본 테마는 시스템이 밝아도 어둡게")
        XCTAssertEqual(store.colorScheme, .dark)
        XCTAssertFalse(store.brightnessEnabled)
        XCTAssertNil(suite.string(forKey: ThemeStore.themeKey), "고르기 전에는 아무것도 쓰지 않는다")
    }

    func testChoiceIsSavedOnThisDeviceAndLoadedAgain() {
        let store = ThemeStore(defaults: suite, systemDark: false)
        store.select(.workbench)
        store.setBrightness(.light)
        XCTAssertEqual(suite.string(forKey: ThemeStore.themeKey), "workbench")
        XCTAssertEqual(suite.string(forKey: ThemeStore.brightnessKey), "light")
        XCTAssertEqual(store.style.id, .workbench)
        XCTAssertFalse(store.style.dark)

        let reopened = ThemeStore(defaults: suite, systemDark: true)
        XCTAssertEqual(reopened.choice, .workbench)
        XCTAssertEqual(reopened.brightness, .light)
        XCTAssertFalse(reopened.style.dark)
        XCTAssertEqual(reopened.colorScheme, .light)
    }

    func testUnknownStoredValuesFallBackToTheDefault() {
        suite.set("neon", forKey: ThemeStore.themeKey)
        suite.set("dim", forKey: ThemeStore.brightnessKey)
        let store = ThemeStore(defaults: suite, systemDark: false)
        XCTAssertEqual(store.choice, .standard)
        XCTAssertEqual(store.brightness, .theme)
    }

    func testPreviewIsNotSaved() {
        let store = ThemeStore(defaults: suite, systemDark: false, persists: false)
        store.select(.marshmallow)
        store.setBrightness(.dark)
        XCTAssertNil(suite.string(forKey: ThemeStore.themeKey))
        XCTAssertNil(suite.string(forKey: ThemeStore.brightnessKey))
        XCTAssertEqual(store.style.id, .marshmallow)
        XCTAssertTrue(store.style.dark)
    }

    func testBrightness() {
        // 테마 기본: 서리 유리·말랑 밝게, 작업대·또렷 어둡게. 기본 테마는 무엇을 골라도 어둡게.
        XCTAssertFalse(ThemeStore.resolveDark(.frost, .theme, systemDark: true))
        XCTAssertFalse(ThemeStore.resolveDark(.marshmallow, .theme, systemDark: true))
        XCTAssertTrue(ThemeStore.resolveDark(.workbench, .theme, systemDark: false))
        XCTAssertTrue(ThemeStore.resolveDark(.contrast, .theme, systemDark: false))
        for brightness in ThemeBrightness.allCases {
            XCTAssertTrue(ThemeStore.resolveDark(.standard, brightness, systemDark: false))
        }
        XCTAssertTrue(ThemeStore.resolveDark(.frost, .system, systemDark: true))
        XCTAssertFalse(ThemeStore.resolveDark(.frost, .system, systemDark: false))
        XCTAssertFalse(ThemeStore.resolveDark(.contrast, .light, systemDark: true))
        XCTAssertTrue(ThemeStore.resolveDark(.frost, .dark, systemDark: false))

        let store = ThemeStore(defaults: suite, systemDark: false)
        store.select(.frost)
        store.setBrightness(.system)
        XCTAssertFalse(store.style.dark)
        store.setSystemDark(true)
        XCTAssertTrue(store.style.dark, "시스템 따라가기는 시스템이 바뀌면 곧바로 따라간다")
        store.select(.standard)
        store.setSystemDark(false)
        XCTAssertTrue(store.style.dark)
        XCTAssertFalse(store.brightnessEnabled)
    }

    func testEveryThemeAndBrightnessExists() {
        XCTAssertEqual(ThemeID.allCases.count, 5)
        XCTAssertEqual(ThemeStyle.all.count, 9, "기본은 어둡게 하나, 나머지 넷은 밝게·어둡게")
        for id in ThemeID.allCases {
            for dark in [false, true] {
                let style = ThemeStyle.lookup(id, dark: dark)
                XCTAssertEqual(style.id, id)
                XCTAssertEqual(style.dark, id == .standard ? true : dark)
            }
        }
        XCTAssertEqual(ThemeID.frost.rawValue, "frosted-glass")
        XCTAssertEqual(ThemeID.contrast.rawValue, "aaa-contrast")
    }

    // MARK: The default theme is 0.2.10

    func testStandardTokensAreThe0210Values() {
        ThemeStore.shared.preview(.standard, dark: true)
        // The literal values of 0.2.10's `enum CE` (Design/Theme.swift at 8155283).
        let expected: [(String, Color, Color)] = [
            ("bg", CE.bg, Color(hex: 0x090713)),
            ("bgDeep", CE.bgDeep, Color(hex: 0x05040B)),
            ("plateSolid", CE.plateSolid, Color(hex: 0x16112C)),
            ("plateRaisedSolid", CE.plateRaisedSolid, Color(hex: 0x1D1638)),
            ("plate", CE.plate, Color.white.opacity(0.045)),
            ("plateRaised", CE.plateRaised, Color.white.opacity(0.08)),
            ("line", CE.line, Color.white.opacity(0.08)),
            ("lineStrong", CE.lineStrong, Color.white.opacity(0.14)),
            ("ink", CE.ink, Color(hex: 0xF5F2FF)),
            ("ink2", CE.ink2, Color(hex: 0xC2BBDF)),
            ("ink3", CE.ink3, Color(hex: 0x8F88B2)),
            ("accent", CE.accent, Color(hex: 0xB9A8FF)),
            ("accentFill", CE.accentFill, Color(hex: 0x6D4DF2)),
            ("violet", CE.violet, Color(hex: 0x7A5BFF)),
            ("orchid", CE.orchid, Color(hex: 0xB35CFF)),
            ("indigo", CE.indigo, Color(hex: 0x3D45FF)),
            ("rose", CE.rose, Color(hex: 0xFF6FB8)),
            ("ice", CE.ice, Color(hex: 0xA8ECFF)),
            ("live", CE.live, Color(hex: 0xB9A8FF)),
            ("attention", CE.attention, Color(hex: 0xFFB070)),
            ("approval", CE.approval, Color(hex: 0xFF8A80)),
            ("danger", CE.danger, Color(hex: 0xFF8A9B)),
            ("error", CE.error, Color(hex: 0xFF5A62)),
            ("success", CE.success, Color(hex: 0x6FE3B2)),
            ("warn", CE.warn, Color(hex: 0xFFC773)),
            ("idle", CE.idle, Color(hex: 0xA6A6AE)),
            ("dim", CE.dim, Color(hex: 0x8F88B2)),
            ("glassTint", CE.glassTint, Color(red: 9 / 255, green: 7 / 255, blue: 19 / 255)),
            ("cardTint", CE.cardTint, Color(red: 13 / 255, green: 8 / 255, blue: 46 / 255)),
            ("wash", CE.wash, Color.white),
            ("onAccent", CE.onAccent, Color.white),
            ("onSelection", CE.onSelection, Color.white),
            // The chat palette of 0.2.10 (ChatView ChatPalette), now theme tokens.
            ("ownerBubble", CE.palette.ownerBubble, Color(red: 72 / 255, green: 50 / 255, blue: 176 / 255).opacity(0.9)),
            ("ownerMuted", CE.palette.ownerMuted, Color(hex: 0xDAD2FF)),
            ("ownerCode", CE.palette.ownerCode, Color(red: 9 / 255, green: 7 / 255, blue: 19 / 255).opacity(0.35)),
            ("leadBubble", CE.palette.leadBubble, Color(red: 15 / 255, green: 11 / 255, blue: 32 / 255).opacity(0.72)),
            ("warmFill", CE.palette.warmFill, Color(red: 58 / 255, green: 28 / 255, blue: 16 / 255).opacity(0.94)),
        ]
        for (name, actual, old) in expected {
            XCTAssertEqual(actual, old, name)
        }
        XCTAssertEqual([CESpace.xs, CESpace.s, CESpace.m, CESpace.l, CESpace.xl, CESpace.xxl], [4, 8, 12, 16, 20, 28])
        XCTAssertEqual([CERadius.plate, CERadius.card, CERadius.control, CERadius.row], [22, 18, 12, 10])
        for value: CGFloat in [1, 3.5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 18, 20, 22, 26, 30] {
            XCTAssertEqual(CERadius.r(value), value)
        }
        XCTAssertEqual(CELeading.body, 4.5)
        XCTAssertEqual(CELeading.note, 3.5)
        XCTAssertEqual(CELeading.secondary, 3.5)
        XCTAssertEqual(CELeading.meta, 2.5)
        XCTAssertEqual(CELeading.title, 2.5)
        XCTAssertEqual(CELeading.spacing(15, 1.65), 6.5, "0.2.10: 15 × (1.65 − 1.2) = 6.749…, to the half point")
        #if os(macOS)
        XCTAssertEqual(CEFont.pageTitle, Font.system(size: 17, weight: .semibold))
        XCTAssertEqual(CEFont.title, Font.system(size: 16.5, weight: .semibold))
        XCTAssertEqual(CEFont.section, Font.system(size: 14, weight: .semibold))
        XCTAssertEqual(CEFont.rowTitle, Font.system(size: 14.5, weight: .semibold))
        XCTAssertEqual(CEFont.body, Font.system(size: 14.5))
        XCTAssertEqual(CEFont.note, Font.system(size: 13.5))
        XCTAssertEqual(CEFont.secondary, Font.system(size: 13))
        XCTAssertEqual(CEFont.meta, Font.system(size: 12.5))
        XCTAssertEqual(CEFont.caption, Font.system(size: 12))
        XCTAssertEqual(CEFont.micro, Font.system(size: 11.5, weight: .bold))
        XCTAssertEqual(CEFont.mono, Font.system(size: 12.5, design: .monospaced))
        XCTAssertEqual(CEFont.number, Font.system(size: 20, weight: .semibold, design: .rounded))
        XCTAssertEqual(CEFont.heading1, Font.system(size: 16, weight: .semibold))
        XCTAssertEqual(Font.ceSystem(size: 13.5, weight: .medium), Font.system(size: 13.5, weight: .medium))
        #else
        XCTAssertEqual(CEFont.pageTitle, Font.headline)
        XCTAssertEqual(CEFont.body, Font.subheadline)
        XCTAssertEqual(CEFont.rowTitle, Font.subheadline.weight(.semibold))
        XCTAssertEqual(CEFont.meta, Font.caption)
        XCTAssertEqual(CEFont.micro, Font.caption2.weight(.bold))
        XCTAssertEqual(CEFont.heading1, Font.title3.weight(.semibold))
        #endif
        let style = CE.style
        XCTAssertEqual(style.fontScale, 1)
        XCTAssertEqual(style.lineBoost, 0)
        XCTAssertEqual(style.spaceScale, 1)
        XCTAssertNil(style.bodyDesign)
        XCTAssertNil(style.tracking)
        XCTAssertFalse(style.squareCapsules)
        XCTAssertEqual(style.borderWidth, 1)
    }

    func testCapsuleIsUnchangedInTheDefaultThemeAndSquaredInTheSquaredThemes() {
        let rect = CGRect(x: 0, y: 0, width: 80, height: 24)
        ThemeStore.shared.preview(.standard, dark: true)
        XCTAssertEqual(CECapsule().path(in: rect), Capsule().path(in: rect))
        XCTAssertEqual(CECapsule().inset(by: 2).path(in: rect), Capsule().inset(by: 2).path(in: rect))
        ThemeStore.shared.preview(.workbench, dark: true)
        XCTAssertEqual(CECapsule().path(in: rect), RoundedRectangle(cornerRadius: 5, style: .continuous).path(in: rect))
        ThemeStore.shared.preview(.frost, dark: false)
        XCTAssertEqual(CECapsule().path(in: rect), Capsule().path(in: rect))
    }

    func testTokensFollowTheThemeOnScreen() {
        ThemeStore.shared.preview(.frost, dark: false)
        XCTAssertEqual(CE.bg, Color(hex: 0xEDF2F6))
        XCTAssertEqual(CE.ink, Color(hex: 0x15202B))
        XCTAssertEqual(CE.wash, Color(hex: 0x15202B), "밝은 테마의 덮개 잉크는 글자색")
        ThemeStore.shared.preview(.frost, dark: true)
        XCTAssertEqual(CE.bg, Color(hex: 0x0E141B))
        XCTAssertEqual(CE.wash, Color(hex: 0xFFFFFF))
        ThemeStore.shared.preview(.contrast, dark: false)
        XCTAssertEqual(CE.borderWidth, 2)
        #if os(macOS)
        XCTAssertEqual(CEFont.body, Font.system(size: 14.5 * 17 / 15), "또렷은 기본 17pt")
        #endif
        ThemeStore.shared.preview(.standard, dark: true)
        XCTAssertEqual(CE.bg, Color(hex: 0x090713))
    }

    // MARK: Never under the web baseline

    func testNoThemeGoesUnderTheWebBaseline() {
        // The web values as the default theme draws them (0.2.10's native numbers).
        ThemeStore.shared.preview(.standard, dark: true)
        let web = (space: [CGFloat(4), 8, 12, 16, 20, 28], body: CELeading.body, markdown: CELeading.spacing(15, 1.65), meta: CELeading.meta)
        XCTAssertEqual(web.body, 4.5)
        XCTAssertEqual(web.markdown, 6.5)
        for id in ThemeID.allCases {
            for dark in [false, true] {
                ThemeStore.shared.preview(id, dark: dark)
                let name = "\(id.rawValue) \(dark ? "dark" : "light")"
                let style = CE.style
                XCTAssertGreaterThanOrEqual(style.fontScale, 1, name)
                XCTAssertGreaterThanOrEqual(style.lineBoost, 0, name)
                XCTAssertGreaterThanOrEqual(style.spaceScale, 1, name)
                let space = [CESpace.xs, CESpace.s, CESpace.m, CESpace.l, CESpace.xl, CESpace.xxl]
                for (value, floor) in zip(space, web.space) { XCTAssertGreaterThanOrEqual(value, floor, name) }
                XCTAssertGreaterThanOrEqual(CELeading.body, web.body, name)
                XCTAssertGreaterThanOrEqual(CELeading.spacing(15, 1.65), web.markdown, name)
                XCTAssertGreaterThanOrEqual(CELeading.meta, web.meta, name)
                // Line height as a ratio of the (scaled) size never drops under the web's either.
                let size = 14.5 * style.leadingScale
                XCTAssertGreaterThanOrEqual((size * 1.2 + CELeading.body) / size, 1.5 - 0.035, name)
            }
        }
    }

    // MARK: Contrast (WCAG 2)

    func testTextContrastInEveryThemeAndBrightness() throws {
        for (name, p, style) in themedPalettes() {
            let textMin = style.id == .contrast ? 7.0 : 4.5
            let surfaces = [p.bg, p.surface, p.surfaceAlt, p.sidebar, p.chipBg, p.leadBubble]
            let washed = surfaces.map { over(p.wash, 0.08, $0) }
            for (token, color) in [("ink", p.ink), ("ink2", p.ink2), ("ink3", p.ink3)] {
                for surface in surfaces + washed {
                    XCTAssertGreaterThanOrEqual(contrast(color, surface), textMin, "\(name) \(token)")
                }
            }
            for (token, color) in [("accent", p.accent), ("live", p.live), ("attention", p.attention), ("approval", p.approval),
                                   ("danger", p.danger), ("success", p.success), ("warn", p.warn)] {
                for surface in surfaces + washed {
                    XCTAssertGreaterThanOrEqual(contrast(color, surface), textMin, "\(name) \(token) as text")
                }
            }
            // Text on fills.
            XCTAssertGreaterThanOrEqual(contrast(p.onAccent, p.accentFill), 4.5, "\(name) onAccent")
            XCTAssertGreaterThanOrEqual(contrast(p.onError, p.error), 4.5, "\(name) onError")
            let onStatus = style.dark ? p.bg : RGB(r: 1, g: 1, b: 1)
            XCTAssertGreaterThanOrEqual(contrast(onStatus, p.attention), 4.5, "\(name) onStatus on attention")
            XCTAssertGreaterThanOrEqual(contrast(onStatus, p.success), 4.5, "\(name) onStatus on success")
            XCTAssertGreaterThanOrEqual(contrast(p.onOwnerBubble, p.ownerBubble), 4.5, "\(name) my bubble")
            XCTAssertGreaterThanOrEqual(contrast(p.ownerMuted, p.ownerBubble), 4.5, "\(name) my bubble's target line")
            XCTAssertGreaterThanOrEqual(contrast(p.onOwnerBubble, p.ownerCode), 4.5, "\(name) code on my bubble")
            XCTAssertGreaterThanOrEqual(contrast(p.onLeadBubble, p.leadBubble), 4.5, "\(name) report card")
            XCTAssertGreaterThanOrEqual(contrast(p.codeText, p.codeBg), 4.5, "\(name) code block")
            XCTAssertGreaterThanOrEqual(contrast(p.codeText, p.chipBg), 4.5, "\(name) inline code")
            XCTAssertGreaterThanOrEqual(contrast(p.ink, p.warmFill), 4.5, "\(name) connection strip")
            // Selected rows, tabs and choices: the selection wash under ink.
            for alpha in [0.14, 0.18, 0.32, 0.42, 0.5] {
                for surface in [p.bg, p.surface, p.surfaceAlt, p.sidebar] {
                    XCTAssertGreaterThanOrEqual(contrast(p.onSelection, over(p.violet, alpha, surface)), 4.5, "\(name) selection \(alpha)")
                }
            }
        }
    }

    func testStatusColoursKeepTheirMeaningInEveryThemeAndBrightness() throws {
        for (name, p, _) in themedPalettes() {
            let surfaces = [p.bg, p.surface, p.surfaceAlt, p.sidebar]
            let states = [("live", p.live), ("attention", p.attention), ("approval", p.approval), ("danger", p.danger),
                          ("error", p.error), ("success", p.success), ("warn", p.warn), ("idle", p.idle), ("dim", p.dim)]
            for (token, color) in states {
                for surface in surfaces {
                    XCTAssertGreaterThanOrEqual(contrast(color, surface), 3.0, "\(name) \(token) mark")
                }
            }
            // Status words on their own tinted capsule (14%).
            for (token, color) in [("live", p.live), ("attention", p.attention), ("approval", p.approval), ("danger", p.danger), ("success", p.success)] {
                for surface in [p.bg, p.surface, p.sidebar, p.leadBubble] {
                    XCTAssertGreaterThanOrEqual(contrast(color, over(color, 0.14, surface)), 4.5, "\(name) \(token) pill")
                }
            }
            // Member states (일하는 중 · 내 답 기다림 · 승인 창 앞 · 오류 · 쉬는 중) stay apart from each other; 잠듦 is a hollow
            // ring, so its colour may sit near 쉬는 중's. The default theme's closest pair (승인 창 앞/오류) is ΔE ≈ 8.
            let member = [("live", p.live), ("attention", p.attention), ("approval", p.approval), ("danger", p.danger), ("idle", p.idle)]
            for i in member.indices {
                for j in member.indices where j > i {
                    XCTAssertGreaterThanOrEqual(deltaE(member[i].1, member[j].1), 8, "\(name) \(member[i].0)/\(member[j].0)")
                }
            }
            // Delivery: 받음 · 보류 · 실패.
            let delivery = [("success", p.success), ("warn", p.warn), ("danger", p.danger)]
            for i in delivery.indices {
                for j in delivery.indices where j > i {
                    XCTAssertGreaterThanOrEqual(deltaE(delivery[i].1, delivery[j].1), 15, "\(name) \(delivery[i].0)/\(delivery[j].0)")
                }
            }
            // The focus ring and accent marks stand out from the surfaces.
            for surface in surfaces { XCTAssertGreaterThanOrEqual(contrast(p.accent, surface), 3.0, "\(name) accent ring") }
        }
    }

    func testDefaultThemeKeepsItsTextReadable() throws {
        ThemeStore.shared.preview(.standard, dark: true)
        let p = try resolvedPalette(CE.palette)
        for surface in [p.bg, p.plateSolid, p.plateRaisedSolid] {
            XCTAssertGreaterThanOrEqual(contrast(p.ink, surface), 4.5)
            XCTAssertGreaterThanOrEqual(contrast(p.ink2, surface), 4.5)
            XCTAssertGreaterThanOrEqual(contrast(p.ink3, surface), 4.5)
        }
        XCTAssertGreaterThanOrEqual(contrast(RGB(r: 1, g: 1, b: 1), p.accentFill), 4.5)
    }

    /// The generated palettes draw exactly the values the table holds (what the contrast tests measure is what is drawn).
    func testGeneratedPalettesDrawTheirTableValues() throws {
        for id in ThemeID.allCases where id != .standard {
            for dark in [false, true] {
                let palette = ThemeStyle.lookup(id, dark: dark).palette
                let table = try XCTUnwrap(palette.hex)
                XCTAssertEqual(Set(table.keys), Set(ThemePalette.Key.allCases))
                let resolved = try resolvedPalette(palette)
                XCTAssertEqual(resolved.bg, RGB(hex: try XCTUnwrap(table[.bg])))
                XCTAssertEqual(resolved.ink3, RGB(hex: try XCTUnwrap(table[.ink3])))
                XCTAssertEqual(resolved.attention, RGB(hex: try XCTUnwrap(table[.attention])))
            }
        }
    }

    // MARK: Helpers

    private func themedPalettes() -> [(String, Resolved, ThemeStyle)] {
        var result: [(String, Resolved, ThemeStyle)] = []
        for id in ThemeID.allCases where id != .standard {
            for dark in [false, true] {
                let style = ThemeStyle.lookup(id, dark: dark)
                guard let palette = try? resolvedPalette(style.palette) else { XCTFail("resolve \(id)"); continue }
                result.append(("\(id.rawValue) \(dark ? "dark" : "light")", palette, style))
            }
        }
        XCTAssertEqual(result.count, 8)
        return result
    }
}

/// An sRGB colour with 0…1 components (alpha folded in by `over`).
private struct RGB: Equatable {
    var r, g, b: Double
    init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
    init(hex: UInt32) {
        r = Double((hex >> 16) & 255) / 255; g = Double((hex >> 8) & 255) / 255; b = Double(hex & 255) / 255
    }
    static func == (a: RGB, b: RGB) -> Bool {
        abs(a.r - b.r) < 0.003 && abs(a.g - b.g) < 0.003 && abs(a.b - b.b) < 0.003
    }
}

/// A palette's colours resolved to sRGB (opaque tokens; translucent ones keep their alpha in `alpha`).
@dynamicMemberLookup
private struct Resolved {
    let colors: [ThemePalette.Key: (RGB, Double)]
    subscript(dynamicMember key: String) -> RGB {
        guard let token = ThemePalette.Key(rawValue: key), let value = colors[token] else { return RGB(r: 1, g: 0, b: 1) }
        return value.0
    }
}

private func resolvedPalette(_ palette: ThemePalette) throws -> Resolved {
    var colors: [ThemePalette.Key: (RGB, Double)] = [:]
    let mirror = Mirror(reflecting: palette)
    var byName: [String: Color] = [:]
    for child in mirror.children {
        if let label = child.label, let color = child.value as? Color { byName[label] = color }
    }
    for key in ThemePalette.Key.allCases {
        let color = try XCTUnwrap(byName[key.rawValue], "token \(key)")
        colors[key] = try srgb(color)
    }
    return Resolved(colors: colors)
}

private func srgb(_ color: Color) throws -> (RGB, Double) {
    let resolved = color.resolve(in: EnvironmentValues())
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let converted = try XCTUnwrap(resolved.cgColor.converted(to: space, intent: .defaultIntent, options: nil))
    let c = try XCTUnwrap(converted.components)
    return (RGB(r: Double(c[0]), g: Double(c[1]), b: Double(c[2])), Double(c.count > 3 ? c[3] : 1))
}

/// `top` at `alpha` over an opaque `bottom`.
private func over(_ top: RGB, _ alpha: Double, _ bottom: RGB) -> RGB {
    RGB(r: top.r * alpha + bottom.r * (1 - alpha), g: top.g * alpha + bottom.g * (1 - alpha), b: top.b * alpha + bottom.b * (1 - alpha))
}

private func luminance(_ c: RGB) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/// WCAG 2 contrast ratio.
private func contrast(_ a: RGB, _ b: RGB) -> Double {
    let la = luminance(a), lb = luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}

/// CIE76 colour difference in CIELAB (D65).
private func deltaE(_ a: RGB, _ b: RGB) -> Double {
    func lab(_ c: RGB) -> (Double, Double, Double) {
        func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let r = linear(c.r), g = linear(c.g), b = linear(c.b)
        let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
        func f(_ t: Double) -> Double { t > 0.008856 ? pow(t, 1.0 / 3) : 7.787 * t + 16.0 / 116 }
        return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))
    }
    let p = lab(a), q = lab(b)
    return ((p.0 - q.0) * (p.0 - q.0) + (p.1 - q.1) * (p.1 - q.1) + (p.2 - q.2) * (p.2 - q.2)).squareRoot()
}
