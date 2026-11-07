import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
#if os(iOS)
import UIKit
import VisionKit
#endif

/// Crisp QR code for any text (CoreImage, no network).
struct QRCodeImage: View {
    let text: String
    var body: some View {
        if let image = Self.render(text) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            Color.clear
        }
    }
    static func render(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}

// MARK: - Mac: show the QR

#if os(macOS)
/// Mac → 'iPhone 연결': a one-time QR (5 minutes) for the phone's camera.
struct MacPairingSheet: View {
    @Environment(AppStore.self) private var store
    @State private var start: PairStart?
    @State private var loading = false
    @State private var failure: String?

    private var link: PairingLink? {
        guard let start else { return nil }
        let urls = start.urls.compactMap { (try? ServerEndpoint($0))?.url }
        return urls.isEmpty ? nil : PairingLink(code: start.code, urls: urls)
    }
    private var expiry: Date? { parseISODate(start?.expiresAt) }

    private static let qrSide: CGFloat = 216
    private static let steps = [
        "iPhone과 이 Mac 모두 Tailscale을 켭니다.",
        "iPhone 카메라로 QR을 비추고 뜨는 알림을 누릅니다.",
        "IAMCEO 앱이 열리며 바로 연결됩니다.",
    ]

    var body: some View {
        CESheet("iPhone 연결", subtitle: "한 번만 쓰는 연결 QR입니다.", icon: "iphone", width: 440) {
            VStack(spacing: 20) {
                content
                    .frame(maxWidth: .infinity)
                stepList
            }
        }
        .task { await make() }
    }

    @ViewBuilder private var content: some View {
        if loading && start == nil {
            qrTile { ProgressView().controlSize(.small) }
                .accessibilityLabel("QR을 만드는 중입니다")
        } else if let failure {
            InlineNotice(tone: .danger, title: "QR을 만들지 못했습니다", detail: failure, actionTitle: "다시 시도") { Task { await make() } }
        } else if start != nil, link == nil {
            InlineNotice(tone: .attention, icon: "network.slash", title: "이 Mac의 Tailscale이 꺼져 있습니다",
                         detail: "iPhone이 닿을 Tailscale 주소가 없습니다. 이 Mac에서 Tailscale을 켠 뒤 다시 만드세요.",
                         actionTitle: "다시 만들기") { Task { await make() } }
        } else if let link, let expiry {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = Int(expiry.timeIntervalSince(context.date).rounded(.down))
                let hosts = link.urls.map { $0.host ?? "" }.joined(separator: " · ")
                VStack(spacing: 12) {
                    if left > 0 {
                        QRCodeImage(text: link.url.absoluteString)
                            .frame(width: Self.qrSide, height: Self.qrSide)
                            .padding(14)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("iPhone 연결 QR 코드")
                    } else {
                        // Used up: no grey ghost of the old code, just the empty tile and the way to a new one.
                        qrTile {
                            VStack(spacing: 14) {
                                Image(systemName: "qrcode")
                                    .font(.system(size: 34, weight: .light)).foregroundStyle(CE.ink3)
                                    .accessibilityHidden(true)
                                Button("새 QR 만들기") { Task { await make() } }
                                    .ceProminentButton()
                                    .keyboardShortcut(.defaultAction)
                                    .disabled(loading)
                            }
                        }
                    }
                    countdown(left)
                    // The address of a used-up code is noise; its line keeps its place so the sheet does not jump.
                    Group {
                        if left > 0 {
                            Text(hosts)
                                .textSelection(.enabled)
                                .help(hosts)
                        } else {
                            Text(hosts).hidden().accessibilityHidden(true)
                        }
                    }
                    .font(CEFont.mono).foregroundStyle(CE.ink3)
                    .lineLimit(1).truncationMode(.middle)
                }
            }
        }
    }

    /// The white tile the QR sits on, also used empty (with a spinner) while the code is being made.
    private func qrTile<Inner: View>(@ViewBuilder _ inner: () -> Inner) -> some View {
        inner()
            .frame(width: Self.qrSide, height: Self.qrSide)
            .padding(14)
            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(CE.line) }
    }

    /// Quiet pill under the QR: time left, or that it ran out.
    private func countdown(_ left: Int) -> some View {
        HStack(spacing: 5) {
            Image(systemName: left > 0 ? "clock" : "clock.badge.exclamationmark")
                .font(.system(size: 10.5, weight: .semibold))
            Text(left > 0 ? "\(left / 60):\(String(format: "%02d", left % 60)) 남음" : "시간이 지났습니다")
                .monospacedDigit()
        }
        .font(CEFont.meta.weight(.medium))
        .foregroundStyle(left > 0 ? CE.ink2 : CE.attention)
        .padding(.horizontal, 10).frame(height: 24)
        .background(Color.white.opacity(0.06), in: Capsule())
        .overlay { Capsule().strokeBorder(CE.line) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(left > 0 ? "\(left / 60)분 \(left % 60)초 동안 한 번 쓸 수 있습니다" : "QR 시간이 지났습니다")
    }

    /// How it works, as a calm numbered list: small muted numerals, no filled circles.
    private var stepList: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, text in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(index + 1)").font(CEFont.meta.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(CE.ink3).frame(width: 12, alignment: .trailing)
                    Text(text).font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
    }

    private func make() async {
        loading = true; failure = nil
        defer { loading = false }
        #if DEBUG
        // Review hook for the read-only sample: `--pairing-sample <seconds left>` draws a made-up QR (no server call),
        // so the code, countdown and expired states can be screenshotted.
        if store.isDemo, let seconds = LaunchOptions.value(after: "--pairing-sample").flatMap(Int.init) {
            let expires = ISO8601DateFormatter().string(from: Date().addingTimeInterval(TimeInterval(seconds)))
            start = PairStart(code: "SAMPLE", expiresAt: expires, ttlSeconds: 300, urls: ["https://sample-mac.tail0000.ts.net"])
            return
        }
        #endif
        if store.isDemo { failure = "샘플 모드에서는 QR을 만들지 않습니다."; return }
        if let result = await store.startPairing() { start = result }
        else { failure = store.errorMessage ?? "서버에 연결된 뒤 다시 시도하세요." }
    }
}
#endif

