import Foundation

/// 샘플 작업 공간의 첫 화면(결제 페이지 개편)을 앱의 모델로 읽는다. 시험과 화면 견본이 쓴다.
/// 샘플 모드 자체는 이것을 쓰지 않는다: 가짜 서버(SampleServer)가 같은 자료로 답하고, 앱은 실제 연결과 같은 길로 읽는다.
/// 자료는 서버 시험(tests/sample-workspace.test.ts)이 실제 서버 응답으로 만든 SampleWorkspaceData 다.
enum DemoFixtures {
    /// 언어(W)는 앱 화면 언어를 따른다(시험은 늘 한국어 원문을 보므로 한국어 벌).
    static func workspace(now: Date = Date(), language: AppLanguage = .current) -> (Bootstrap, ProjectState) {
        do { return try SampleWorkspace.decoded(now: now, language: language) }
        catch { preconditionFailure("샘플 자료를 앱 모델로 읽지 못했습니다: \(error)") }
    }
}
