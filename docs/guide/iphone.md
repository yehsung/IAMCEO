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

연결 QR에는 접속 코드가 들어 있지 않습니다. 5분 동안 한 번만 쓸 수 있는 코드만 담고, 그 코드를 쓴 기기에만 **그 기기만의 열쇠**를 돌려줍니다. 시간이 지나면 **새 QR 만들기**를 누릅니다. Tailscale 주소가 아닌 링크는 열지 않습니다.

## 연결된 기기

**설정 → 연결 → 연결된 기기**에서 서버에 붙은 기기를 봅니다. Mac 앱과 iPhone 앱에서 같습니다.

- QR로 연결한 기기는 한 줄씩 보입니다. 기기 이름, 마지막 접속, 연결한 때가 나오고, 지금 쓰는 기기에는 **이 기기**가 붙습니다. **끊기**를 누르면 그 기기만 바로 끊기고 다른 기기는 그대로입니다. 끊은 기기를 다시 쓰려면 새 QR로 연결합니다.
- **공용 접속 코드** 줄은 이 Mac의 앱, 코드를 손으로 넣은 기기, 그리고 기기별 열쇠가 생기기 전에 QR로 연결한 iPhone입니다. 이 줄은 한 대씩 끊을 수 없고, Mac에서 접속 코드를 바꾸면 끊깁니다. 예전에 연결한 iPhone도 새 QR로 한 번 다시 연결하면 따로 끊을 수 있는 줄로 옮겨 갑니다.
- **최근 실패한 시도**는 지난 7일 동안 틀린 코드나 끊은 기기로 들어오려 한 횟수입니다. 기록에는 주소와 시각만 남고 코드는 남지 않습니다.

QR 대신 주소와 접속 코드를 직접 넣을 수도 있습니다(iPhone 첫 화면의 **주소와 접속 코드를 직접 입력**). 연결 화면 맨 아래의 명령을 복사해 Mac의 터미널에서 실행하면 주소와 접속 코드가 나옵니다. 앱이 그 Mac의 서버가 앱 안에서 도는 것을 알면(전에 연결한 적이 있거나, 같은 Mac의 Mac 앱이면) 명령은 앱 안 경로(`/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo open`)로 나오고, 모를 때는 `iamceo open`으로 나옵니다. `iamceo`를 줄여 쓰는 이름으로 등록해 두지 않았다면 앱 안 경로로 실행합니다 → [시작하기](getting-started.md#명령줄-도구)

## HTTPS 주소(선택)

iPhone과 Mac 사이는 기본으로 Tailscale이 암호화하고, 앱은 그 위에서 보통 주소(`http://<기기 이름>.<tailnet>.ts.net:7878`)로 붙습니다. 원하면 앱의 연결도 따로 암호화되는 HTTPS 주소를 쓸 수 있습니다.

- **켜기:** Mac 앱의 **설정 → 연결 → iPhone 연결** 아래 **HTTPS 주소**의 **켜기**를 누르고 확인합니다. 서버가 이 Mac의 Tailscale에서 `tailscale serve`로 HTTPS(443)를 열어 IAMCEO 서버로 넘깁니다. 같은 Tailscale 망의 기기만 닿고 인터넷에는 열리지 않습니다. 처음에는 인증서를 받느라 1분쯤 걸릴 수 있습니다. 서버가 스스로 켜지는 않습니다(내 Tailscale 설정을 바꾸는 일이라서).
- **켠 뒤:** 새로 만드는 연결 QR의 맨 앞 주소가 `https://<기기 이름>.<tailnet>.ts.net`이 되어, 새로 연결하는 iPhone은 HTTPS로 붙습니다. 출시된 iPhone 앱(0.2.2·0.2.3)도 그대로 따라옵니다. 이미 연결한 iPhone은 끊기지 않고 지금 주소를 계속 쓰며, 새 QR로 한 번 다시 연결하면 HTTPS로 옮겨 갑니다.
- **켤 수 없다고 나오면:** 안내를 따릅니다. 가장 흔한 것은 tailnet의 HTTPS 인증서가 꺼져 있는 경우입니다. [Tailscale 관리 화면의 DNS 설정](https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켠 뒤 다시 누릅니다(줄의 **Tailscale 관리 화면** 단추가 그 화면을 엽니다). 이 Mac의 HTTPS(443)를 다른 설정이 이미 쓰고 있으면 그 설정을 건드리지 않고 켜지 않습니다.
- **끄기:** 같은 자리의 **끄기**를 누릅니다. 서버가 만든 Tailscale 설정만 지웁니다. HTTPS 주소로 연결한 iPhone은 끊기므로 새 QR로 다시 연결합니다.
- 켜고 끄기는 서버가 도는 Mac의 앱에서만 됩니다.

**iPhone의 Tailscale이 꺼져 있으면 보내지 않습니다(다음 iPhone 앱부터).** 보통 주소의 연결은 Tailscale이 켜져 있어야만 암호화됩니다. 그래서 iPhone 앱은 보통 주소로 요청을 보내기 전에 그 iPhone의 Tailscale이 켜져 있는지 봅니다(Tailscale 연결에 붙는 tailnet 주소로 봅니다. 통신사나 다른 VPN이 주는 100.x 주소만으로는 켜진 것으로 보지 않습니다). 꺼져 있으면 보내지 않고 "이 iPhone의 Tailscale이 꺼져 있어 보내지 않았습니다"라고 알립니다. Tailscale을 켜면 알아서 다시 연결합니다. HTTPS 주소로 연결한 iPhone은 HTTPS가 지키므로 이 확인과 상관없습니다.

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
6. **접속 코드를 바꿨거나 이 기기를 끊었나요?** `iamceo auth rotate`로 코드를 바꾸면 공용 접속 코드로 붙은 기기가 끊깁니다. 다른 기기의 '연결된 기기'에서 이 기기를 끊었어도 끊깁니다. 새 QR로 다시 연결합니다.

Mac에서 `iamceo doctor`를 실행하면 Tailscale 항목이 지금 상태를 알려 줍니다 → [문제 해결](troubleshooting.md)

## 여럿이 쓰는 tailnet

회사나 가족이 함께 쓰는 tailnet이라면 다른 사람의 기기도 내 Mac의 서버 포트(기본 7878)에 닿을 수 있습니다. 접속 코드 없이는 쓸 수 없지만, Tailscale의 접근 제어(ACL)로 닿는 범위를 내 기기로 좁히는 편이 안전합니다 → [보안 설명서](../security.md#여럿이-쓰는-tailnet이라면)

## 나가기와 잃어버린 기기

iPhone 설정의 **나가기**는 그 iPhone에 저장된 접속 코드만 지웁니다. 서버의 코드와 열쇠는 그대로입니다. iPhone을 잃어버렸다면 Tailscale에서 그 기기를 빼고, Mac 앱의 **연결된 기기**에서 그 iPhone을 **끊기** 합니다. 목록에서 어느 줄인지 모르겠으면 Mac에서 `iamceo auth revoke-devices`로 QR로 연결한 기기를 모두 끊고 쓸 기기만 새 QR로 다시 연결합니다. 목록에 따로 없고 공용 접속 코드로 붙어 있던 iPhone이면 Mac에서 접속 코드를 바꿉니다 → [보안 설명서](../security.md#기기를-잃어버렸을-때)
