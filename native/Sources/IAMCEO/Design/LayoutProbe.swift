import SwiftUI

/// 시험이 실제 화면 부품의 자리를 재는 표시(0.2.7 배포 전 확인 검토: 잘림·빈 공간을 고친 곳을 실제 화면째 지키려고).
/// 시험이 `layoutProbes` 를 켠 때만 자리를 `LayoutProbeFrames` 로 알린다. 앱에서는 꺼져 있어 아무것도 더하지 않는다
/// (배치·그리기 그대로).
struct LayoutProbeFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

extension EnvironmentValues {
    /// 시험 전용. 켜면 `layoutProbe(_:)` 를 단 부품이 창 좌표의 자리를 알린다.
    @Entry var layoutProbes = false
}

private struct LayoutProbe: ViewModifier {
    @Environment(\.layoutProbes) private var enabled
    let id: String

    @ViewBuilder func body(content: Content) -> some View {
        if enabled {
            content.background(GeometryReader { geometry in
                Color.clear.preference(key: LayoutProbeFrames.self, value: [id: geometry.frame(in: .global)])
            })
        } else {
            content
        }
    }
}

extension View {
    /// 시험이 이 부품의 자리를 `id` 로 잴 수 있게 한다(시험이 `layoutProbes` 를 켤 때만).
    func layoutProbe(_ id: String) -> some View { modifier(LayoutProbe(id: id)) }
}
