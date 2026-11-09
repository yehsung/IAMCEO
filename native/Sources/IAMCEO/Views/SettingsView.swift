import SwiftUI
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor @Observable
final class SettingsNavigation {
    static let shared = SettingsNavigation()
    var pendingRuntime = false
    private(set) var revision = 0
    func requestRuntime() { pendingRuntime = true; revision &+= 1 }
}

enum SettingsCloseAction: Equatable {
    case close, confirm, wait
    static func resolve(dirty: Bool, saving: Bool) -> Self {
        saving ? .wait : dirty ? .confirm : .close
    }
}

#if os(macOS)
/// Intercepts the title-bar close and Command-W without changing the app's other windows.
private struct SettingsCloseGuard: NSViewRepresentable {
    let dirty: Bool
    let saving: Bool
    let onWindow: (NSWindow) -> Void
    let onClose: () -> Void

    final class HostView: NSView {
        var installed: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { installed?(window) }
        }
    }
    @MainActor final class Coordinator: NSObject, NSWindowDelegate {
        var owner: SettingsCloseGuard
        weak var window: NSWindow?
        // NSObject's forwarding hooks are nonisolated; they only read this weak reference.
        nonisolated(unsafe) weak var previous: (any NSWindowDelegate)?
        init(_ owner: SettingsCloseGuard) { self.owner = owner }
        func attach(_ window: NSWindow) {
            guard self.window !== window || window.delegate !== self else { return }
            if self.window !== window { restore() }
            self.window = window; previous = window.delegate; window.delegate = self
            Task { @MainActor in owner.onWindow(window) }
        }
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            switch SettingsCloseAction.resolve(dirty: owner.dirty, saving: owner.saving) {
            case .wait: return false
            case .confirm: owner.onClose(); return false
            case .close: return previous?.windowShouldClose?(sender) ?? true
            }
        }
        nonisolated override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || previous?.responds(to: selector) == true
        }
        nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
            previous?.responds(to: selector) == true ? previous : super.forwardingTarget(for: selector)
        }
        func restore() {
            if let window, window.delegate === self { window.delegate = previous }
            window = nil; previous = nil
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> HostView {
        let view = HostView()
        view.installed = { [weak coordinator = context.coordinator] in coordinator?.attach($0) }
        return view
    }
    func updateNSView(_ view: HostView, context: Context) {
        context.coordinator.owner = self
        if let window = view.window {
            context.coordinator.attach(window)
            window.isDocumentEdited = dirty
        }
    }
    static func dismantleNSView(_ view: HostView, coordinator: Coordinator) { coordinator.restore() }
}
#endif

// Connection and New project share the web's setup look (web/src/styles/setup.css): labelled dark input wells in a
// glass card. Settings is a list of System Settings rows (title and one quiet hint left, the control right) grouped in
// cards, in four parts, with a sticky glass save bar.

// MARK: - Shared setup pieces

/// Type of the setup and settings screens (web setup.css / shell.css form sizes).
enum SetupFont {
    #if os(macOS)
    /// web .su-brand 13/700.
    static let brand: Font = .system(size: 13, weight: .bold)
    /// web .su-title 24/680.
    static let title: Font = .system(size: 24, weight: .bold)
    /// web .su-lead 14.5 at 1.55.
    static let lead: Font = .system(size: 14.5)
    /// web .field__label 13/600 ink-2.
    static let label: Font = .system(size: 13, weight: .semibold)
    /// Row titles (web .st-pj__name, .st-rank__who 14.5/620).
    static let row: Font = .system(size: 14.5, weight: .semibold)
    /// web .st-panel__title 16/650: the caption of a settings group.
    static let caption: Font = .system(size: 16, weight: .semibold)
    /// Choice tile titles (web .choice 14/600).
    static let choice: Font = .system(size: 14, weight: .semibold)
    /// Typed text in a full-size well (web .input 15).
    static let input: Font = .system(size: 15)
    /// Values in the compact wells and menus inside a settings row.
    static let select: Font = .system(size: 14)
    /// Plain values at the right of a row (web .st-facts dd 14).
    static let value: Font = .system(size: 14)
    /// Hints and helper text (web .su-hint 12.5 at 1.5, ink-2).
    static let hint: Font = .system(size: 12.5)
    /// Addresses and versions shown as values.
    static let code: Font = .system(size: 13, design: .monospaced)
    /// Paths and addresses typed in a full-size well.
    static let codeInput: Font = .system(size: 13.5, design: .monospaced)
    #else
    static let brand: Font = .footnote.weight(.bold)
    static let title: Font = .title2.weight(.bold)
    static let lead: Font = .subheadline
    static let label: Font = .footnote.weight(.semibold)
    static let row: Font = .subheadline.weight(.semibold)
    static let caption: Font = .callout.weight(.semibold)
    static let choice: Font = .subheadline.weight(.semibold)
    static let input: Font = .subheadline
    static let select: Font = .subheadline
    static let value: Font = .subheadline
    static let hint: Font = .caption
    static let code: Font = .system(.footnote, design: .monospaced)
    static let codeInput: Font = .system(.subheadline, design: .monospaced)
    #endif
    /// Line spacing of a wrapping hint (12.5 at 1.5).
    static let hintLeading = CELeading.spacing(12.5, 1.5)
    /// Line spacing of a choice tile's description (12.5 at 1.4).
    static let choiceLeading = CELeading.spacing(12.5, 1.4)
}

private enum SetupMetrics {
    #if os(macOS)
    static let inputHeight: CGFloat = 44
    /// Menus and fields inside a settings row.
    static let rowControlHeight: CGFloat = 32
    /// Card padding of a settings group; captions and footnotes line up with it.
    static let groupInset: CGFloat = 20
    #else
    static let inputHeight: CGFloat = 44
    static let rowControlHeight: CGFloat = 44
    static let groupInset: CGFloat = 16
    #endif
}

extension View {
    /// A small dark well for a value typed inside a settings row (a number): web .input at row height, accent ring
    /// while focused.
    func settingsWell(focused: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return self.textFieldStyle(.plain)
            .padding(.horizontal, 11)
            .frame(height: SetupMetrics.rowControlHeight)
            .background(CE.bgDeep.opacity(0.5), in: shape)
            .overlay {
                shape.strokeBorder(focused ? CE.accent.opacity(0.85) : Color.white.opacity(0.12), lineWidth: focused ? 1.5 : 1)
            }
    }

    /// The on/off switch of a settings row: violet, small on Mac like System Settings.
    @ViewBuilder func settingsSwitch() -> some View {
        #if os(macOS)
        self.toggleStyle(.switch).controlSize(.small).tint(CE.violet)
        #else
        self.toggleStyle(.switch).tint(CE.violet)
        #endif
    }
}

// MARK: - Settings rows (System Settings style)

/// A group of settings rows in one card: an optional caption with an optional trailing accessory above it and an
/// optional footnote below. Captions and footnotes line up with the row text inside the card. Separate rows with
/// `RowDivider(inset: 0)`.
struct SettingsGroup<Accessory: View, Content: View>: View {
    let title: String?
    let footnote: String?
    let footnoteTone: Color
    let accessory: Accessory
    let content: Content

