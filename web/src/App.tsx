// 첫 화면 분기: 접속 코드가 없으면 Setup, 아니면 Shell.
import { useEffect } from "react";
import { AuroraField, GlassDefs } from "./glass";
import Shell from "./components/Shell";
import { useStore } from "./lib/store";
import Setup from "./screens/Setup";

function Root() {
  const auth = useStore((s) => s.auth);
  const error = useStore((s) => s.projectError);
  if (auth === "checking") return <div className="splash">{error ?? "불러오는 중입니다"}</div>;
  if (auth === "need_code") return <Setup />;
  return <Shell />;
}

/** 안 막으면 브라우저가 놓은 파일을 열어 새 탭이 뜨거나 앱을 잃는다. 입력칸이 없는 화면(설정·접속 코드)도 같다. 첨부는 Composer 가 맡는다. */
function useBlockFileOpen(): void {
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
}

export default function App() {
  useBlockFileOpen();
  return (
    <>
      <AuroraField />
      <GlassDefs />
      <Root />
    </>
  );
}
