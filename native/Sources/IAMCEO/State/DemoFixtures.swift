import Foundation

/// 샘플 작업 공간의 첫 화면(결제 페이지 개편)을 앱의 모델로 읽는다. 시험과 화면 견본이 쓴다.
/// 샘플 모드 자체는 이것을 쓰지 않는다: 가짜 서버(SampleServer)가 같은 자료로 답하고, 앱은 실제 연결과 같은 길로 읽는다.
/// 자료는 서버 시험(tests/sample-workspace.test.ts)이 실제 서버 응답으로 만든 SampleWorkspaceData 다.
enum DemoFixtures {
    static func workspace(now: Date = Date()) -> (Bootstrap, ProjectState) {
        do { return try SampleWorkspace.decoded(now: now) }
        catch { preconditionFailure("샘플 자료를 앱 모델로 읽지 못했습니다: \(error)") }
    }
}