    init(_ title: String? = nil, footnote: String? = nil, footnoteTone: Color = CE.ink2,
         @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footnote = footnote
        self.footnoteTone = footnoteTone
        self.accessory = accessory()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if title != nil || Accessory.self != EmptyView.self {
                // web .st-panel__title: 16/650 ink-1, tracking -.012em.
                HStack(alignment: .center, spacing: 8) {
                    if let title {
                        Text(title).font(SetupFont.caption).tracking(isMac ? -0.2 : 0).foregroundStyle(CE.ink).lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                    }
                    Spacer(minLength: 8)
                    accessory
                }
                .frame(minHeight: 22)
                .padding(.horizontal, SetupMetrics.groupInset)
            }
            Plate(padding: 0) {
                VStack(alignment: .leading, spacing: 0) { content }
                    .padding(.horizontal, SetupMetrics.groupInset)
                    .padding(.vertical, 4)
            }
            if let footnote, !footnote.isEmpty {
                Text(footnote).font(SetupFont.hint).foregroundStyle(footnoteTone)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, SetupMetrics.groupInset)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension SettingsGroup where Accessory == EmptyView {
    init(_ title: String? = nil, footnote: String? = nil, footnoteTone: Color = CE.ink2, @ViewBuilder content: () -> Content) {
        self.init(title, footnote: footnote, footnoteTone: footnoteTone, accessory: { EmptyView() }, content: content)
    }
}

/// One settings row: title and at most one short hint on the left, the control on the right. On iPhone a wide control
/// either goes under the title (`stacksOnPhone`) or keeps the title's line while the hint runs under both
/// (`hintBelowOnPhone`, for a number and its stepper). `stacked` puts the control under the title everywhere (a row of
/// choice tiles). A `monoHint` is diagnostic text the owner may need to paste.
struct SettingsRow<Control: View>: View {
    let title: String
    let hint: String?
    let hintTone: Color
    let monoHint: Bool
    let stacked: Bool
    let stacksOnPhone: Bool
    let hintBelowOnPhone: Bool
    let control: Control

    init(_ title: String, hint: String? = nil, hintTone: Color = CE.ink2, monoHint: Bool = false, stacked: Bool = false,
         stacksOnPhone: Bool = false, hintBelowOnPhone: Bool = false, @ViewBuilder control: () -> Control) {
        self.title = title
        self.hint = hint
        self.hintTone = hintTone
        self.monoHint = monoHint
        self.stacked = stacked
        self.stacksOnPhone = stacksOnPhone
        self.hintBelowOnPhone = hintBelowOnPhone
        self.control = control()
    }

    var body: some View {
        Group {
            if stacked || (!isMac && stacksOnPhone) {
                VStack(alignment: .leading, spacing: isMac ? 12 : 10) {
                    label
                    control
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if !isMac && hintBelowOnPhone {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .center, spacing: 16) {
                        titleText.frame(maxWidth: .infinity, alignment: .leading)
                        control
                    }
                    hintText
                }
            } else {
                HStack(alignment: .center, spacing: 16) {
                    label.frame(maxWidth: .infinity, alignment: .leading)
                    control
                }
            }
        }
        // web .st-pj: min-height 60 around 44pt controls; rows here hold 32pt controls.
        .padding(.vertical, 12)
        .frame(minHeight: isMac ? 56 : 52)
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 3) {
            titleText
            hintText
        }
    }

    private var titleText: some View { Text(title).font(SetupFont.row).foregroundStyle(CE.ink) }

    @ViewBuilder private var hintText: some View {
        if let hint, !hint.isEmpty {
            if monoHint {
                Text(hint).font(CEFont.mono).foregroundStyle(hintTone)
                    .ceLineHeight(12.5, 1.45)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else {
                Text(hint).font(SetupFont.hint).foregroundStyle(hintTone)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The small round "다시 확인" of a settings card (↻; a spinner while it runs). iPhone keeps a 44pt target.
struct SettingsRefreshButton: View {
    let label: String
    let busy: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Button(action: action) {
            ZStack {
                if busy {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise").font(.system(size: 10.5, weight: .bold))
                }
            }
            .foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
            .frame(width: 26, height: 26)
            .background(Color.white.opacity(isEnabled ? 0.07 : 0.03), in: Circle())
            .overlay { Circle().strokeBorder(Color.white.opacity(0.07)) }
            .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(busy ? "\(label), 확인하는 중" : label)
    }
}

/// A short choice of a few words (총괄 CLI): the app's segment pill with the violet drop on the chosen item. `fill`
/// stretches it across a form field, as tall as an input (web select 44).
private struct SettingsSegments: View {
    struct Option: Identifiable {
        let id: String
        let title: String
    }
    let options: [Option]
    let selection: String
    let label: String
    var fill = false
    let onSelect: (String) -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Namespace private var dropSpace

    var body: some View {
        let stretch = fill || !isMac
        HStack(spacing: 0) {
            ForEach(options) { option in
                let selected = option.id == selection
                Button { onSelect(option.id) } label: {
                    Text(option.title)
                        .font(.system(size: isMac ? (fill ? 14 : 13.5) : 14, weight: selected ? .semibold : .medium))
                        .foregroundStyle(selected ? Color.white : CE.ink2)
                        .lineLimit(1)
                        .padding(.horizontal, isMac ? 14 : 12)
                        .frame(maxWidth: stretch ? .infinity : nil)
                        .frame(height: isMac ? (fill ? 38 : 32) : 38)
                        .background { if selected { TabDrop().matchedGeometryEffect(id: "drop", in: dropSpace) } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(3)
        .cardPill()
        .opacity(isEnabled ? 1 : 0.55)
        .animation(.spring(response: 0.4, dampingFraction: 0.82), value: selection)
        .fixedSize(horizontal: !stretch, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// A choice of a few options that each need a line of explanation (권한): equal tiles side by side on Mac, stacked on
/// iPhone (web .st-perms / .choice: radius 13, padding 11/13, 14/600 title with an optional badge, 12.5 ink-2 line;
/// the chosen tile is violet .24 with a 1.5pt violet ring).
private struct SettingsChoiceTiles: View {
    struct Option: Identifiable {
        let id: String
        let title: String
        let detail: String
        var badge: String? = nil
    }
    let options: [Option]
    let selection: String
    let label: String
    let onSelect: (String) -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        let layout = isMac ? AnyLayout(HStackLayout(alignment: .top, spacing: 8)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        layout {
            ForEach(options) { option in tile(option) }
        }
        // Mac: every tile as tall as the tallest one.
        .fixedSize(horizontal: false, vertical: true)
        .animation(.easeOut(duration: 0.12), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private func tile(_ option: Option) -> some View {
        let selected = option.id == selection
        return Button { onSelect(option.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(option.title).font(SetupFont.choice).foregroundStyle(isEnabled ? CE.ink : CE.ink3).lineLimit(1)
                    if let badge = option.badge { Tag(badge) }
                }
                .frame(minHeight: 20)
                Text(option.detail).font(SetupFont.hint).foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
                    .lineSpacing(SetupFont.choiceLeading)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .frame(minHeight: isMac ? nil : 44)
        }
        .buttonStyle(ChoiceTileStyle(selected: selected))
        .accessibilityLabel(option.badge.map { "\(option.title), \($0)" } ?? option.title)
        .accessibilityHint(option.detail)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A picked option among several (web .choice): white .04 with a white .1 ring, white .06 on hover; picked: violet .24
/// with a 1.5pt violet .9 ring.
private struct ChoiceTileStyle: ButtonStyle {
    var selected = false
    var radius: CGFloat = 13
    func makeBody(configuration: Configuration) -> some View {
        TileBody(configuration: configuration, selected: selected, radius: radius)
    }
    private struct TileBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let radius: CGFloat
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            let idle = configuration.isPressed ? 0.09 : hovering && isEnabled ? 0.065 : 0.04
            configuration.label
                .contentShape(shape)
                .background(selected ? CE.violet.opacity(configuration.isPressed ? 0.3 : 0.24) : Color.white.opacity(idle), in: shape)
                .overlay {
                    shape.strokeBorder(selected ? CE.violet.opacity(0.9) : Color.white.opacity(hovering && isEnabled ? 0.16 : 0.1),
                                       lineWidth: selected ? 1.5 : 1)
                }
                .opacity(isEnabled ? 1 : 0.6)
                .onHover { hovering = $0 }
        }
    }
}

/// Web `.field`: label above (13/600 ink-2), control, optional helper line below (12.5 ink-2 at 1.5). Every form in
/// the setup, new-project, project and GitHub sheets uses it.
struct SetupField<Control: View>: View {
    let label: String
    let hint: String?
    let hintTone: Color
    let control: Control
    init(_ label: String, hint: String? = nil, hintTone: Color = CE.ink2, @ViewBuilder control: () -> Control) {
        self.label = label
        self.hint = hint
        self.hintTone = hintTone
        self.control = control()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(SetupFont.label).foregroundStyle(CE.ink2)
            control
            if let hint, !hint.isEmpty {
                Text(hint).font(SetupFont.hint).foregroundStyle(hintTone)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The face of a web `select`: current value and a chevron in an input well.
private struct SetupSelectLabel: View {
    let text: String
    var mono = false
    /// Inside a settings row: shorter well, smaller corner.
    var compact = false
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: compact ? 10 : CERadius.control, style: .continuous)
        HStack(spacing: 6) {
            Text(text).font(mono ? SetupFont.code : compact ? SetupFont.select : SetupFont.input)
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3).lineLimit(1)
            Spacer(minLength: 4)
            // web .st-select: a down chevron 13pt in from the right.
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
        }
        .padding(.leading, compact ? 11 : 13).padding(.trailing, compact ? 11 : 13)
        .frame(maxWidth: .infinity, minHeight: compact ? SetupMetrics.rowControlHeight : SetupMetrics.inputHeight)
        .background(CE.bgDeep.opacity(0.5), in: shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.12)) }
        .contentShape(shape)
    }
}

/// A web-style select: a menu of checkable items behind `SetupSelectLabel`.
private struct SetupMenu<Items: View>: View {
    let text: String
    let mono: Bool
    let compact: Bool
    let label: String
    let items: Items
    init(_ text: String, mono: Bool = false, compact: Bool = false, label: String, @ViewBuilder items: () -> Items) {
        self.text = text
        self.mono = mono
        self.compact = compact
        self.label = label
        self.items = items()
    }
    var body: some View {
        Menu { items } label: { SetupSelectLabel(text: text, mono: mono, compact: compact) }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .frame(maxWidth: .infinity)
            .accessibilityLabel(label)
            .accessibilityValue(text)
    }
}

/// Menu items are toggles so each platform draws its own checkmark.
@MainActor private func menuCheck(_ selected: Bool, _ action: @escaping () -> Void) -> Binding<Bool> {
    Binding(get: { selected }, set: { _ in action() })
}

/// A state at the right of a settings row: a dot and plain words (coloured only when something needs attention).
private struct DotValue: View {
    let tone: Tone
    let text: String
    var body: some View {
        // web .st-facts dd: 14 at 1.45, ink-1.
        HStack(spacing: 7) {
            StatusDot(tone: tone, size: 7)
            Text(text).font(SetupFont.value).foregroundStyle(tone == .danger || tone == .attention ? tone.color : CE.ink)
                .ceLineHeight(14, 1.45)
                .multilineTextAlignment(isMac ? .trailing : .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Only used inside scroll views (it may wrap). web .form__error 13.5 danger.
private struct SetupError: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(CEFont.note).foregroundStyle(CE.danger)
            .lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct SetupBrand: View {
    var body: some View {
        HStack(spacing: 8) {
            BrandMark(size: 20)
            Text("IAMCEO").font(SetupFont.brand).tracking(0.8).foregroundStyle(CE.ink2)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("IAMCEO")
    }
}

/// The command chip on the connection screen: brightens under the pointer, gives a little when pressed.
private struct CopyChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { ChipBody(configuration: configuration) }
    private struct ChipBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false
        var body: some View {
            configuration.label
                .brightness(hovering ? 0.05 : 0)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
                .onHover { hovering = $0 }
        }
    }
}

/// web `.glass--thick` with the setup panel tint (rgb(14 10 32 / .66)): radius 30, a 1.5pt rim and the deep
/// two-layer shadow (`0 44px 100px -34px` dark .9, `0 34px 90px -44px` violet .42), cut out of the card so the
/// see-through inside stays clear. Reduce Transparency: the solid plate.
private struct ThickCardSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 30, style: .continuous)
        if reduceTransparency {
            content.background(CE.plateRaisedSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background { CardGlassFill(shape: shape, tint: 0.66) }
                .overlay { CardRim(shape: shape, width: 1.5) }
                .background {
                    ZStack {
                        shape.inset(by: 34).fill(Color(red: 4 / 255, green: 2 / 255, blue: 14 / 255).opacity(0.9)).offset(y: 44).blur(radius: 50)
                        shape.inset(by: 44).fill(CE.violet.opacity(0.42)).offset(y: 34).blur(radius: 45)
                    }
                    .overlay { shape.fill(Color.black).blendMode(.destinationOut) }
                    .compositingGroup()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
        }
    }
}

@MainActor private func setupCopy(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

private func settingsTrim(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

// MARK: - Connection (full window until a daemon is connected)

/// First screen without a connection (web Setup): one centred glass card. Never shows sample-like data.
struct ConnectionView: View {
    @Environment(AppStore.self) private var store
    @State private var revealCode = false
    /// iPhone: manual address + code entry is a fallback behind the QR flow.
    @State private var showManual = false
    @State private var copiedCommand = false
    @State private var copyTick = 0
    @FocusState private var focus: Field?
    #if os(macOS)
    @State private var localHost = LocalHostService()
    @State private var localStartError: String?
    #endif

    private enum Field: Hashable { case endpoint, code }
    @State private var useQR = false

    private var restoringConnection: Bool {
        ConnectionRecovery.showsSavedConnection(endpoint: store.endpoint, accessCode: store.accessCode, useQR: useQR)
    }

    /// Prints the server's addresses and access code on the server computer.
    private static let accessCommand = "iamceo open"

    private var connecting: Bool { store.connectionStatus == .connecting }
    private var localHostBusy: Bool {
        #if os(macOS)
        localHost.isStarting
        #else
        false
        #endif
    }
    /// Access codes are ASCII. A Korean IME left on is the usual cause of a code that never matches.
    private var codeHasNonASCII: Bool { store.accessCode.unicodeScalars.contains { !$0.isASCII } }
    private var canConnect: Bool {
        !connecting && !localHostBusy && !codeHasNonASCII
            && !settingsTrim(store.endpoint).isEmpty && !settingsTrim(store.accessCode).isEmpty
    }
    private var connectionError: String? {
        guard !connecting, let raw = store.errorMessage, !raw.isEmpty else { return nil }
        return friendlyConnectionError(raw)
    }
    private var endpointHint: String? {
        #if os(macOS)
        nil
        #else
        "Mac의 Tailscale 주소(100.x 또는 HTTPS)입니다. iPhone의 127.0.0.1은 Mac이 아닙니다."
        #endif
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                card
                    .frame(maxWidth: 420)
                    .padding(.horizontal, CESpace.l)
                    .padding(.vertical, isMac ? 36 : CESpace.xxl)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
        }
        .background { localLight }
        #if os(macOS)
        .onAppear {
            guard !connecting, store.accessCode.isEmpty else { return }
            focus = store.endpoint.isEmpty ? .endpoint : .code
        }
        #endif
    }

    /// Web Setup LocalLight: violet glow above the card, orchid low right.
    private var localLight: some View {
        GeometryReader { geo in
            let width = min(1000, geo.size.width * 1.5)
            ZStack {
                Rectangle()
                    .fill(EllipticalGradient(colors: [CE.violet.opacity(0.36), CE.violet.opacity(0.12), .clear]))
                    .frame(width: width, height: width * 0.6)
                    .position(x: geo.size.width * 0.5, y: geo.size.height * 0.24)
                Rectangle()
                    .fill(EllipticalGradient(colors: [CE.orchid.opacity(0.22), CE.orchid.opacity(0.07), .clear]))
                    .frame(width: width * 0.8, height: width * 0.48)
                    .position(x: geo.size.width * 0.72, y: geo.size.height * 0.88)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// web .su-code: a thick glass card (radius 30, tint .66), every child 12 apart.
    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            SetupBrand()
            Text(isMac ? "AI 팀에 연결" : "Mac과 연결").font(SetupFont.title).tracking(isMac ? -0.5 : 0).foregroundStyle(CE.ink)
                .ceLineHeight(24, 1.3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
                .accessibilityAddTraits(.isHeader)
            Text(isMac ? "접속 코드는 이 기기에 저장되어 다음부터는 묻지 않습니다." : "한 번 연결하면 다음부터는 자동으로 연결합니다.")
                .font(SetupFont.lead).foregroundStyle(CE.ink2)
                .ceLineHeight(14.5, 1.55)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            #if os(iOS)
            if restoringConnection {
                if connecting || store.connectionStatus == .disconnected && store.errorMessage == nil {
                    ProgressView("연결 중")
                } else {
                    connectionFailure
                    Button("다시 시도") { connect() }.ceProminentButton().disabled(!canConnect)
                    Button("QR로 다시 연결") { useQR = true }.ceSecondaryButton()
                }
            } else {
                PhonePairingSection()
                if store.errorMessage != nil { connectionFailure }
            }
            Button { withAnimation(.snappy) { showManual.toggle() } } label: {
                HStack(spacing: 5) {
                    Text("주소와 접속 코드를 직접 입력")
                    Image(systemName: showManual ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                }
                .font(CEFont.meta.weight(.medium)).foregroundStyle(CE.ink2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showManual { manualFields }
            #else
            localStart
            orDivider
            DisclosureGroup("다른 컴퓨터의 서버에 연결", isExpanded: $showManual) { manualFields }
            #endif
            foot
        }
        .padding(.horizontal, 22).padding(.top, 26).padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.ceInsideGlass, true)
        .modifier(ThickCardSurface())
    }

    private var connectionFailure: some View {
        ConnectionRecoveryNotice(rawError: store.rawErrorMessage ?? store.connectionIssue)
    }

    @ViewBuilder private var manualFields: some View {
        @Bindable var store = store
                SetupField("서버 주소", hint: endpointHint) {
                    TextField("서버 주소", text: $store.endpoint, prompt: Text(isMac ? "http://127.0.0.1:7878" : "https://your-mac.tailnet.ts.net"))
                        .labelsHidden()
                        .font(SetupFont.input)
                        .focused($focus, equals: .endpoint)
                        .onSubmit { focus = .code }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        #endif
                        .ceField(focused: focus == .endpoint)
                }
                SetupField("접속 코드") {
                    HStack(spacing: 6) {
                        // web .t-code: the code itself in the code face; the placeholder stays in the text face.
                        Group {
                            if revealCode {
                                TextField("접속 코드", text: $store.accessCode, prompt: Text("서버 컴퓨터의 접속 코드").font(SetupFont.input))
                            } else {
                                SecureField("접속 코드", text: $store.accessCode, prompt: Text("서버 컴퓨터의 접속 코드").font(SetupFont.input))
                            }
                        }
                        .labelsHidden()
                        .font(store.accessCode.isEmpty ? SetupFont.input : SetupFont.codeInput)
                        .focused($focus, equals: .code)
                        .onSubmit { connect() }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        Button { revealCode.toggle() } label: {
                            Image(systemName: revealCode ? "eye.slash" : "eye")
                                .font(.system(size: 13, weight: .medium))
                                .frame(width: 28, height: 24)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CE.ink2)
                        .help(revealCode ? "접속 코드 숨기기" : "접속 코드 보기")
                        .accessibilityLabel(revealCode ? "접속 코드 숨기기" : "접속 코드 보기")
                    }
                    .ceField(focused: focus == .code)
                }
                if codeHasNonASCII {
                    SetupError("접속 코드는 영문·숫자로 되어 있습니다. 한글 입력 상태인지 확인해 주세요.")
                } else if let connectionError {
                    SetupError(connectionError)
                }
                // web .su-submit: .gbtn--primary .gbtn--l, 52 tall, full width.
                Button { connect() } label: {
                    HStack(spacing: 7) {
                        if connecting { ProgressView().controlSize(.small).tint(.white) }
                        Text(connecting ? "연결하는 중" : "연결하기")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, isMac ? 0 : 5)
                }
                .ceProminentButton()
                .controlSize(.large)
                .disabled(!canConnect)
                .padding(.top, 4)
    }

    #if os(macOS)
    private var orDivider: some View {
        HStack(spacing: 10) {
            Rectangle().fill(CE.line).frame(height: 1)
            Text("또는").font(CEFont.meta).foregroundStyle(CE.ink3)
            Rectangle().fill(CE.line).frame(height: 1)
        }
        .padding(.vertical, 2)
        .accessibilityHidden(true)
    }

    private var localStart: some View {
        VStack(spacing: 8) {
            Button { startLocal() } label: {
                HStack(spacing: 7) {
                    if localHost.isStarting {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "desktopcomputer").font(.system(size: 14, weight: .semibold))
                    }
                    Text(localHost.isStarting ? "준비하는 중" : "이 Mac에서 시작")
                }
                .frame(maxWidth: .infinity)
            }
            .ceProminentButton()
            .keyboardShortcut(.defaultAction)
            .controlSize(.large)
            .disabled(localHost.isStarting || connecting)
            Text(localHost.isStarting && !localHost.statusText.isEmpty ? localHost.statusText : "이 Mac의 서버를 찾아 바로 연결합니다. 없으면 새로 준비합니다.")
                .font(SetupFont.hint).foregroundStyle(CE.ink2)
                .lineSpacing(SetupFont.hintLeading)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
            if let localStartError { SetupError(localStartError) }
        }
    }

    /// Same flow as before the redesign: explicit start, then connect with the local config's code.
    private func startLocal() {
        Task {
            localStartError = nil
            do {
                let connection = try await localHost.start()
                store.endpoint = connection.url.absoluteString
                store.accessCode = connection.accessCode
                await store.connect()
            } catch { localStartError = friendlyLoadError(error, what: "이 Mac의 연결", verb: "준비하지") }
        }
    }
    #endif

    /// Web `.su-foot`: where the code comes from, with the command as a chip so it never breaks in half.
    private var foot: some View {
        VStack(spacing: 8) {
            Text("주소와 접속 코드는 서버 컴퓨터에서 확인합니다.")
                .font(SetupFont.hint).foregroundStyle(CE.ink2)
                .lineSpacing(SetupFont.hintLeading)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button { copyAccessCommand() } label: {
                HStack(spacing: 7) {
                    Image(systemName: "terminal").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(CE.ink2)
                    Text(Self.accessCommand).font(SetupFont.code).foregroundStyle(CE.ink).lineLimit(1)
                    Text(copiedCommand ? "복사함" : "복사").font(CEFont.meta.weight(.semibold))
                        .foregroundStyle(copiedCommand ? CE.success : CE.accent)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 30)
                .background(Color.white.opacity(0.08), in: Capsule())
                .overlay { Capsule().strokeBorder(CE.line) }
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(CopyChipStyle())
            .fixedSize()
            .help("서버 컴퓨터의 터미널에서 실행하면 주소와 접속 코드를 보여 줍니다")
            .accessibilityLabel(copiedCommand ? "iamceo open 명령 복사함" : "iamceo open 명령 복사")
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }

    private func copyAccessCommand() {
        setupCopy(Self.accessCommand)
        copiedCommand = true
        copyTick += 1
        let tick = copyTick
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            if copyTick == tick { copiedCommand = false }
        }
    }

    private func connect() {
        guard canConnect else { return }
        Task { await store.connect() }
    }

    /// The server's 401 text says nothing about what to do next.
    private func friendlyConnectionError(_ raw: String) -> String {
        if raw == "인증이 필요합니다" { return "접속 코드가 맞지 않거나 바뀌었습니다. 서버 컴퓨터에서 iamceo\u{00A0}open 으로 확인해 다시 넣어 주세요." }
        return ConnectionRecovery.reason(raw)
    }
}

// MARK: - Settings (macOS Settings window / iOS sheet)

/// The four parts of settings. Mac: a sidebar inside the settings window; iPhone: a list that pushes each part.
private enum SettingsSection: String, CaseIterable, Identifiable, Hashable {
    case general, ai, notifications, connection
    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: "일반"
        case .ai: "AI 모델"
        case .notifications: "알림"
        case .connection: "연결"
        }
    }
    var icon: String {
        switch self {
        case .general: "gearshape"
        case .ai: "cpu"
        case .notifications: "bell"
        case .connection: "network"
        }
    }
}

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    @Environment(\.dismiss) private var dismiss
    /// What the screen edits. `base` is the server value the edits are measured against.
    @State private var draft = Settings()
    @State private var base = Settings()
    @State private var loaded = false
    /// Ranks switched to "직접 입력"; kept apart so an emptied field stays open (web `custom`).
    @State private var customRanks: Set<String> = []
    @State private var saveError: String?
    @State private var savedNotice = false
    @State private var noticeTask: Task<Void, Never>?
    @State private var busy: Busy?
    @State private var syncError: String?
    @State private var runtimeError: String?
    @State private var confirmLeave = false
    @State private var confirmDiscard = false
    @State private var editedNamespace = ""
    @State private var macAlerts = false
    @State private var baseMacAlerts = false
    @State private var savingLocal = false
    @State private var highlightRuntime = false
    #if os(macOS)
    @State private var settingsWindow: NSWindow?
    #endif

    /// Call before opening Settings; also works when its Mac window is already open.
    static func showRuntime() { SettingsNavigation.shared.requestRuntime() }
    /// The number field being typed in (its well gets the focus ring).
    @FocusState private var numberFocus: String?
    #if os(macOS)
    @State private var section: SettingsSection = SettingsView.launchSection ?? .general
    #else
    @State private var path: [SettingsSection] = SettingsView.launchSection.map { [$0] } ?? []
    #endif

    private enum Busy { case sync, runtime }

    private struct PermissionChoice: Identifiable {
        let id: String
        let title: String
        let detail: String
        var badge: String? = nil
    }
    private static let permissionChoices = [
        PermissionChoice(id: "bypassPermissions", title: "묻지 않기", detail: "직원이 승인 창 없이 명령을 실행합니다", badge: "기본"),
        PermissionChoice(id: "auto", title: "위험할 때만 묻기", detail: "위험해 보이는 작업만 멈추고 묻습니다"),
        PermissionChoice(id: "default", title: "매번 묻기", detail: "도구를 쓸 때마다 승인을 기다립니다")
    ]

    private struct RankRow: Identifiable {
        let key: String
        let title: String
        let scope: String
        let cli: RankSettingsCLI
        var id: String { "\(cli.rawValue).\(key)" }
        var showsEffort: Bool { cli != .codex || key != "staff" }
    }
    private static let rankRows = RankSettingsCLI.allCases.flatMap { cli in [
        RankRow(key: "manager", title: "총괄", scope: "본사 AI도 같음", cli: cli),
        RankRow(key: "lead", title: "팀장", scope: "일을 맡는 직원", cli: cli),
        RankRow(key: "staff", title: "서브에이전트", scope: "팀장이 나눠 맡기는 일", cli: cli)
    ] }
    private static let tidyChoices = [0, 3, 6, 12, 24]
    /// Mac rank rows: the model and effort columns (the group caption lines up with them).
    private static let modelWidth: CGFloat = 176
    private static let effortWidth: CGFloat = 116

    /// Review hook for the read-only sample workspace (DEBUG): `--settings-section general|ai|notifications|connection`
    /// opens that part of settings (screenshots of each part).
    private static var launchSection: SettingsSection? {
        #if DEBUG
        guard LaunchOptions.demo, let raw = LaunchOptions.value(after: "--settings-section") else { return nil }
        return SettingsSection(rawValue: raw)
        #else
        return nil
        #endif
    }

    // MARK: State

    private var editable: Bool { store.canWrite && store.bootstrap != nil }
    private var saving: Bool { savingLocal || store.pendingActions.contains("settings") }
    /// A rank switched to "직접 입력" with nothing typed yet counts as an unsaved (and invalid) change, as on the web.
    private var pendingEmptyCustom: Bool { Self.rankRows.contains { customRanks.contains($0.id) && model(of: $0).isEmpty } }
    private var isDirty: Bool { loaded && (Self.signature(draft) != Self.signature(base) || pendingEmptyCustom || macAlerts != baseMacAlerts) }
    private var firstModelError: String? { Self.rankRows.lazy.compactMap { modelError(for: $0) }.first }
    private var canSave: Bool { editable && isDirty && firstModelError == nil && !saving && store.settingsConflict == nil }
    private var serverSignature: String { store.bootstrap.map { Self.signature($0.settings) } ?? "" }

    /// Which part holds unsaved edits (the dot on its sidebar item / list row). Together they cover `signature`.
    private func hasEdits(in section: SettingsSection) -> Bool {
        guard loaded else { return false }
        switch section {
        case .general:
            return draft.permissionMode != base.permissionMode || draft.maxConcurrentTurns != base.maxConcurrentTurns
                || draft.maxAwakeWorkers != base.maxAwakeWorkers || draft.compactAtPct != base.compactAtPct
                || Int(draft.boardTidyHours.rounded()) != Int(base.boardTidyHours.rounded())
        case .ai: return RankSettingsEditing.signature(draft) != RankSettingsEditing.signature(base) || pendingEmptyCustom
        case .notifications: return draft.notifyMac != base.notifyMac || macAlerts != baseMacAlerts
        case .connection: return false
        }
    }

    private var lockNotice: (title: String, detail: String)? {
        if store.isDemo { return ("샘플 설정입니다", "읽기 전용이라 바꿀 수 없습니다. 실제 Mac에 연결하면 바꿀 수 있습니다.") }
        if store.connectionStatus != .connected { return ("서버에 연결되지 않았습니다", "보이는 값은 마지막 동기화 기준이며 지금은 바꿀 수 없습니다.") }
        return nil
    }

    var body: some View {
        #if os(macOS)
        @Bindable var router = router
        #endif
        return container
            .projectManagementSheets()
            .task { await store.refreshModels() }
            .onAppear {
                editedNamespace = store.writeNamespace; syncFromStore()
                #if os(macOS)
                macAlerts = MacNotificationService.shared.enabled; baseMacAlerts = macAlerts
                #endif
                if SettingsNavigation.shared.pendingRuntime { revealRuntime() }
                #if os(macOS)
                if store.bootstrap == nil, !store.isDemo, Self.launchSection == nil { section = .connection }
                #endif
                #if DEBUG
                // Review hook (sample only, never saved): `--settings-dirty` makes two unsaved edits, one of them invalid,
                // so the save bar and the section dots can be screenshotted.
                if store.isDemo, loaded, LaunchOptions.arguments.contains("--settings-dirty"), let lead = Self.rankRows.first(where: { $0.cli == .claude && $0.key == "lead" }) {
                    draft.maxConcurrentTurns += 1
                    customRanks.insert(lead.id)
                    setModel("opus 1m", for: lead)
                }
                #endif
            }
            .onChange(of: SettingsNavigation.shared.revision) { _, _ in revealRuntime() }
            .onChange(of: serverSignature) { _, _ in syncFromStore() }
            .onChange(of: Self.signature(draft)) { _, _ in
                saveError = nil
                if loaded { store.setSettingsDraft(draft) }
            }
            .onChange(of: store.writeNamespace) { _, namespace in
                editedNamespace = namespace; loaded = false; customRanks = []; saveError = nil; syncFromStore()
            }
            #if os(macOS)
            .sheet(isPresented: $router.showPairing) { MacPairingSheet() }
            .background(SettingsCloseGuard(dirty: isDirty, saving: saving, onWindow: { settingsWindow = $0 }, onClose: { confirmDiscard = true }))
            #endif
            .confirmationDialog("저장하지 않은 변경이 있습니다", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("저장하고 닫기") { Task { await saveAndClose() } }.disabled(!canSave)
                Button("버리고 닫기", role: .destructive) { revert(); finishClosing() }.disabled(saving)
                Button("취소", role: .cancel) {}
            }
    }

    // MARK: Frame

    #if os(macOS)
    /// System Settings: the four parts in a sidebar, the chosen part on the right, the save bar pinned under it.
    private var container: some View {
        HStack(spacing: 0) {
            sidebar
            page(section)
                .id(section)
                .ceBar(.bottom) { saveBarHost }
        }
        .frame(width: 780, height: 700)
        .background { AmbientBackground() }
        .navigationTitle(section.title)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(SettingsSection.allCases) { item in sidebarItem(item) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.top, 12).padding(.bottom, 12)
        .frame(width: 196)
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            Color.black.opacity(0.24)
                .overlay(alignment: .trailing) { Rectangle().fill(CE.line).frame(width: 1) }
                .ignoresSafeArea()
        }
    }

    private func sidebarItem(_ item: SettingsSection) -> some View {
        let selected = section == item
        let dirty = hasEdits(in: item)
        // web .pj--foot: 40 tall, 14/500, radius 13, padding 7/12.
        return Button { section = item } label: {
            HStack(spacing: 10) {
                sectionIcon(item, size: 24)
                Text(item.title).font(.system(size: 14, weight: selected ? .semibold : .medium))
                    .foregroundStyle(selected ? CE.ink : CE.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if dirty { unsavedDot(item) }
            }
            .padding(.horizontal, 10)
            .frame(height: 40)
        }
        .buttonStyle(SettingsNavStyle(selected: selected))
        .accessibilityLabel(dirty ? "\(item.title), \(unsavedLabel(item))" : item.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
    #else
    /// iPhone: the four parts as a list; each pushes its page. The save bar stays pinned under every page.
    private var container: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    notices
                    SettingsGroup {
                        ForEach(Array(SettingsSection.allCases.enumerated()), id: \.element) { index, item in
                            if index > 0 { RowDivider(inset: 40) }
                            NavigationLink(value: item) { sectionLink(item) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background { AmbientBackground() }
            .navigationTitle("설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { phoneSettingsActions }
            .navigationDestination(for: SettingsSection.self) { item in
                page(item)
                    .background { AmbientBackground() }
                    .navigationTitle(item.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { phoneSettingsActions }
            }
        }
        .ceBar(.bottom) { saveBarHost }
        .interactiveDismissDisabled(isDirty)
    }

    @ToolbarContentBuilder private var phoneSettingsActions: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) { Button("취소") { close() }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
            Button("저장") { Task { await saveAndClose() } }.disabled(isDirty && !canSave || saving)
        }
    }

    private func sectionLink(_ item: SettingsSection) -> some View {
        let dirty = hasEdits(in: item)
        return HStack(spacing: 12) {
            sectionIcon(item, size: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(SetupFont.row).foregroundStyle(CE.ink)
                Text(summary(item)).font(SetupFont.hint).foregroundStyle(CE.ink2).lineLimit(1)
            }
            Spacer(minLength: 8)
            if dirty { unsavedDot(item) }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink3)
        }
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(dirty ? unsavedLabel(item) : "")
    }

    /// One line under each part on the iPhone list: its current value at a glance (nothing made up before the first load).
    private func summary(_ item: SettingsSection) -> String {
        if item != .connection && !loaded { return "연결 후 표시" }
        switch item {
        case .general:
            return "\(permissionChoice.title) · 동시 실행 \(draft.maxConcurrentTurns)개"
        case .ai:
            func name(_ rank: String) -> String {
                let value = settingsTrim(draft.rankConfig(rank, cli: .claude)?.model ?? "")
                return value.isEmpty ? "기본값" : value
            }
            return "총괄 \(name("manager")) · 팀장 \(name("lead"))"
        case .notifications:
            var parts = ["Mac \(draft.notifyMac ? "켬" : "끔")"]
            if let service = store.pushNotifications {
                // The same rule as the switch on the 알림 page. This phone's own state comes first.
                let on = PhonePushSwitch.isOn(service.state, device: store.pushSettings.device(id: service.installationID))
                parts.insert("iPhone \(on ? "켬" : "끔")", at: 0)
            }
            return parts.joined(separator: " · ")
        case .connection:
            return connectionSummary().text
        }
    }
    #endif

    private func sectionIcon(_ item: SettingsSection, size: CGFloat) -> some View {
        let tile = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        return Image(systemName: item.icon)
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(CE.accent)
            .frame(width: size, height: size)
            .background(CE.violet.opacity(0.16), in: tile)
            .overlay { tile.strokeBorder(CE.violet.opacity(0.3)) }
            .accessibilityHidden(true)
    }

    /// Unsaved edits in that part; red when one of them cannot be saved as is.
    private func unsavedDot(_ item: SettingsSection) -> some View {
        let invalid = hasInvalidEdit(item)
        return Circle().fill(invalid ? CE.danger : CE.accent).frame(width: 7, height: 7)
            .shadow(color: (invalid ? CE.danger : CE.violet).opacity(0.7), radius: 4)
            .help(invalid ? "고쳐야 저장할 수 있는 변경이 있습니다" : "저장하지 않은 변경이 있습니다")
            .accessibilityHidden(true)
    }

    private func hasInvalidEdit(_ item: SettingsSection) -> Bool { item == .ai && firstModelError != nil }

    /// What the dot says to VoiceOver.
    private func unsavedLabel(_ item: SettingsSection) -> String {
        hasInvalidEdit(item) ? "고쳐야 저장할 수 있는 변경 있음" : "저장하지 않은 변경 있음"
    }

    /// One part of settings, scrolling under the save bar.
    private func page(_ item: SettingsSection) -> some View {
        ScrollViewReader { scroll in
          ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                notices
                sectionContent(item)
            }
            .padding(.horizontal, isMac ? 24 : 16)
            .padding(.top, isMac ? 20 : 12)
            .padding(.bottom, isMac ? 28 : 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .task(id: "\(SettingsNavigation.shared.revision):\(highlightRuntime)") {
            guard highlightRuntime, item == .ai else { return }
            await Task.yield()
            if !Task.isCancelled { scroll.scrollTo("runtime", anchor: .top) }
        }
        #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
        #endif
        }
    }

    /// Read-only and conflict notices, at the top of every part.
    @ViewBuilder private var notices: some View {
        if store.bootstrap != nil {
            if let lockNotice {
                InlineNotice(tone: store.isDemo ? .accent : .attention, icon: store.isDemo ? "eye" : "wifi.slash", title: lockNotice.title, detail: lockNotice.detail)
            }
            if store.settingsConflict != nil {
                VStack(alignment: .leading, spacing: 8) {
                    InlineNotice(title: "다른 기기에서 설정이 바뀌었습니다", detail: "적은 내용은 남아 있습니다. 새 설정을 확인한 뒤 저장해 주세요.")
                    HStack(spacing: 8) {
                        Button("새 설정 불러오기") { revert() }.ceSecondaryButton().controlSize(.small)
                        Button("내 변경 다시 검토") { reviewChanges() }.ceSecondaryButton().controlSize(.small)
                    }.disabled(saving)
                }
            }
        }
    }

    @ViewBuilder private func sectionContent(_ item: SettingsSection) -> some View {
        if store.bootstrap == nil && item != .connection {
            // web .empty: 16/600 title, 14 ink-2 line, generous room; no tile, the page itself is the surface.
            EmptyTile(icon: "wifi.slash", title: "서버에 연결하면 볼 수 있습니다",
                      detail: isMac ? "메인 창에서 서버에 연결하세요." : "서버에 연결하면 설정을 볼 수 있습니다.", framed: false)
                .padding(.vertical, 16)
        } else {
            switch item {
            case .general: generalSection
            case .ai: aiSection
            case .notifications: notificationsSection
            case .connection: connectionSection
            }
        }
    }

    // MARK: 일반

    private var permissionChoice: PermissionChoice {
        Self.permissionChoices.first { $0.id == draft.permissionMode }
            ?? PermissionChoice(id: draft.permissionMode, title: draft.permissionMode, detail: "")
    }

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsGroup("운영", footnote: "세션은 샌드박스 없이 실행됩니다. 권한은 새 세션부터 적용됩니다.") {
                // web .st-perms: three explained choices, the server default marked 기본.
                SettingsRow("권한", stacked: true) {
                    SettingsChoiceTiles(options: permissionOptions, selection: draft.permissionMode, label: "권한") { draft.permissionMode = $0 }
                }
                RowDivider(inset: 0)
                SettingsRow("동시 실행", hint: "넘치면 차례를 기다립니다", hintBelowOnPhone: true) {
                    numberControl("동시 실행", unit: "개", value: $draft.maxConcurrentTurns, range: 1...64)
                }
                RowDivider(inset: 0)
                SettingsRow("팀장 수 경보", hint: "넘으면 총괄에게 잠재울 후보를 알립니다", hintBelowOnPhone: true) {
                    numberControl("팀장 수 경보", unit: "명", value: $draft.maxAwakeWorkers, range: 1...256)
                }
                RowDivider(inset: 0)
                SettingsRow("문맥 기준", hint: "이 비율을 넘으면 팀 화면에 표시합니다. 직원 상세의 '문맥 압축'으로 줄일 수 있습니다.", hintBelowOnPhone: true) {
                    numberControl("문맥 기준", unit: "%", value: $draft.compactAtPct, range: 1...100, step: 5)
                }
                RowDivider(inset: 0)
                SettingsRow("판 정리 주기", hint: "총괄이 쉬고 바뀐 게 있을 때만 판을 맞춥니다", hintBelowOnPhone: true) { tidyMenu }
            }
            .disabled(!editable || saving)
            SettingsProjectsGroup(editable: editable)
        }
    }

    /// The three known modes, plus a mode the server holds that this app does not know (shown, not replaced).
    private var permissionOptions: [SettingsChoiceTiles.Option] {
        var options = Self.permissionChoices.map { SettingsChoiceTiles.Option(id: $0.id, title: $0.title, detail: $0.detail, badge: $0.badge) }
        if !Self.permissionChoices.contains(where: { $0.id == draft.permissionMode }) {
            options.append(SettingsChoiceTiles.Option(id: draft.permissionMode, title: draft.permissionMode, detail: "서버에 저장된 값입니다"))
        }
        return options
    }

    private var tidyMenu: some View {
        let current = Int(draft.boardTidyHours.rounded())
        return SetupMenu(tidyLabel(current), compact: true, label: "판 정리 주기") {
            ForEach(tidyOptions, id: \.self) { hours in
                Toggle(tidyLabel(hours), isOn: menuCheck(current == hours) { draft.boardTidyHours = Double(hours) })
            }
        }
        .frame(width: isMac ? 120 : 128)
    }

    /// Fixed choices plus any custom value the server holds, so it is shown instead of silently replaced.
    private var tidyOptions: [Int] {
        Array(Set(Self.tidyChoices + [Int(base.boardTidyHours.rounded()), Int(draft.boardTidyHours.rounded())])).sorted()
    }

    private func tidyLabel(_ hours: Int) -> String { hours == 0 ? "끔" : hours == 24 ? "매일" : "\(hours)시간" }

    /// A typed number with its unit and a stepper, at the right of a row.
    private func numberControl(_ title: String, unit: String, value: Binding<Int>, range: ClosedRange<Int>, step: Int = 1) -> some View {
        let clamped = Binding<Int>(get: { value.wrappedValue }, set: { value.wrappedValue = min(max($0, range.lowerBound), range.upperBound) })
        // web .st-number: 15 tabular digits in an input well, unit 14 ink-2. Wide enough for three digits (up to 256).
        return HStack(spacing: 8) {
            TextField(title, value: clamped, format: .number)
                .labelsHidden()
                .font(SetupFont.input)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .focused($numberFocus, equals: title)
                .onSubmit { Task { await save() } }
                .frame(width: isMac ? 34 : 38)
                .settingsWell(focused: numberFocus == title)
            Text(unit).font(SetupFont.value).foregroundStyle(CE.ink2)
                .frame(minWidth: 16, alignment: .leading)
            Stepper(title, value: clamped, in: range, step: step).labelsHidden()
        }
        .fixedSize()
    }

    // MARK: AI 모델

    private var aiSection: some View {
        VStack(alignment: .leading, spacing: 22) {
            runtimeGroup
                .id("runtime")
                .overlay { if highlightRuntime { RoundedRectangle(cornerRadius: CERadius.control).stroke(CE.accent, lineWidth: 2) } }
            ForEach(RankSettingsCLI.allCases, id: \.self) { cli in
                rankGroup(cli).disabled(!editable || saving)
            }
        }
    }

    private var runtimeGroup: some View {
        let runtime = store.runtime
        let needsSetup = runtime != nil && (runtime?.core.available != true || runtime?.providers.values.contains { !$0.installed } == true)
        let footnote: String = store.isDemo ? "샘플에는 연결된 실행 환경이 없습니다."
            : needsSetup ? "서버 컴퓨터의 IAMCEO 저장소에서 bun\u{00A0}run\u{00A0}setup:core 로 준비한 뒤 다시 확인하세요."
            : "로그인은 세션을 열 때 확인합니다."
        return VStack(alignment: .leading, spacing: 10) {
            SettingsGroup("실행 환경", footnote: footnote, footnoteTone: needsSetup && !store.isDemo ? CE.attention : CE.ink2, accessory: {
                if !store.isDemo {
                    SettingsRefreshButton(label: "실행 환경 다시 확인", busy: busy == .runtime) { Task { await refresh(.runtime) } }
                        .disabled(store.connectionStatus != .connected || store.isLoading || busy != nil)
                }
            }) {
                SettingsRow("실행 엔진", hint: runtime?.core.detail, monoHint: true) { DotValue(tone: coreState(runtime).tone, text: coreState(runtime).text) }
                    .help("모든 AI 직원은 이 실행 엔진(herdr-core) 위에서 일합니다. 직원마다 Claude Code 또는 Codex를 고릅니다.")
                RowDivider(inset: 0)
                SettingsRow("Claude Code") { DotValue(tone: providerState(runtime, "claude").tone, text: providerState(runtime, "claude").text) }
                RowDivider(inset: 0)
                SettingsRow("Codex CLI") { DotValue(tone: providerState(runtime, "codex").tone, text: providerState(runtime, "codex").text) }
            }
            if let runtimeError { SetupError("진단을 읽지 못했습니다. \(runtimeError)").padding(.horizontal, SetupMetrics.groupInset) }
        }
    }

    private struct RuntimeState { let tone: Tone; let text: String }

    private func coreState(_ runtime: RuntimeDiagnostics?) -> RuntimeState {
        guard let core = runtime?.core else { return RuntimeState(tone: .neutral, text: "확인 전") }
        if core.available { return RuntimeState(tone: .success, text: core.version.map { "사용 가능 · \($0)" } ?? "사용 가능") }
        if core.installed { return RuntimeState(tone: .danger, text: "설치됨 · 사용할 수 없음") }
        return RuntimeState(tone: .attention, text: "설치 필요")
    }

    /// The daemon only reports whether the CLI is installed; login is checked when a session starts (the footnote says so).
    private func providerState(_ runtime: RuntimeDiagnostics?, _ cli: String) -> RuntimeState {
        guard let provider = runtime?.providers[cli] else { return RuntimeState(tone: .neutral, text: "확인 전") }
        return provider.installed ? RuntimeState(tone: .success, text: "설치됨") : RuntimeState(tone: .attention, text: "설치 필요")
    }

    private func rankGroup(_ cli: RankSettingsCLI) -> some View {
        let rows = Self.rankRows.filter { $0.cli == cli }
        let last = cli == RankSettingsCLI.allCases.last
        return SettingsGroup(cli.title, footnote: last ? "직원별로 지정한 값이 먼저입니다. 바꾼 값은 세션을 다시 열 때 적용됩니다." : nil, accessory: {
            // web .st-ranks thead th: 13/600 ink-2, over the value in each select.
            #if os(macOS)
            HStack(spacing: 8) {
                Text("모델").padding(.leading, 11).frame(width: Self.modelWidth, alignment: .leading)
                Text("생각 깊이").padding(.leading, 11).frame(width: Self.effortWidth, alignment: .leading)
            }
            .font(SetupFont.label).foregroundStyle(CE.ink2)
            .accessibilityHidden(true)
            #else
            Text("모델 · 생각 깊이").font(SetupFont.label).foregroundStyle(CE.ink2).accessibilityHidden(true)
            #endif
        }) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, rank in
                if index > 0 { RowDivider(inset: 0) }
                rankRow(rank)
            }
        }
    }

    private func rankRow(_ rank: RankRow) -> some View {
        let overrides = rank.cli == .claude && rank.key != "staff" ? (store.bootstrap?.rankOverrides[rank.key] ?? 0) : 0
        let invalid = modelError(for: rank)
        let scope = overrides > 0 ? "\(rank.scope) · 직원별 지정 \(overrides)명" : rank.scope
        #if os(macOS)
        // web .st-ranks: 8 above and below a 44pt line (min-height 60); the rank 14.5/620, its scope 12.5 ink-2.
        return HStack(alignment: invalid != nil ? .top : .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(rank.title).font(SetupFont.row).foregroundStyle(CE.ink)
                Text(scope).font(SetupFont.hint).foregroundStyle(CE.ink2)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    modelMenu(rank).frame(width: Self.modelWidth)
                    Group {
                        if rank.showsEffort { effortMenu(rank) }
                        else {
                            Text("기본값").font(SetupFont.select).foregroundStyle(CE.ink3)
                                .padding(.leading, 11).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .frame(width: Self.effortWidth)
                }
                if let invalid {
                    Text(invalid).font(SetupFont.hint).foregroundStyle(CE.danger)
                        .lineSpacing(SetupFont.hintLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(width: Self.modelWidth + 8 + Self.effortWidth)
        }
        .padding(.vertical, 12)
        .frame(minHeight: 60)
        #else
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(rank.title).font(SetupFont.row).foregroundStyle(CE.ink)
                Text(scope).font(SetupFont.hint).foregroundStyle(CE.ink2)
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                modelMenu(rank)
                if rank.showsEffort { effortMenu(rank).frame(width: 124) }
            }
            if let invalid {
                Text(invalid).font(SetupFont.hint).foregroundStyle(CE.danger)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        #endif
    }

    private func model(of rank: RankRow) -> String { settingsTrim(draft.rankConfig(rank.key, cli: rank.cli)?.model ?? "") }

    private func modelMenu(_ rank: RankRow) -> some View {
        let value = model(of: rank)
        let list = store.modelCatalog.list(for: rank.cli)
        let selected = list.option(for: value)
        let defaultLabel = "기본값"
        let label = list.unknownCurrent(value) ?? selected?.label ?? defaultLabel
        // Sans like the web select, so 'CLI 기본' and a model name sit at the same size in the column.
        return SetupMenu(label, compact: true, label: "\(rank.title) 모델") {
            Toggle(defaultLabel, isOn: menuCheck(value.isEmpty) { customRanks.remove(rank.id); setModel(nil, for: rank) })
            Divider()
            ForEach(list.models) { option in
                Toggle(option.label, isOn: menuCheck(selected?.value == option.value) { customRanks.remove(rank.id); setModel(option.value, for: rank) })
            }
            if let unknown = list.unknownCurrent(value) { Text(unknown).disabled(true) }
        }
    }

    private func effortMenu(_ rank: RankRow) -> some View {
        let current = draft.rankConfig(rank.key, cli: rank.cli)?.effort
        let options = store.modelCatalog.list(for: rank.cli).efforts(for: model(of: rank), cli: rank.cli)
        let defaultLabel = "기본값"
        return SetupMenu(current ?? defaultLabel, compact: true, label: "\(rank.title) 생각 깊이") {
            Toggle(defaultLabel, isOn: menuCheck(current == nil) { setEffort(nil, for: rank) })
            Divider()
            ForEach(options, id: \.self) { effort in
                Toggle(effort, isOn: menuCheck(current == effort) { setEffort(effort, for: rank) })
            }
            if let current, !options.contains(current) { Text("현재: \(current)").disabled(true) }
        }
    }

    private func setModel(_ value: String?, for rank: RankRow) {
        var config = draft.rankConfig(rank.key, cli: rank.cli) ?? RankConfig()
        config.model = value
        draft[keyPath: rank.cli.ranksKeyPath][rank.key] = config
    }

    private func setEffort(_ value: String?, for rank: RankRow) {
        var config = draft.rankConfig(rank.key, cli: rank.cli) ?? RankConfig()
        config.effort = value
        draft[keyPath: rank.cli.ranksKeyPath][rank.key] = config
    }

    /// Same rule as the daemon: the name goes straight after `--model`, so no flags or spaces.
    private func modelError(for rank: RankRow) -> String? {
        if store.modelCatalog.list(for: rank.cli).unknownCurrent(model(of: rank)) != nil {
            return "\(rank.title): 목록에서 모델을 선택해 주세요"
        }
        return RankSettingsEditing.modelError(model(of: rank), custom: customRanks.contains(rank.id), title: rank.title)
    }

    // MARK: 알림

    /// The iPhone hears about its own notifications first; the Mac about its own banner first.
    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 22) {
            #if os(iOS)
            PushSettingsView()
            macNotifyGroup
            #else
            macNotifyGroup
            PushSettingsView()
            #endif
        }
    }

    private var macNotifyGroup: some View {
        SettingsGroup("Mac") {
            #if os(macOS)
            SettingsRow("Mac 알림", hint: "새 결재, 승인·선택 대기, 완료·막힘 보고, 대표 할 일을 알립니다") {
                Toggle("Mac 알림", isOn: $macAlerts).labelsHidden().settingsSwitch()
            }
            if let message = MacNotificationService.shared.permissionNotice { MetaText([message]) }
            #else
            Text("Mac 알림은 Mac의 IAMCEO 설정에서 켜거나 끌 수 있습니다.").font(CEFont.note).foregroundStyle(CE.ink2)
            #endif
        }
        .disabled(!editable || saving)
    }

    // MARK: 연결

    private var connectionSection: some View {
        let summary = connectionSummary()
        let online = store.bootstrap != nil && (!store.isDemo || Self.connectionSample)
        let notConnected: String? = store.bootstrap == nil && !store.isDemo
            ? (isMac ? "메인 창에서 서버에 연결하세요." : "서버에 연결하면 설정을 볼 수 있습니다.") : nil
        let urls = online ? (store.bootstrap?.urls ?? []) : []
        return VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                SettingsGroup("접속", footnote: notConnected) {
                    SettingsRow("상태", hint: store.lastHeartbeatAt.map { "마지막 연결 신호 \(koTime($0, seconds: true))" }) {
                        DotValue(tone: summary.tone, text: summary.text)
                    }
                    if online {
                        RowDivider(inset: 0)
                        SettingsRow("동기화", hint: store.lastSuccessfulSyncAt.map { "마지막 데이터 확인 \(koDateTime($0))" }) {
                            Button { Task { await refresh(.sync) } } label: {
                                HStack(spacing: 6) {
                                    if busy == .sync { ProgressView().controlSize(.small) }
                                    Text("지금 동기화")
                                }
                            }
                            .ceSecondaryButton()
                            .ceCompactControl()
                            .fixedSize()
                            .disabled(store.connectionStatus != .connected || store.isLoading || busy != nil)
                        }
                        RowDivider(inset: 0)
                        SettingsRow("서버 주소", stacksOnPhone: true) { addressText(store.endpoint) }
                        if !urls.isEmpty {
                            RowDivider(inset: 0)
                            SettingsRow("밖에서 접속할 주소", stacksOnPhone: true) {
                                VStack(alignment: isMac ? .trailing : .leading, spacing: 4) {
                                    ForEach(urls, id: \.self) { addressText($0) }
                                }
                            }
                        }
                        if let version = store.bootstrap?.version, !version.isEmpty {
                            RowDivider(inset: 0)
                            SettingsRow("버전") { Text(version).font(SetupFont.code).foregroundStyle(CE.ink).textSelection(.enabled) }
                        }
                    } else if let date = store.lastSuccessfulSyncAt {
                        RowDivider(inset: 0)
                        SettingsRow("마지막 데이터 확인") { Text(koDateTime(date)).font(SetupFont.value).foregroundStyle(CE.ink) }
                    }
                }
                // web: how phones reach the server, under the facts (.su-hint with the command as a code chip).
                if !urls.isEmpty {
                    Text(reachHint)
                        .font(SetupFont.hint).foregroundStyle(CE.ink2)
                        .lineSpacing(SetupFont.hintLeading)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.horizontal, SetupMetrics.groupInset)
                }
                if let syncError { SetupError(syncError).padding(.horizontal, SetupMetrics.groupInset) }
            }
            #if os(macOS)
            if !store.isDemo || Self.connectionSample {
                SettingsGroup {
                    SettingsRow("iPhone 연결", hint: "iPhone으로 QR을 찍으면 Tailscale로 연결됩니다") {
                        Button { router.showPairing = true } label: { Label("QR 보기", systemImage: "qrcode") }
                            .ceSecondaryButton()
                            .ceCompactControl()
                            .fixedSize()
                            .disabled(store.connectionStatus != .connected)
                    }
                }
            }
            #endif
            if canLeave || Self.connectionSample {
                SettingsGroup {
                    SettingsRow("이 기기에서 나가기", hint: "키체인에 저장한 접속 코드를 지웁니다") {
                        Button { confirmLeave = true } label: { Text("나가기").foregroundStyle(store.isDemo ? CE.ink3 : CE.danger) }
                            .ceSecondaryButton()
                            .ceCompactControl()
                            .fixedSize()
                            .disabled(store.isDemo)
                    }
                }
            }
        }
        .confirmationDialog("이 기기에서 나갈까요?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("나가기", role: .destructive) { leave() }
            Button("취소", role: .cancel) {}
        } message: {
            Text(leaveMessage)
        }
    }

    /// web .st-facts dd: the address itself is the value, so it reads at full ink.
    private func addressText(_ value: String) -> some View {
        Text(value).font(SetupFont.code).foregroundStyle(CE.ink)
            .textSelection(.enabled)
            .lineLimit(1).truncationMode(.middle)
            .help(value)
            .frame(maxWidth: isMac ? 320 : .infinity, alignment: isMac ? .trailing : .leading)
    }

    /// "폰에서는 Tailscale 주소(100.으로 시작)로 …": the command as a code chip (mono on a faint white fill).
    private var reachHint: AttributedString {
        var command = AttributedString("\u{00A0}iamceo setup --hosts lan\u{00A0}")
        command.font = SetupFont.code
        command.foregroundColor = CE.ink
        command.backgroundColor = Color.white.opacity(0.08)
        return AttributedString("폰에서는 Tailscale 주소(100.으로 시작)로 들어옵니다. 같은 망의 기기까지 열려면 서버 컴퓨터에서 ")
            + command + AttributedString(" 뒤 서버를 다시 켭니다.")
    }

    /// Review hook (DEBUG, sample only): `--connection-sample` lays out the rows a connected Mac shows (all disabled).
    private static var connectionSample: Bool {
        #if DEBUG
        return LaunchOptions.demo && LaunchOptions.arguments.contains("--connection-sample")
        #else
        return false
        #endif
    }

    private var canLeave: Bool { !store.isDemo && (store.bootstrap != nil || !store.accessCode.isEmpty || drafts.pendingCount > 0) }

    private var leaveMessage: String {
        let count = drafts.pendingCount
        let what = count > 0 ? "접속 코드와 쓰던 초안·메모 \(count)건을" : "접속 코드를"
        return "이 기기의 \(what) 지웁니다. 다시 들어오려면 서버 컴퓨터에서 iamceo\u{00A0}open 으로 코드를 확인해야 합니다."
    }

    private func connectionSummary() -> (tone: Tone, text: String) {
        if store.isDemo { return (.accent, "샘플 · 읽기 전용") }
        switch store.connectionStatus {
        case .connecting: return (.live, "연결하는 중")
        case .connected:
            return (store.realtimeStatus == .fallback || store.realtimeStatus == .blocked ? .attention : .success, store.localizedSyncDescription)
        case .failed: return (.danger, "연결 실패")
        case .disconnected, .demo: return (.danger, "연결 끊김")
        }
    }

    // MARK: Save bar (sticky glass, only when there is something to say)

    private var saveBarHost: some View {
        VStack(spacing: 0) { saveBar }
            .animation(.snappy(duration: 0.24), value: isDirty || savedNotice)
    }

    @ViewBuilder private var saveBar: some View {
        if isDirty || savedNotice {
            // web .st-bar: 60 tall, padding 8 8 8 18, gap 10, text 13.5 at 1.4 ink-2, buttons .gbtn--m (44).
            HStack(spacing: 10) {
                if isDirty {
                    VStack(alignment: .leading, spacing: 2) {
                        // iPhone: the short form fits beside 되돌리기 and 저장.
                        Text(isMac ? "저장하지 않은 변경이 있습니다" : "저장하지 않은 변경").font(CEFont.note.weight(.medium)).foregroundStyle(CE.ink2).lineLimit(1)
                        if let problem = saveError ?? firstModelError {
                            Text(problem).font(CEFont.caption).foregroundStyle(CE.danger).lineLimit(2)
                                .ceLineHeight(12, 1.4)
                        } else if let lockNotice {
                            Text(lockNotice.title).font(CEFont.caption).foregroundStyle(CE.ink3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: CESpace.s)
                    Button("되돌리기") { revert() }
                        .ceSecondaryButton()
                        .controlSize(.regular)
                        .disabled(saving)
                        .fixedSize()
                    Button { Task { await save() } } label: {
                        HStack(spacing: 6) {
                            if saving { ProgressView().controlSize(.small).tint(.white) }
                            Text(saving ? "저장하는 중" : "저장")
                        }
                    }
                    .ceProminentButton()
                    .controlSize(.regular)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!canSave)
                    .fixedSize()
                } else {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 15)).foregroundStyle(CE.success)
                    Text("저장했습니다. 모델과 생각 깊이는 다음 실행부터 적용됩니다.")
                        .font(CEFont.note).foregroundStyle(CE.success).lineLimit(2)
                        .ceLineHeight(13.5, 1.4)
                    Spacer(minLength: 0)
                }
            }
            .padding(.leading, isMac ? 18 : 14).padding(.trailing, 8).padding(.vertical, 8)
            .frame(minHeight: isMac ? 60 : 56)
            .glassChrome(RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous), tint: Color(red: 16 / 255, green: 11 / 255, blue: 38 / 255).opacity(0.86))
            .frame(maxWidth: 880)
            .padding(.horizontal, isMac ? 24 : 16).padding(.top, CESpace.s).padding(.bottom, CESpace.m)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: Actions

    /// Keep the reviewed baseline pinned while the person edits.
    private func syncFromStore() {
        guard let server = store.bootstrap?.settings else { return }
        guard !loaded || !isDirty else { return }
        let edit = store.beginSettingsEditing()
        draft = edit?.draft ?? server
        base = edit?.base ?? server
        loaded = true
    }

    private func revert() {
        let edit = store.beginSettingsEditing()
        base = edit?.base ?? store.bootstrap?.settings ?? base
        draft = base
        store.setSettingsDraft(base)
        customRanks = []
        saveError = nil
        macAlerts = baseMacAlerts
    }

    /// Rebase only fields this screen changed, after the owner explicitly chooses to review them.
    private func reviewChanges() {
        let previous = base, mine = draft
        guard let edit = store.beginSettingsEditing() else { return }
        var next = edit.base
        if mine.permissionMode != previous.permissionMode { next.permissionMode = mine.permissionMode }
        if mine.maxConcurrentTurns != previous.maxConcurrentTurns { next.maxConcurrentTurns = mine.maxConcurrentTurns }
        if mine.compactAtPct != previous.compactAtPct { next.compactAtPct = mine.compactAtPct }
        if mine.maxAwakeWorkers != previous.maxAwakeWorkers { next.maxAwakeWorkers = mine.maxAwakeWorkers }
        if mine.notifyMac != previous.notifyMac { next.notifyMac = mine.notifyMac }
        if mine.boardTidyHours != previous.boardTidyHours { next.boardTidyHours = mine.boardTidyHours }
        next = RankSettingsEditing.rebase(previous: previous, mine: mine, onto: next)
        base = edit.base; draft = next; store.setSettingsDraft(next)
        saveError = "새 설정과 내 변경을 확인한 뒤 저장해 주세요."
    }

    private func save() async {
        guard canSave else { return }
        savingLocal = true
        defer { savingLocal = false }
        saveError = nil
        var next = draft
        // This screen never chooses the runner. Omitting the key leaves the daemon's value untouched.
        next.backend = nil
        for cli in RankSettingsCLI.allCases {
            for (key, config) in next[keyPath: cli.ranksKeyPath] {
                var cleaned = config
                let model = settingsTrim(config.model ?? "")
                cleaned.model = model.isEmpty ? nil : model
                next[keyPath: cli.ranksKeyPath][key] = cleaned
            }
        }
        let namespace = editedNamespace
        let accepted = await store.updateSettings(next)
        guard namespace == store.writeNamespace else { return }
        if accepted {
            #if os(macOS)
            if macAlerts != baseMacAlerts || macAlerts && store.bootstrap?.settings.macScriptNotifications != false {
                let configured = await MacNotificationService.shared.setEnabled(macAlerts, api: store.api)
                guard namespace == store.writeNamespace else { return }
                if !configured {
                    saveError = MacNotificationService.shared.permissionNotice ?? "Mac 알림 설정을 저장하지 못했습니다."
                    base = store.bootstrap?.settings ?? next; draft = base
                    return
                }
                await store.refresh()
                guard namespace == store.writeNamespace else { return }
            }
            baseMacAlerts = macAlerts
            #endif
            let saved = store.bootstrap?.settings ?? next
            base = saved
            draft = saved
            customRanks = []
            noticeTask?.cancel()
            savedNotice = true
            noticeTask = Task {
                try? await Task.sleep(for: .seconds(6))
                if !Task.isCancelled { savedNotice = false }
            }
        } else {
            saveError = store.errorMessage.map(friendlyError) ?? "저장하지 못했습니다."
        }
    }

    /// Both buttons re-read bootstrap, which carries the runtime diagnostics.
    private func refresh(_ kind: Busy) async {
        busy = kind
        if kind == .sync { syncError = nil } else { runtimeError = nil }
        defer { busy = nil }
        let before = store.lastUpdated
        if kind == .runtime { await store.refreshDiagnostics() } else { await store.refresh() }
        guard store.lastUpdated == before, let error = store.errorMessage else { return }
        if kind == .sync { syncError = friendlyError(error) } else { runtimeError = friendlyError(error) }
    }

    private func leave() {
        drafts.removeAll()
        store.disconnect()
        dismiss()
    }

    #if os(iOS)
    private func close() {
        switch SettingsCloseAction.resolve(dirty: isDirty, saving: saving) {
        case .close: dismiss()
        case .confirm: confirmDiscard = true
        case .wait: break
        }
    }
    #endif

    private func saveAndClose() async {
        if !isDirty { finishClosing(); return }
        await save()
        if !isDirty && !saving { finishClosing() }
    }

    private func finishClosing() {
        #if os(macOS)
        settingsWindow?.close()
        #else
        dismiss()
        #endif
    }

    private func revealRuntime() {
        guard SettingsNavigation.shared.pendingRuntime else { return }
        SettingsNavigation.shared.pendingRuntime = false
        #if os(macOS)
        section = .ai
        #else
        path = [.ai]
        #endif
        highlightRuntime = true
        let revision = SettingsNavigation.shared.revision
        Task {
            try? await Task.sleep(for: .seconds(3))
            if revision == SettingsNavigation.shared.revision { highlightRuntime = false }
        }
    }

    /// Compares only what this screen edits, with model names normalized the way they are saved.
    private static func signature(_ settings: Settings) -> String {
        var parts = [settings.permissionMode, "\(settings.maxConcurrentTurns)", "\(settings.compactAtPct)", "\(settings.maxAwakeWorkers)", "\(settings.notifyMac)", "\(Int(settings.boardTidyHours.rounded()))"]
        parts += RankSettingsEditing.signature(settings)
        return parts.joined(separator: "|")
    }
}

#if os(macOS)
/// The settings sidebar item: the main window rail's row (hover tint, violet gradient when chosen).
private struct SettingsNavStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View { NavBody(configuration: configuration, selected: selected) }
    private struct NavBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.32), CE.violet.opacity(0.2)], startPoint: .top, endPoint: .bottom))
                            .overlay {
                                shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.32), Color.white.opacity(0.05)], startPoint: .top, endPoint: .bottom), lineWidth: 1)
                            }
                    } else if configuration.isPressed {
                        shape.fill(Color.white.opacity(0.09))
                    } else if hovering {
                        shape.fill(Color.white.opacity(0.06))
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}
#endif

// MARK: - 프로젝트 (rename, archive, restore)

/// Common management sheets keep settings, the rail and the phone switcher on one mutation path.
private struct SettingsProjectsGroup: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let editable: Bool
    @State private var showArchive = false

    var body: some View {
        SettingsGroup("프로젝트", accessory: {
            Button { showArchive = true } label: {
                Label("보관함", systemImage: "archivebox")
            }
            .ceSecondaryButton()
            // The caption line's own size (26, like the ↻ of the other captions); iPhone keeps its 44pt target.
            .controlSize(.mini)
            .fixedSize()
            .help("보관한 프로젝트 보기")
        }) {
            ForEach(Array(store.projects.enumerated()), id: \.element.id) { index, project in
                if index > 0 { RowDivider(inset: 0) }
                row(project)
            }
        }
        .sheet(isPresented: $showArchive) { ArchiveLibraryView() }
    }

    /// web .st-pj: name 14.5/620 and the folder in code 12.5 ink-2 (wrapping), 고치기 and 보관 in sight. iPhone keeps
    /// them in the ⋯ menu so the row stays one line.
    private func row(_ project: ProjectSummary) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).font(SetupFont.row).foregroundStyle(CE.ink).lineLimit(1)
                Text(project.cwd).font(CEFont.mono).foregroundStyle(CE.ink2)
                    .ceLineHeight(12.5, 1.45)
                    .lineLimit(2).truncationMode(.middle)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(project.cwd)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            #if os(macOS)
            HStack(spacing: 6) {
                Button("고치기") { router.manageProject(id: project.id, mode: .settings) }
                    .accessibilityLabel("\(project.name) 고치기")
                    .help("이름과 폴더 고치기")
                if !project.isHq && project.id != "hq" {
                    Button("보관") { router.manageProject(id: project.id, mode: .archive) }
                        .accessibilityLabel("\(project.name) 보관하기")
                }
            }
            .ceSecondaryButton()
            .controlSize(.small)
            .fixedSize()
            .disabled(!editable)
            #else
            Menu {
                Button("이름 바꾸기…") { router.manageProject(id: project.id, mode: .rename) }
                Button("폴더 고치기…") { router.manageProject(id: project.id, mode: .settings) }
                if !project.isHq && project.id != "hq" {
                    Button("보관…") { router.manageProject(id: project.id, mode: .archive) }
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(editable ? CE.ink2 : CE.ink3)
                    .frame(width: 28, height: 28)
                    .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .disabled(!editable)
            .help("관리")
            .accessibilityLabel("\(project.name) 관리")
            #endif
        }
        .padding(.vertical, 12)
        .frame(minHeight: isMac ? 60 : 52)
    }
}

// MARK: - New project (sheet)

struct NewProjectView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var cwd = ""
    @State private var showFolderPicker = false
    @State private var showGitHubClone = false
    /// Set when the folder came from "GitHub에서 가져오기", so the chosen-folder tile can say where it came from.
    @State private var clonedRepository: String?
    @State private var legacyFolderInput = false
    @State private var provider = "claude"
    @State private var working = false
    @State private var error: String?
    /// The daemon keeps a project whose conductor failed to start; retrying "만들기" would make a second one.
    @State private var partial: Partial?
    @State private var createdID: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case name, cwd }
    private struct Partial { let id: String; var detail: String }