// MARK: - iPhone: Tailscale check + scan

#if os(iOS)
/// First screen on the phone: make sure Tailscale is on, then scan the Mac's QR (or point the system camera at it).
struct PhonePairingSection: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var tailnetUp = Tailnet.isConnected()
    @State private var scanning = false
    private var canScanInApp: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !tailnetUp {
                InlineNotice(tone: .attention, icon: "network.slash", title: "Tailscale을 켜 주세요",
                             detail: "이 iPhone과 Mac이 같은 Tailscale에 로그인되어 있어야 연결됩니다. Tailscale 앱에서 연결을 켠 뒤 돌아오세요.",
                             actionTitle: "다시 확인") { tailnetUp = Tailnet.isConnected() }
            }
            Text("Mac의 IAMCEO에서 설정 → iPhone 연결을 누르고, 나온 QR을 이 iPhone 카메라로 비추세요.")
                .font(CEFont.secondary).foregroundStyle(CE.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button { scanning = true } label: {
                HStack(spacing: 7) {
                    if store.isPairing { ProgressView().tint(.white) } else { Image(systemName: "qrcode.viewfinder") }
                    Text(store.isPairing ? "연결하는 중" : "QR 스캔")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            }
            .ceProminentButton()
            .controlSize(.large)
            .disabled(store.isPairing || !tailnetUp || !canScanInApp)
            if !canScanInApp {
                Text("이 기기에서는 앱 안 스캔을 쓸 수 없습니다. 기본 카메라 앱으로 QR을 비추면 IAMCEO가 열립니다.")
                    .font(CEFont.meta).foregroundStyle(CE.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { tailnetUp = Tailnet.isConnected() } }
        .sheet(isPresented: $scanning) {
            QRScannerSheet { text in
                scanning = false
                guard let url = URL(string: text), let link = PairingLink(url: url) else {
                    store.errorMessage = "IAMCEO 연결 QR이 아닙니다. Mac의 설정 → iPhone 연결에서 나온 QR을 찍어 주세요."
                    return
                }
                Task { await store.pair(with: link, device: UIDevice.current.name) }
            }
        }
    }
}

/// VisionKit live QR scanner, framed like every other popup (inline title, round close).
struct QRScannerSheet: View {
    let onScan: (String) -> Void
    var body: some View {
        CESheet("QR 스캔", scrolls: false) {
            VStack(spacing: CESpace.m) {
                QRScannerView(onScan: onScan)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(CE.line) }
                Text("Mac 화면의 QR을 비추세요.")
                    .font(CEFont.secondary).foregroundStyle(CE.ink2)
            }
            .padding(.bottom, CESpace.l)
        }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                   recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var done = false
        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                if case .barcode(let code) = item, let text = code.payloadStringValue {
                    done = true
                    dataScanner.stopScanning()
                    onScan(text)
                    return
                }
            }
        }
    }
}
#endif
