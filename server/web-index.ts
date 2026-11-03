// bun 1.3 --compile 은 html 을 직접 동적 import 하면 깨진다(require_web is not defined).
// 정적 import 를 이 모듈에 가두고 http.ts 가 이 모듈을 동적 import 하면 번들에도 들어가고, 파일이 없어도 서버는 뜬다.
import index from "../web/index.html";

export default index;