    private var canCreate: Bool {
        store.canWrite && !working && !ProjectCreationNotice.shared.running && partial == nil && createdID == nil && !store.pendingActions.contains("create-project") && !settingsTrim(name).isEmpty && !settingsTrim(cwd).isEmpty
    }
    private var lockNotice: (title: String, detail: String)? {
        if store.isDemo { return ("샘플은 읽기 전용입니다", "실제 Mac에 연결하면 프로젝트를 만들 수 있습니다.") }
        if !store.canWrite { return ("서버에 연결되지 않았습니다", "연결된 뒤에 만들 수 있습니다. 적은 내용은 이 창을 닫기 전까지 남아 있습니다.") }
        return nil
    }
    private var coreUnavailable: CoreRuntime? {
        guard let core = store.runtime?.core, !core.available else { return nil }
        return core
    }

    var body: some View {
        CESheet("새 프로젝트", subtitle: "작업 폴더를 고르면 총괄이 바로 일을 시작합니다.", icon: "folder.badge.plus", width: 520,
                onClose: { dismiss() }) {
            form
        } footer: {
            Button(working ? "뒤에서 계속 만들기" : partial == nil && createdID == nil ? "취소" : "닫기") { dismiss() }
                .ceSecondaryButton()
            if let createdID {
                Button("총괄에게 첫 일 맡기기") { Task { await openCreated(createdID) } }.ceProminentButton()
            } else if partial != nil {
                Button { Task { await retryConductor() } } label: { busyLabel(working ? "띄우는 중" : "다시 시도") }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(working || !store.canWrite)
            } else {
                Button { Task { await create() } } label: { busyLabel(working ? "만드는 중" : "만들기") }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        #if os(iOS)
        // Flows through the environment to CESheet's ScrollView: a swipe puts the keyboard away.
        .scrollDismissesKeyboard(.interactively)
        #endif
        .sheet(isPresented: $showFolderPicker) { FolderPickerView(initialPath: cwd.isEmpty ? nil : cwd) { cwd = $0; clonedRepository = nil } }
        .sheet(isPresented: $showGitHubClone) {
            GitHubCloneView { path, repositoryName in
                cwd = path
                clonedRepository = repositoryName
                if settingsTrim(name).isEmpty { name = repositoryName }
            }
        }
        .task {
            if let browser = try? await store.folderBrowser(), case .legacy = browser { legacyFolderInput = true }
            #if DEBUG
            if store.isDemo {
                showFolderPicker = LaunchOptions.value(after: "--sheet") == "folder-picker"
                showGitHubClone = LaunchOptions.value(after: "--sheet") == "github-clone"
            }
            #endif
        }
        #if os(macOS)
        .onAppear { if store.canWrite { focus = .name } }
        #endif
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let lockNotice {
                InlineNotice(tone: store.isDemo ? .accent : .attention, icon: store.isDemo ? "eye" : "wifi.slash", title: lockNotice.title, detail: lockNotice.detail)
            }
            Group {
                SetupField("이름") {
                    TextField("이름", text: $name, prompt: Text("랜딩 리뉴얼"))
                        .labelsHidden()
                        .font(SetupFont.input)
                        .focused($focus, equals: .name)
                        .onSubmit { if legacyFolderInput { focus = .cwd } }
                        .ceField(focused: focus == .name)
                }
                SetupField("폴더") {
                    if legacyFolderInput {
                        TextField("폴더", text: $cwd, prompt: Text(verbatim: "~/code/landing"))
                            .labelsHidden().font(SetupFont.codeInput).focused($focus, equals: .cwd).autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .onSubmit { Task { await create() } }.ceField(focused: focus == .cwd)
                    } else if cwd.isEmpty {
                        // Two ways in, side by side: an existing/new server folder, or a GitHub repository cloned for it.
                        HStack(spacing: 10) {
                            FolderSourceTile(icon: "folder", title: "폴더 고르기", detail: "서버 컴퓨터의 폴더를 고르거나 새로 만듭니다") { showFolderPicker = true }
                            FolderSourceTile(icon: "arrow.down.circle", title: "GitHub에서 가져오기", detail: "내 저장소를 받아 그 폴더로 엽니다") { showGitHubClone = true }
                        }
                    } else {
                        chosenFolder
                    }
                }
                SetupField("총괄이 쓸 AI") {
                    SettingsSegments(options: ["claude", "codex"].map { SettingsSegments.Option(id: $0, title: providerLabel($0)) },
                                     selection: provider, label: "총괄이 쓸 AI", fill: true) { provider = $0 }
                }
            }
            .disabled(partial != nil || createdID != nil || working)
            if working {
                InlineNotice(title: "프로젝트를 만드는 중입니다", detail: "이 창을 닫아도 만들기는 계속됩니다. 결과는 안내 띠로 알려 드립니다.")
            }
            if createdID != nil {
                InlineNotice(tone: .success, title: "프로젝트를 만들었습니다", detail: "총괄에게 첫 일을 맡겨 보세요.")
            }
            if let core = coreUnavailable, partial == nil {
                InlineNotice(tone: .attention, icon: "exclamationmark.triangle",
                             title: core.installed ? "실행 엔진을 쓸 수 없습니다" : "실행 엔진(herdr-core)이 설치되지 않았습니다",
                             detail: [core.detail, "지금 만들면 프로젝트만 생기고 총괄은 뜨지 않을 수 있습니다. 설정 › AI 모델의 실행 환경을 확인하세요."].compactMap { $0 }.joined(separator: " "),
                             actionTitle: "실행 환경 보기", action: {
                    SettingsView.showRuntime(); dismiss(); router.showSettings = true
                })
            }
            if let partial {
                InlineNotice(tone: .danger, icon: "exclamationmark.triangle", title: "프로젝트는 만들었지만 총괄을 띄우지 못했습니다",
                             detail: partial.detail + " 다시 시도하면 같은 프로젝트에 총괄만 다시 띄웁니다.",
                             actionTitle: "프로젝트로 가기", action: { Task { await openPartial() } }, actionDisabled: working)
            }
            if let error { SetupError(error) }
        }
    }

    /// The chosen folder as one quiet tile: where the project will live, where it came from, and a way to change it.
    private var chosenFolder: some View {
        let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
        return HStack(spacing: 12) {
            Image(systemName: clonedRepository == nil ? "folder.fill" : "arrow.down.circle.fill")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(CE.accent)
                .frame(width: 32, height: 32)
                .background(CE.violet.opacity(0.16), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(CE.violet.opacity(0.3)) }
            VStack(alignment: .leading, spacing: 3) {
                Text(cwd).font(SetupFont.codeInput).foregroundStyle(CE.ink).lineLimit(1).truncationMode(.middle)
                    .help(cwd)
                Text(clonedRepository.map { "GitHub 저장소 \($0)에서 받은 폴더" } ?? "서버 컴퓨터의 폴더")
                    .font(SetupFont.hint).foregroundStyle(CE.ink2).lineLimit(1)
            }
            Spacer(minLength: 8)
            Menu {
                Button { showFolderPicker = true } label: { Label("다른 폴더 고르기…", systemImage: "folder") }
                Button { showGitHubClone = true } label: { Label("GitHub에서 가져오기…", systemImage: "arrow.down.circle") }
            } label: {
                QuietMenuLabel(title: "바꾸기")
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("폴더 바꾸기")
        }
        .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 10)
        .background(Color.white.opacity(0.04), in: shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("선택한 폴더: " + cwd)
    }

    private func busyLabel(_ text: String) -> some View {
        HStack(spacing: 6) {
            if working { ProgressView().controlSize(.small).tint(.white) }
            Text(text)
        }
    }

    private func providerLabel(_ cli: String) -> String {
        providerFullName(cli) + (store.runtime?.providers[cli]?.installed == false ? " · 설치 필요" : "")
    }

    private func create() async {
        guard canCreate else { return }
        error = nil
        working = true
        defer { working = false }
        let result = await ProjectCreationNotice.shared.create(store: store, name: settingsTrim(name), cwd: settingsTrim(cwd), provider: provider)
        switch result {
        case .created(let id): createdID = id
        case .partial(let id, let detail): partial = Partial(id: id, detail: detail)
        case .failed(let detail): error = detail
        case .hostChanged: error = "연결이 바뀌었습니다. 원래 Mac에서 만들기 결과를 확인해 주세요."
        }
    }

    private func retryConductor() async {
        guard let target = partial else { return }
        let namespace = store.writeNamespace
        working = true
        defer { working = false }
        if store.selectedProjectID != target.id { await store.selectProject(id: target.id) }
        guard namespace == store.writeNamespace, store.selectedProjectID == target.id else { return }
        if await store.startConductor() {
            guard namespace == store.writeNamespace else { return }
            createdID = target.id; partial = nil
            ProjectCreationNotice.shared.finish(projectID: target.id, message: "총괄이 준비되었습니다. 첫 일을 맡겨 보세요.")
        } else {
            partial?.detail = store.errorMessage.map(friendlyError) ?? "총괄을 띄우지 못했습니다."
        }
    }

    private func openCreated(_ id: String) async {
        if await ProjectCreationNotice.openProject(id, store: store, router: router) { dismiss() }
    }

    private func openPartial() async {
        guard let target = partial else { return }
        if store.selectedProjectID != target.id { await store.selectProject(id: target.id) }
        router.go(.team)
        dismiss()
    }
}

/// The label of a menu that should look like a small quiet button (web .gbtn--glass .gbtn--s: 32 tall, 13.5/600).
/// Menus draw their own label, so the capsule is drawn here instead of through a button style.
private struct QuietMenuLabel: View {
    let title: String
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    var body: some View {
        Text(title)
            .font(isMac ? .system(size: 13.5, weight: .semibold) : CEFont.rowTitle)
            .tracking(-0.15)
            .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
            .padding(.horizontal, 14)
            .frame(minHeight: isMac ? 32 : 38)
            .background(LinearGradient(colors: [Color.white.opacity(hovering && isEnabled ? 0.16 : 0.10), Color.white.opacity(hovering && isEnabled ? 0.06 : 0.03)],
                                       startPoint: .top, endPoint: .bottom), in: Capsule())
            .overlay { if isEnabled { GlassRim(shape: Capsule()) } else { Capsule().strokeBorder(CE.line) } }
            .frame(minHeight: isMac ? nil : 44)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// One of the two ways to give a new project its folder: icon tile, title, one short line. Equal width side by side.
private struct FolderSourceTile: View {
    let icon: String
    let title: String
    let detail: String
    let action: () -> Void
    var body: some View {
        // web .choice: radius 13, padding 11/13 (a little more here: the tile carries an icon), 14/600 title,
        // 12.5 ink-2 line at 1.4.
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(CE.accent)
                    .frame(width: 32, height: 32)
                    .background(CE.violet.opacity(0.16), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(CE.violet.opacity(0.3)) }
                    .padding(.bottom, 10)
                Text(title).font(SetupFont.row).foregroundStyle(CE.ink)
                    .padding(.bottom, 3)
                Text(detail).font(SetupFont.hint).foregroundStyle(CE.ink2)
                    .lineSpacing(SetupFont.choiceLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
            .padding(.horizontal, 14).padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(FolderSourceTileStyle())
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
}

private struct FolderSourceTileStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { TileBody(configuration: configuration) }
    private struct TileBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
            configuration.label
                .background(Color.white.opacity(configuration.isPressed ? 0.09 : hovering && isEnabled ? 0.065 : 0.04), in: shape)
                .overlay { shape.strokeBorder(hovering && isEnabled ? CE.violet.opacity(0.55) : Color.white.opacity(0.1), lineWidth: hovering && isEnabled ? 1.25 : 1) }
                .scaleEffect(configuration.isPressed ? 0.985 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { hovering = $0 }
        }
    }
}
