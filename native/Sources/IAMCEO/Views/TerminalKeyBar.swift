#if os(iOS)
import SwiftTerm
import UIKit

/// The key bar above the iPhone keyboard while typing into a live terminal: the keys a CLI needs that the system
/// keyboard lacks, drawn as separate chips in the app's dark style (SwiftTerm's default bar is a row of plain grey
/// system labels with nothing between them).
///
/// - esc · tab · ctrl (a sticky modifier for the next key, lit violet while on) · ⌃C, then the arrows (they repeat
///   while held), then / - | ~ — on a horizontally scrolling row.
/// - Pinned at the right end, behind a hairline: lower the keyboard.
/// - Every chip is 34pt tall, at least 40pt wide, 9pt corners, a white .09 fill with a white .10 edge. It lights up
///   while pressed, and gives a light haptic tick.
final class TerminalKeyBar: UIInputView, UIInputViewAudioFeedback {
    private weak var terminal: SwiftTerm.TerminalView?
    private let scroll = UIScrollView()
    private let row = UIStackView()
    private var controlChip: UIButton?
    private var repeatTimer: Timer?
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    static let height: CGFloat = 50

    init(terminal: SwiftTerm.TerminalView) {
        self.terminal = terminal
        super.init(frame: CGRect(x: 0, y: 0, width: 390, height: Self.height), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(controlReset),
                                               name: Notification.Name("SwiftTerm.TerminalView.controlModifierReset"), object: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    // The repeat timer is invalidated on touch up / cancel, and when the bar leaves its window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { repeatTimer?.invalidate(); repeatTimer = nil }
    }

    var enableInputClicksWhenVisible: Bool { true }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: Self.height) }

    // MARK: Layout

    private func build() {
        backgroundColor = UIColor(red: 18 / 255, green: 14 / 255, blue: 38 / 255, alpha: 0.97)
        let hairline = UIView()
        hairline.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        hairline.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hairline)

        row.axis = .horizontal
        row.spacing = 6
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.delaysContentTouches = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        addSubview(scroll)

        let groups: [[UIButton]] = [
            [chip("esc") { [weak self] in self?.send([0x1b]) },
             chip("tab") { [weak self] in self?.send([0x09]) },
             controlToggle(),
             chip("⌃C", accessibility: "컨트롤 C, 중단") { [weak self] in self?.send([0x03]) }],
            [arrow("arrow.up", "위") { [weak self] in self?.sendCursor(up: true) },
             arrow("arrow.down", "아래") { [weak self] in self?.sendCursor(up: false) },
             arrow("arrow.left", "왼쪽") { [weak self] in self?.sendHorizontal(left: true) },
             arrow("arrow.right", "오른쪽") { [weak self] in self?.sendHorizontal(left: false) }],
            ["/", "-", "|", "~"].map { text in chip(text) { [weak self] in self?.insert(text) } },
        ]
        for (index, group) in groups.enumerated() {
            if index > 0 { row.addArrangedSubview(gap()) }
            group.forEach(row.addArrangedSubview)
        }

        // Pinned right: lower the keyboard, set off by a hairline.
        let divider = UIView()
        divider.backgroundColor = UIColor.white.withAlphaComponent(0.1)
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)
        let lower = chip(symbol: "keyboard.chevron.compact.down", accessibility: "키보드 내리기") { [weak self] in
            self?.terminal?.resignFirstResponder()
        }
        lower.translatesAutoresizingMaskIntoConstraints = false
        addSubview(lower)

        NSLayoutConstraint.activate([
            hairline.topAnchor.constraint(equalTo: topAnchor),
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            lower.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -8),
            lower.centerYAnchor.constraint(equalTo: centerYAnchor),
            divider.trailingAnchor.constraint(equalTo: lower.leadingAnchor, constant: -8),
            divider.centerYAnchor.constraint(equalTo: centerYAnchor),
            divider.widthAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            divider.heightAnchor.constraint(equalToConstant: 26),

            scroll.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: divider.leadingAnchor, constant: -2),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerYAnchor),
            row.heightAnchor.constraint(equalToConstant: 34),
        ])
    }

    private func gap() -> UIView {
        let spacer = UIView()
        spacer.widthAnchor.constraint(equalToConstant: 4).isActive = true
        return spacer
    }

    // MARK: Chips

    private func style(_ button: UIButton, title: String?, symbol: String?, mono: Bool) {
        var config = UIButton.Configuration.plain()
        if let title {
            var attributed = AttributedString(title)
            attributed.font = mono ? UIFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
                                   : UIFont.systemFont(ofSize: 14, weight: .semibold)
            config.attributedTitle = attributed
        }
        if let symbol {
            config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
        }
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 11, bottom: 0, trailing: 11)
        config.background.cornerRadius = 9
        config.background.strokeWidth = 1
        config.cornerStyle = .fixed
        button.configuration = config
        button.configurationUpdateHandler = { button in
            var config = button.configuration ?? .plain()
            let on = button.isSelected
            let pressed = button.isHighlighted
            config.background.backgroundColor = on
                ? UIColor(red: 122 / 255, green: 91 / 255, blue: 255 / 255, alpha: pressed ? 0.7 : 0.85)
                : UIColor.white.withAlphaComponent(pressed ? 0.2 : 0.09)
            config.background.strokeColor = on ? UIColor.white.withAlphaComponent(0.25) : UIColor.white.withAlphaComponent(0.1)
            config.baseForegroundColor = on ? .white : UIColor(red: 245 / 255, green: 242 / 255, blue: 255 / 255, alpha: 1)
            button.configuration = config
        }
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 34).isActive = true
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
    }

    private func chip(_ title: String, accessibility: String? = nil, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .custom)
        style(button, title: title, symbol: nil, mono: title.count == 1)
        button.accessibilityLabel = accessibility ?? title
        button.addAction(UIAction { [weak self] _ in self?.tick(); action() }, for: .touchUpInside)
        return button
    }

    private func chip(symbol: String, accessibility: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .custom)
        style(button, title: nil, symbol: symbol, mono: false)
        button.accessibilityLabel = accessibility
        button.addAction(UIAction { [weak self] _ in self?.tick(); action() }, for: .touchUpInside)
        return button
    }

    /// Arrows fire on touch down and repeat while held (0.4s, then every 0.08s), like a hardware key.
    private func arrow(_ symbol: String, _ name: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .custom)
        style(button, title: nil, symbol: symbol, mono: false)
        button.accessibilityLabel = "\(name) 화살표"
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.tick(); action()
            self.repeatTimer?.invalidate()
            self.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in action() }
            }
        }, for: .touchDown)
        for event: UIControl.Event in [.touchUpInside, .touchUpOutside, .touchCancel] {
            button.addAction(UIAction { [weak self] _ in self?.repeatTimer?.invalidate(); self?.repeatTimer = nil }, for: event)
        }
        return button
    }

    /// ctrl: on until the next key is typed (SwiftTerm resets the terminal's modifier then and posts a notification).
    private func controlToggle() -> UIButton {
        let button = UIButton(type: .custom)
        style(button, title: "ctrl", symbol: nil, mono: false)
        button.accessibilityLabel = "컨트롤 키"
        button.addAction(UIAction { [weak self, weak button] _ in
            guard let self, let button else { return }
            self.tick()
            button.isSelected.toggle()
            self.terminal?.controlModifier = button.isSelected
            button.accessibilityValue = button.isSelected ? "켜짐" : "꺼짐"
        }, for: .touchUpInside)
        controlChip = button
        return button
    }

    @objc private func controlReset() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let chip = self.controlChip, self.terminal?.controlModifier != true else { return }
            chip.isSelected = false
            chip.accessibilityValue = "꺼짐"
        }
    }

    // MARK: Sending

    private func tick() {
        haptic.impactOccurred(intensity: 0.6)
        UIDevice.current.playInputClick()
    }

    private func send(_ bytes: [UInt8]) {
        terminal?.send(bytes)
    }

    private func insert(_ text: String) {
        terminal?.insertText(text)
    }

    private func sendCursor(up: Bool) {
        guard let terminal else { return }
        let app = terminal.getTerminal().applicationCursor
        terminal.send(up ? (app ? EscapeSequences.moveUpApp : EscapeSequences.moveUpNormal)
                         : (app ? EscapeSequences.moveDownApp : EscapeSequences.moveDownNormal))
    }

    private func sendHorizontal(left: Bool) {
        guard let terminal else { return }
        let app = terminal.getTerminal().applicationCursor
        terminal.send(left ? (app ? EscapeSequences.moveLeftApp : EscapeSequences.moveLeftNormal)
                           : (app ? EscapeSequences.moveRightApp : EscapeSequences.moveRightNormal))
    }
}

#if DEBUG
import SwiftUI

/// Review hook (`--sheet keybar`): a local terminal with sample text, typing enabled, so the key bar shows over the
/// keyboard in screenshots. Nothing is sent anywhere.
struct TerminalKeyBarPreview: UIViewRepresentable {
    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 500),
                                          font: .monospacedSystemFont(ofSize: 11, weight: .regular))
        view.nativeBackgroundColor = UIColor(red: 11 / 255, green: 9 / 255, blue: 24 / 255, alpha: 1)
        view.nativeForegroundColor = UIColor(red: 245 / 255, green: 242 / 255, blue: 255 / 255, alpha: 1)
        view.feed(text: "Claude Code\r\n\r\n> 다음 작업을 입력하세요\r\n")
        view.inputAccessoryView = TerminalKeyBar(terminal: view)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { _ = view.becomeFirstResponder() }
        return view
    }
    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {}
}
#endif
#endif
