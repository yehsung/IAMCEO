# iPhone 연결

[English](iphone.en.md) · [사용자 문서 목록](README.md)

iPhone 앱은 내 Mac의 IAMCEO 서버에 [Tailscale](https://tailscale.com)을 거쳐 붙습니다. 포트를 열거나 중계 서버를 두지 않습니다. IAMCEO가 운영하는 서버도 없습니다.

## 준비

- **iPhone 앱:** [App Store에서 받습니다](https://apps.apple.com/app/id6831782194). iPhone 전용이고 iOS 17 이상입니다. iPad는 지원하지 않습니다.
- **Tailscale:** Mac과 iPhone에 Tailscale을 설치하고 **같은 계정**으로 로그인해 켭니다.
- **MagicDNS:** Tailscale 관리 화면의 DNS 설정에서 MagicDNS가 켜져 있어야 합니다(새로 만든 tailnet은 처음부터 켜져 있습니다). iPhone은 `100.x.x.x` 숫자 주소로 가는 암호화되지 않은 연결을 막기 때문에, 앱은 `<기기 이름>.<tailnet>.ts.net` 이름으로 붙습니다.
- **Mac 서버가 켜져 있어야 합니다.** Mac 앱에서 **이 Mac에서 시작**을 한 번 눌러 두면 Mac을 켤 때마다 서버가 뜹니다.

## 연결하기

1. Mac 앱에서 **설정 → 연결 → iPhone 연결**을 누릅니다. 연결 QR이 나옵니다.
2. iPhone 앱 첫 화면에서 **QR 스캔**을 누르거나, iPhone의 기본 카메라로 QR을 비추고 뜨는 알림을 누릅니다.
3. iPhone 앱이 어느 주소로 연결하는지 보여 줍니다. 내 Mac이 맞으면 확인합니다. 이미 다른 Mac에 연결돼 있으면 바꾸는 것이라고 알려 줍니다.

연결 QR에는 접속 코드가 들어 있지 않습니다. 5분 동안 한 번만 쓸 수 있는 코드만 담고, 그 코드를 쓴 기기에만 접속 코드를 돌려줍니다. 시간이 지나면 **새 QR 만들기**를 누릅니다. Tailscale 주소가 아닌 링크는 열지 않습니다.

QR 대신 주소와 접속 코드를 직접 넣을 수도 있습니다(iPhone 첫 화면의 **주소와 접속 코드를 직접 입력**). 연결 화면 맨 아래의 명령을 복사해 Mac의 터미널에서 실행하면 주소와 접속 코드가 나옵니다. 앱이 그 Mac의 서버가 앱 안에서 도는 것을 알면(전에 연결한 적이 있거나, 같은 Mac의 Mac 앱이면) 명령은 앱 안 경로(`/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo open`)로 나오고, 모를 때는 `iamceo open`으로 나옵니다. `iamceo`를 줄여 쓰는 이름으로 등록해 두지 않았다면 앱 안 경로로 실행합니다 → [시작하기](getting-started.md#명령줄-도구)

## 알림

- **Mac:** 됩니다. Mac 앱의 **설정 → 알림 → Mac 알림**을 켭니다. 새 결재, 승인·선택 대기, 완료·막힘 보고, 대표 할 일을 알립니다.
- **iPhone:** iPhone 알림은 내 Mac의 서버에 **그 iPhone 앱의 Apple 알림 키**가 있을 때만 갑니다. IAMCEO가 운영하는 서버가 없어서 대신 보내 줄 곳이 없습니다. 그래서 App Store에서 받은 iPhone 앱은 **지금 알림을 받을 수 없습니다.** 직접 빌드한 iPhone 앱과 자신의 키가 있을 때만 됩니다 → [네이티브 안내](../../native/README.md#iphone-apns-and-signing)

알림에는 정해진 문구와 식별자만 실리고 대화 내용은 실리지 않습니다. 알림을 눌러도 답·승인·터미널 입력을 대신하지 않습니다.

## 연결되지 않을 때

차례로 확인합니다.

1. **Mac의 Tailscale이 켜져 있나요?** iPhone을 연결해 쓰던 Mac에서 Tailscale이 1분 넘게 꺼져 있으면 Mac 알림과 Mac 앱의 안내 한 줄로 알려 줍니다. 켜면 다시 연결되고 안내는 사라집니다.
2. **iPhone의 Tailscale이 켜져 있나요?** iPhone의 VPN 표시와 Tailscale 앱을 확인합니다.
3. **두 기기가 같은 tailnet에 있나요?** Tailscale 앱의 기기 목록에 서로가 보여야 합니다.
4. **MagicDNS가 켜져 있나요?** 위 '준비'를 보세요.
5. **Mac이 깨어 있나요?** 서버가 도는 동안 Mac의 유휴 잠자기는 막지만, 덮개를 닫거나 직접 잠자기에 들면 iPhone에서 닿지 않습니다.
6. **접속 코드를 바꿨나요?** `iamceo auth rotate`로 코드를 바꾸면 모든 기기가 끊깁니다. 새 QR로 다시 연결합니다.

Mac에서 `iamceo doctor`를 실행하면 Tailscale 항목이 지금 상태를 알려 줍니다 → [문제 해결](troubleshooting.md)

## 여럿이 쓰는 tailnet

회사나 가족이 함께 쓰는 tailnet이라면 다른 사람의 기기도 내 Mac의 서버 포트(기본 7878)에 닿을 수 있습니다. 접속 코드 없이는 쓸 수 없지만, Tailscale의 접근 제어(ACL)로 닿는 범위를 내 기기로 좁히는 편이 안전합니다 → [보안 설명서](../security.md#여럿이-쓰는-tailnet이라면)

## 나가기와 잃어버린 기기

iPhone 설정의 **나가기**는 그 iPhone에 저장된 접속 코드만 지웁니다. 서버의 코드는 그대로입니다. iPhone을 잃어버렸다면 Tailscale에서 그 기기를 빼고 Mac에서 접속 코드를 바꿉니다 → [보안 설명서](../security.md#기기를-잃어버렸을-때)
