// 화면 점검: 가로 넘침·가림과 실제 바탕 위 글 대비(tests/e2e-fake.browser.ts 와 같은 방식).
import type { Page } from "playwright";

export async function auditLayout(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = window.innerWidth;
    const root = document.scrollingElement!;
    if (root.scrollWidth > vw + 1) problems.push(`문서 가로 넘침 ${root.scrollWidth}>${vw}`);

    const scroller = document.querySelector<HTMLElement>("[data-scroll-root]");
    if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) problems.push(`본문 가로 넘침 ${scroller.scrollWidth}>${scroller.clientWidth}`);

    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.hasAttribute("data-scroll-root")) return false;
        const { overflowX } = getComputedStyle(p);
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("button, a, input, textarea, h1, h2, h3, p, li, code, pre")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
        problems.push(`화면 밖: <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> ${Math.round(r.left)}~${Math.round(r.right)} "${(el.textContent ?? "").trim().slice(0, 24)}"`);
      }
    }

    const top = document.querySelector(".shell__top");
    const bottom = document.querySelector(".shell__bottom");
    const column = scroller?.querySelector(".shell__column");
    const hasOverlay = document.querySelector("dialog[open], [role='dialog']") !== null;
    if (scroller && column && top && bottom && !hasOverlay) {
      const saved = scroller.scrollTop;
      const kids = [...column.querySelectorAll(":scope > * > *, :scope > *")].filter((k) => k.getBoundingClientRect().height > 0);
      scroller.scrollTop = 0;
      const firstTop = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
      const topEdge = [...top.children].reduce((edge, c) => (getComputedStyle(c).pointerEvents === "none" ? edge : Math.max(edge, c.getBoundingClientRect().bottom)), 0);
      if (kids.length > 0 && firstTop < topEdge - 1) problems.push(`맨 위 내용이 위 틀에 가림 ${Math.round(firstTop)}<${Math.round(topEdge)}`);
      scroller.scrollTop = scroller.scrollHeight;
      const lastBottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
      const bottomEdge = bottom.getBoundingClientRect().top;
      if (kids.length > 0 && bottom.getBoundingClientRect().height > 0 && lastBottom > bottomEdge + 1) problems.push(`맨 아래 내용이 입력칸에 가림 ${Math.round(lastBottom)}>${Math.round(bottomEdge)}`);
      scroller.scrollTop = saved;
    }
    return problems;
  });
}

/** 글자색과 그 자리 실제 바탕(글자를 지우고 찍은 화면)의 대비. 유리·빛이 있어 계산으로는 알 수 없다. */
export async function auditContrast(page: Page): Promise<string[]> {
  // 글자를 지우기 전에 읽는다. 지운 뒤에는 color 전환이 끝날 때까지 값이 흔들린다.
  const items = await page.evaluate(() => {
    const topEdge = document.querySelector(".shell__top")?.getBoundingClientRect().bottom ?? 0;
    const bottomEdge = document.querySelector(".shell__bottom")?.getBoundingClientRect().top ?? window.innerHeight;
    const found: { x: number; y: number; w: number; h: number; color: string; alpha: number; large: boolean; label: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || el.closest(".sr-only, [aria-hidden='true'], script, style")) continue;
      if (el.closest("[disabled], [aria-disabled='true'], [data-off]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      // 말줄임으로 잘린 글의 범위는 상자 밖까지 뻗는다.
      const box = getComputedStyle(el).overflowX === "visible" ? r : el.getBoundingClientRect();
      const x = Math.max(0, r.left, box.left);
      const y = Math.max(0, r.top, box.top);
      const w = Math.min(window.innerWidth, r.right, box.right) - x;
      const h = Math.min(window.innerHeight, r.bottom, box.bottom) - y;
      if (w < 1 || h < 1) continue;
      // 위 틀·입력칸의 띠 밑으로 지나가는 중이거나 덮개에 가린 글은 일부러 안 보이게 한 글이다.
      if (el.closest("[data-scroll-root]") && (y < topEdge + 40 || y + h > bottomEdge - 30)) continue;
      const top = document.elementFromPoint(x + w / 2, y + h / 2);
      if (!top || !(el === top || el.contains(top) || top.contains(el))) continue;
      const style = getComputedStyle(el);
      let alpha = 1;
      for (let p: Element | null = el; p; p = p.parentElement) alpha *= Number(getComputedStyle(p).opacity);
      if (alpha < 0.05 || style.visibility !== "visible") continue;
      const size = Number.parseFloat(style.fontSize);
      found.push({ x, y, w, h, color: style.color, alpha, large: size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700), label: `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> "${text.slice(0, 20)}"` });
    }
    return found;
  });
  const style = await page.addStyleTag({ content: "* { color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; transition:none !important; caret-color:transparent !important; } ::placeholder { color:transparent !important; } img, svg { visibility:hidden !important; }" });
  const bare = (await page.screenshot()).toString("base64");
  await style.evaluate((el) => (el as HTMLElement).remove());
  return page.evaluate(
    async ({ png, items }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const scale = image.width / window.innerWidth;
      const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);

      const problems = new Set<string>();
      for (const item of items) {
        const match = /rgba?\(([^)]+)\)/.exec(item.color);
        if (!match) continue;
        const parts = match[1]!.split(/[ ,/]+/).map(Number);
        const alpha = (parts[3] ?? 1) * item.alpha;
        const data = ctx.getImageData(Math.round(item.x * scale), Math.round(item.y * scale), Math.max(1, Math.round(item.w * scale)), Math.max(1, Math.round(item.h * scale))).data;
        let worst = 21;
        for (let i = 0; i < data.length; i += 4 * 9) {
          const bg = [data[i]!, data[i + 1]!, data[i + 2]!];
          const fg = [0, 1, 2].map((c) => parts[c]! * alpha + bg[c]! * (1 - alpha));
          const [a, b] = [luminance(fg), luminance(bg)];
          worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
        }
        if (worst < (item.large ? 3 : 4.5)) problems.add(`대비 ${worst.toFixed(2)} ${item.label}`);
      }
      return [...problems];
    },
    { png: bare, items },
  );
}
