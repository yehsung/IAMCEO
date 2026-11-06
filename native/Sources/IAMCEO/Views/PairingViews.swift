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
    @Environment(\.dismiss) private var dismiss
    @State private var start: PairStart?
    @State private var loading = false
    @State private var failure: String?

    private var link: PairingLink? {
        guard let start else { return nil }
        let urls = start.urls.compactMap { (try? ServerEndpoint($0))?.url }
        return urls.isEmpty ? nil : PairingLink(code: start.code, urls: urls)
    }
    private var expiry: Date? { parseISODate(start?.expiresAt) }

    var body: some View {
        VStack(spacing: 18) {
            HStack {
                Text("iPhone 연결").font(CEFont.title).foregroundStyle(CE.ink)
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 26, height: 26).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(CE.ink3)
                    .keyboardShortcut(.cancelAction)
                    .help("닫기").accessibilityLabel("닫기")
            }
            content
            VStack(alignment: .leading, spacing: 6) {
                step(1, "iPhone과 이 Mac 모두 Tailscale을 켭니다.")
                step(2, "iPhone 카메라로 QR을 비추고 뜨는 알림을 누릅니다.")
                step(3, "IAMCEO 앱이 열리며 바로 연결됩니다.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
        .frame(width: 400)
        .background { AmbientBackground() }
        .task { await make() }
    }

    @ViewBuilder private var content: some View {
        if loading && start == nil {
            ProgressView().frame(width: 220, height: 220)
        } else if let failure {
            InlineNotice(tone: .danger, title: "QR을 만들지 못했습니다", detail: failure, actionTitle: "다시 시도") { Task { await make() } }
        } else if start != nil, link == nil {
            InlineNotice(tone: .attention, icon: "network.slash", title: "이 Mac의 Tailscale이 꺼져 있습니다",
                         detail: "iPhone이 닿을 Tailscale 주소가 없습니다. 이 Mac에서 Tailscale을 켠 뒤 다시 만드세요.",
                         actionTitle: "다시 만들기") { Task { await make() } }
        } else if let link, let expiry {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = Int(expiry.timeIntervalSince(context.date).rounded(.down))
                VStack(spacing: 10) {
                    QRCodeImage(text: link.url.absoluteString)
                        .frame(width: 220, height: 220)
                        .padding(14)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .opacity(left > 0 ? 1 : 0.15)
                        .accessibilityLabel("iPhone 연결 QR 코드")
                    if left > 0 {
                        Text("\(left / 60):\(String(format: "%02d", left % 60)) 동안 한 번 쓸 수 있습니다")
                            .font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
                    } else {
                        Button("새 QR 만들기") { Task { await make() } }.ceProminentButton()
                    }
                    Text(link.urls.map { $0.host ?? "" }.joined(separator: " · "))
                        .font(CEFont.mono).foregroundStyle(CE.ink3).textSelection(.enabled)
                }
            }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n)").font(CEFont.micro).foregroundStyle(.white)
                .frame(width: 18, height: 18).background(CE.accentFill, in: Circle())
            Text(text).font(CEFont.secondary).foregroundStyle(CE.ink2)
        }
    }

    private func make() async {
        loading = true; failure = nil
        defer { loading = false }
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

/// VisionKit live QR scanner.
struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onScan: (String) -> Void
    var body: some View {
        NavigationStack {
            QRScannerView(onScan: onScan)
                .ignoresSafeArea()
                .navigationTitle("QR 스캔")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
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
