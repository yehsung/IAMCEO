// 0.2.7 묶음 4: 결재·할 일·자료 고치기와 결재 답 첨부(점검 D3-4·D3-5·D3-7·D3-9·D1-5·D5-7·D5-10).
// 견본 글은 같은 모양의 가짜 글이다(대표의 실제 대화·보고 본문은 넣지 않는다).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentTool, needsNoteOf } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb, REVISION_COLUMNS } from "../server/db.ts";
import { formatAnswer, formatTodoDone } from "../server/delivery-text.ts";
import { exportProjectZip } from "../server/lifecycle/project-data.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { stripControls } from "../server/text.ts";
import type { Attachment, Backend, Decision, FileDoc, Member, Todo } from "../shared/types.ts";
import { rejection } from "./fixtures/settle.ts";

const DAY = 86_400_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** 세션을 띄우지 않고 받은 글만 적는다(운영과 같은 core 종류, 끼워 넣기 없음). */
class QuietRunner implements Runner {
  readonly kind: Backend = "core";
  readonly interjects = false;
  sent: { memberId: string; text: string }[] = [];
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(member: { id: string }, text: string): Promise<SendResult> { this.sent.push({ memberId: member.id, text }); return { ok: true }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  async shutdown() {}
  on(_listener: (event: RunnerEvent) => void) {}
}

async function setup() {
  if (!process.env.IAMCEO_TEST || !process.env.IAMCEO_HOME) throw new Error("Use bun run test:server");
  const home = mkdtempSync(join(process.env.IAMCEO_HOME, "w7-4-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env), bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus), runner = new QuietRunner();
  const notices: string[] = [];
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]), notifier: (title: string) => { notices.push(title); } });
  const server = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => { await orch.shutdown(); await server.stop(); });
  const project = store.createProject({ name: "w7-4", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  await orch.pump(lead.id);
  const worker = store.createMember({ projectId: project.id, handle: "design", name: "화면 설계", kind: "worker", backend: "core" });
  const other = store.createMember({ projectId: project.id, handle: "copy", name: "글 다듬기", kind: "worker", backend: "core" });
  const auth = { Authorization: "Bearer code" };
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const get = (path: string) => fetch(`${url}${path}`, { headers: auth, signal: AbortSignal.timeout(5000) });
  const upload = async (name: string, bytes = "가짜 캡처"): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type: name.endsWith(".png") ? "image/png" : "text/plain" }));
    const response = await fetch(`${url}/api/uploads`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    return await response.json() as Attachment;
  };
  const tool = async (member: Member, name: string, args: Record<string, unknown>) => handleAgentTool(orch, store.requireMember(member.id), name, args);
  const ask = async (member: Member, args: Record<string, unknown>): Promise<{ decision: Decision; text: string }> => {
    const result = await tool(member, "ask", { title: "가짜 질문", detail: "가짜 배경", ...args });
    expect(result.isError).toBeFalsy();
    const id = /#(d_[A-Za-z0-9]+)/.exec(result.text)![1]!;
    return { decision: store.requireDecision(id), text: result.text };
  };
  const answerTexts = (decisionId: string) => store.listDeliveries().filter(d => d.refType === "decision" && d.refId === decisionId).map(d => d.text);
  return { home, config, store, runner, orch, project, lead, worker, other, post, get, upload, tool, ask, answerTexts, notices };
}
type T = Awaited<ReturnType<typeof setup>>;

test("서버 기능 알림이 결재 답 첨부·할 일 닫기 결과를 받는다고 알린다(새 앱은 이 값이 있을 때만 그 단추를 보인다)", async () => {
  const t = await setup();
  expect(await (await t.get("/api/capabilities")).json()).toMatchObject({ contractVersion: 2, capabilities: { revisions: true } });
});

describe("D3-4 결재 답 첨부", () => {
  test("답에 붙인 첨부가 결재에 남고, 물은 팀장의 전달 글에 할 일 완료처럼 실린다(그 팀장 폴더의 경로). 총괄 사본에는 첨부 id 가 있다", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, { options: [{ k: "a", label: "이대로" }, { k: "b", label: "고쳐서" }] });
    const shot = await t.upload("캡처.png");
    const response = await t.post(`/api/decisions/${decision.id}/answer`, { choice: "b", note: "그림에 표시한 곳", fileIds: [shot.id, shot.id] });
    expect(response.status).toBe(200);
    const answered = await response.json() as Decision;
    expect(answered.answerAttachments?.map(a => a.id)).toEqual([shot.id]);
    const [toWorker, toLead] = [t.store.listDeliveries().find(d => d.memberId === t.worker.id && d.refId === decision.id)!, t.store.listDeliveries().find(d => d.memberId === t.lead.id && d.text.includes(decision.id) && d.text.includes("결재에 답했습니다"))!];
    expect(toWorker.kind).toBe("answer");
    const lines = toWorker.text.split("\n");
    expect(lines[0]).toBe(formatAnswer({ ...answered, answerAttachments: undefined }));
    expect(lines[1]).toBe(`대표가 올린 첨부: ${shot.id}`);
    const linked = join(t.config.home, "inbox", t.worker.id, `${shot.id}-캡처.png`);
    expect(lines[2]).toStartWith(`첨부: ${linked} (image/png,`);
    expect(existsSync(linked)).toBe(true);
    expect(toLead.text).toContain(`대표가 올린 첨부: ${shot.id}`);
    // 같은 답의 재전송은 같은 결과, 첨부가 다르면 409.
    expect((await t.post(`/api/decisions/${decision.id}/answer`, { choice: "b", note: "그림에 표시한 곳", fileIds: [shot.id] })).status).toBe(200);
    const other = await t.upload("다른.png");
    expect((await t.post(`/api/decisions/${decision.id}/answer`, { choice: "b", note: "그림에 표시한 곳", fileIds: [other.id] })).status).toBe(409);
    expect(t.answerTexts(decision.id)).toHaveLength(1);
  });

  test("'추천대로' 묶음 답(batch)도 카드에 붙인 첨부를 싣는다(앱의 묶음 결정이 첨부를 빼지 않게)", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, { options: [{ k: "a", label: "이대로" }, { k: "b", label: "고쳐서" }], rec: "a", group: "가짜 묶음" });
    const shot = await t.upload("묶음.png");
    const response = await t.post(`/api/decisions/${decision.id}/answer`, { batch: true, note: "그림 참고", fileIds: [shot.id], expectedVersion: decision.updatedAt }, { "X-IAMCEO-Contract": "2" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choice: "a", batch: true, note: "그림 참고", answerAttachments: [{ id: shot.id }] });
    expect(t.answerTexts(decision.id)[0]).toContain(`대표가 올린 첨부: ${shot.id}`);
  });

  test("첨부 없는 답(출시 앱)은 전달 글·응답이 예전과 같다. 모르는 첨부는 400, 계약 2 의 엄격한 몸도 fileIds 를 받는다", async () => {
    const t = await setup();
    const plain = (await ask(t, t.worker, { options: [{ k: "a", label: "이대로" }] })).decision;
    const response = await t.post(`/api/decisions/${plain.id}/answer`, { choice: "a" });
    const answered = await response.json() as Decision;
    expect("answerAttachments" in answered).toBe(false);
    expect(t.answerTexts(plain.id)).toEqual([formatAnswer(answered)]);
    expect(formatAnswer(answered)).not.toContain("\n");

    const second = (await ask(t, t.worker, {})).decision;
    const missing = await t.post(`/api/decisions/${second.id}/answer`, { note: "가짜 답", fileIds: ["a_nope"] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "upload_not_found" });
    const shot = await t.upload("메모.txt");
    const v2 = await t.post(`/api/decisions/${second.id}/answer`, { note: "가짜 답", fileIds: [shot.id], expectedVersion: second.updatedAt }, { "X-IAMCEO-Contract": "2" });
    expect(v2.status).toBe(200);
    expect((await v2.json() as Decision).answerAttachments?.map(a => a.id)).toEqual([shot.id]);
  });

  test("다시 열리면 앞 답의 첨부는 직전 답(lastAnswerAttachments)으로 남고 새 답이 오면 지운다. 도구 승인 카드의 답에는 첨부를 붙일 수 없다", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, {});
    expect("lastAnswerAttachments" in decision).toBe(false);
    const shot = await t.upload("a.png");
    t.store.answerDecision(decision.id, { note: "가짜 답", fileIds: [shot.id] });
    expect(t.store.requireDecision(decision.id).answerAttachments).toHaveLength(1);
    // 전달하지 못해 서버가 다시 연 카드(연결 전 보류·전달 중지): 직전 선택·메모처럼 첨부도 남는다.
    t.store.reopenDecision(decision.id);
    expect(t.store.requireDecision(decision.id)).toMatchObject({ status: "open", lastNote: "가짜 답", lastAnswerAttachments: [{ id: shot.id }] });
    expect(t.store.requireDecision(decision.id).answerAttachments).toBeUndefined();
    // 대표가 그대로 다시 보낸 답(앱이 직전 첨부를 초안으로 채운다)에는 첨부가 다시 실리고, 직전 답은 지워진다.
    const again = await t.post(`/api/decisions/${decision.id}/answer`, { note: "가짜 답", fileIds: [shot.id] });
    expect(again.status).toBe(200);
    const answered = await again.json() as Decision;
    expect(answered.answerAttachments?.map(a => a.id)).toEqual([shot.id]);
    expect("lastAnswerAttachments" in answered).toBe(false);
    expect(t.answerTexts(decision.id).at(-1)).toContain(`대표가 올린 첨부: ${shot.id}`);
    // 첨부 없는 답 뒤에 다시 열려도 앞의 직전 첨부를 지우지 않는다(COALESCE, 직전 메모와 같다).
    t.store.reopenDecision(decision.id);
    t.store.answerDecision(decision.id, { note: "첨부 없이" });
    expect("lastAnswerAttachments" in t.store.requireDecision(decision.id)).toBe(false);
    const card = t.store.createToolPermissionDecision({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "명령 실행", options: [{ k: "allow", label: "허용" }, { k: "deny", label: "거절" }],
      toolPermission: { tool: "Bash", action: "명령 실행", target: "ls", cwd: null, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const refused = await t.post(`/api/decisions/${card.id}/answer`, { choice: "allow", fileIds: [shot.id] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "decision_attachment_unsupported" });
  });
});

describe("D3-4 결재 답 첨부의 보관", () => {
  test("프로젝트 내보내기와 보관 프로젝트 지우기가 결재 답 첨부와 다시 열린 카드의 직전 답 첨부를 센다", async () => {
    const t = await setup();
    const kept = t.store.createProject({ name: "보관할 곳", cwd: t.home, runnerEnabled: false });
    const asker = t.store.createMember({ projectId: kept.id, handle: "ops", name: "운영 정리", kind: "worker" });
    const make = () => t.store.createDecision({ projectId: kept.id, memberId: asker.id, who: asker.name, title: "가짜 질문" });
    const [answered, reopened] = [make(), make()];
    const [a, b] = [await t.upload("답.png"), await t.upload("직전.png")];
    t.store.answerDecision(answered.id, { note: "가짜 답", fileIds: [a.id] });
    t.store.answerDecision(reopened.id, { note: "가짜 답", fileIds: [b.id] });
    t.store.reopenDecision(reopened.id);
    const exported = await exportProjectZip(t.store, t.config, kept.id);
    const zip = join(t.home, "kept.zip");
    writeFileSync(zip, Buffer.from(await new Response(exported.stream).arrayBuffer()));
    const unzipped = Bun.spawnSync(["/usr/bin/unzip", "-p", zip, "manifest.json"], { stdout: "pipe", stderr: "pipe" });
    const manifest = JSON.parse(unzipped.stdout.toString()) as { attachments: { id: string }[]; missingAttachments: string[] };
    expect(manifest.attachments.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(manifest.missingAttachments).toEqual([]);
    t.store.patchProject(kept.id, { archived: true });
    expect(t.store.deleteArchivedProject(kept.id).attachments.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(t.store.getAttachment(a.id)).toBeNull();
  });
});

describe("D3-7 메모가 있어야 하는 선택지", () => {
  test("버튼 글에 '메모'가 들면 needsNote 를 켜고(부정은 빼고), ask 의 needs_note 가 우선한다. 보통 선택지의 모양은 그대로다", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, { options: [
      { k: "memo", label: "바꿀 부분을 메모에 적어 둘게" },
      { k: "go", label: "이대로 진행" },
      { k: "plain", label: "메모 없이 진행" },
      { k: "off", label: "메모 참고만", needs_note: false },
      { k: "on", label: "직접 적을게", needs_note: true },
    ] });
    expect(decision.options).toEqual([
      { k: "memo", label: "바꿀 부분을 메모에 적어 둘게", needsNote: true },
      { k: "go", label: "이대로 진행" },
      { k: "plain", label: "메모 없이 진행" },
      { k: "off", label: "메모 참고만" },
      { k: "on", label: "직접 적을게", needsNote: true },
    ]);
    // 켜는 꼴: 대표가 메모에 무엇을 적는다는 버튼 글.
    const on = ["메모에 적음", "바뀐 점은 메모로 남겨 둘게", "직접 입력(메모)", "메모 참고", "메모", "메모에 쓴 대로 해 줘", "See my note", "I wrote it in the notes", "Details in the note"];
    expect(on.filter(label => !needsNoteOf({ label }))).toEqual([]);
    // 끄는 꼴: 메모가 필요 없다는 글, 앞 메모를 가리키는 글, 다른 뜻의 notes(잘못 켜면 출시 앱의 답이 400 으로 막힌다).
    const off = ["메모는 필요 없어요", "메모는 안 써도 돼", "앞 메모 그대로 진행", "메모대로 진행", "릴리스 notes 확인 뒤 배포", "메모를 안 남김",
      "Go ahead without a note", "No note needed", "Check the release notes, then ship", "진행", "메모 필요 없음"];
    expect(off.filter(label => needsNoteOf({ label }))).toEqual([]);
  });

  test("그 선택지에 메모가 비면(공백·제어문자뿐이어도) 400 decision_note_required, 메모가 있으면 답이 된다", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, { options: [{ k: "memo", label: "메모에 적음" }, { k: "go", label: "진행" }] });
    for (const note of [undefined, "  ", "\b\u0007"]) {
      const response = await t.post(`/api/decisions/${decision.id}/answer`, { choice: "memo", ...(note === undefined ? {} : { note }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "decision_note_required" });
    }
    expect(t.store.requireDecision(decision.id).status).toBe("open");
    const ok = await t.post(`/api/decisions/${decision.id}/answer`, { choice: "memo", note: "1. 제목 2. 여백" });
    expect(ok.status).toBe(200);
    expect(t.answerTexts(decision.id)[0]).toContain(`메모 "1. 제목 2. 여백"`);
  });

  test("메모 대신 첨부만 붙여도 답이 된다(그림에 표시한 답. 출시 앱은 첨부를 못 달아 예전처럼 메모가 있어야 한다)", async () => {
    const t = await setup();
    const { decision } = await ask(t, t.worker, { options: [{ k: "mark", label: "그림에 표시했어", needs_note: true }, { k: "go", label: "진행" }] });
    expect(decision.options[0]).toMatchObject({ needsNote: true });
    const shot = await t.upload("표시.png");
    const response = await t.post(`/api/decisions/${decision.id}/answer`, { choice: "mark", fileIds: [shot.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choice: "mark", note: null, answerAttachments: [{ id: shot.id }] });
    expect(t.answerTexts(decision.id)[0]).toContain(`대표가 올린 첨부: ${shot.id}`);
  });
});

describe("D3-5 결재 카드 대체(ask replaces)", () => {
  test("새 카드가 앞 카드를 같은 거래에서 닫고(대체됨) 서로 잇는다. 총괄 안내·도구 답이 그 사실을 말하고, 대표는 옛 카드에 답할 수 없다", async () => {
    const t = await setup();
    const first = (await ask(t, t.worker, { title: "아이디어를 고를까요?" })).decision;
    const { decision: next, text } = await ask(t, t.worker, { title: "아이디어를 고를까요?(고친 판)", replaces: first.id });
    const old = t.store.requireDecision(first.id);
    expect(old).toMatchObject({ status: "closed", closeKind: "obsolete", closedBy: t.worker.name, replacedBy: next.id, closeReason: `새 카드(#${next.id})로 대신했습니다` });
    expect(old.closeReasonText).toEqual({ code: "card.replaced", params: { id: next.id } });
    expect(next).toMatchObject({ status: "open", replaces: first.id });
    expect(text).toContain(`앞 카드 #${first.id} 는 닫고 이 카드에 이었습니다`);
    expect(t.store.listOpenDecisions(t.project.id).map(d => d.id)).toEqual([next.id]);
    expect(t.store.requireMember(t.worker.id).status).toBe("waiting");
    const toLead = t.store.listPending(t.lead.id).map(d => d.text).find(text => text.includes(`#${next.id}`))!;
    expect(toLead).toContain(`앞 카드 #${first.id} 를 대신합니다`);
    expect((await t.post(`/api/decisions/${first.id}/answer`, { note: "옛 카드에 답" })).status).toBe(409);
    // 대표가 다시 열 수 있다(AI 가 닫은 카드).
    expect((await t.post(`/api/decisions/${first.id}/reopen`)).status).toBe(200);
  });

  test("남의 카드·닫힌 카드·답한 카드·서버가 연 카드는 대신하지 못하고, 아무것도 만들지 않는다", async () => {
    const t = await setup();
    const mine = (await ask(t, t.worker, {})).decision;
    const theirs = (await ask(t, t.other, {})).decision;
    const before = t.store.listDecisions(t.project.id).length;
    // 도구 답은 글만 돌려주므로, 같은 요청을 registerAsk 로 직접 불러 거절 코드까지 맞춰 본다.
    const refused = async (replaces: string, code: string) => {
      const result = await t.tool(t.worker, "ask", { title: "가짜", detail: "가짜", replaces });
      expect(result.isError).toBe(true);
      expect(await rejection(t.orch.registerAsk(t.store.requireMember(t.worker.id), { title: "가짜", detail: "가짜", replaces }))).toMatchObject({ code });
    };
    await refused(theirs.id, "decision_not_own");
    await refused("d_nope", "decision_not_found");
    t.store.answerDecision(mine.id, { note: "답" });
    await refused(mine.id, "decision_closed");
    const card = t.store.createToolPermissionDecision({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "명령 실행", options: [{ k: "allow", label: "허용" }],
      toolPermission: { tool: "Bash", action: "명령 실행", target: "ls", cwd: null, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await refused(card.id, "decision_not_own");
    expect(t.store.listDecisions(t.project.id)).toHaveLength(before + 1);
    expect(t.store.requireDecision(theirs.id).status).toBe("open");
  });

  test("detail 이 자기의 열린 카드를 대신한다고 쓰고 replaces 가 없으면, 그 카드가 열린 채라고 도구 답으로 알린다", async () => {
    const t = await setup();
    const first = (await ask(t, t.worker, {})).decision;
    const { text } = await ask(t, t.worker, { detail: `고친 질문입니다. #${first.id} 를 대신합니다` });
    expect(text).toContain(`#${first.id} 는 아직 열려 있습니다`);
    expect(text).toContain("replaces");
    const quiet = await ask(t, t.worker, { detail: `#${first.id} 와 같이 봐 주세요` });
    expect(quiet.text).not.toContain("아직 열려 있습니다");
  });
});

describe("D3-5 할 일 고치기(todo_update)", () => {
  test("열린 할 일의 제목·내용을 그 자리에서 고친다. 새 할 일·새 알림이 없고 판(revision)은 그대로다", async () => {
    const t = await setup();
    const made = await t.tool(t.worker, "todo", { title: "접수 메일 보내기(1판)", detail: "가짜 내용" });
    const id = /#(t_[A-Za-z0-9]+)/.exec(made.text)![1]!;
    const notices = t.notices.length, revision = t.store.todoRevision(id), todos = t.store.listTodos(t.project.id).length;
    const result = await t.tool(t.worker, "todo_update", { id, title: "접수 메일 보내기(2판)" });
    expect(result).toEqual({ text: `할 일 #${id} 를 고쳤습니다` });
    expect(t.store.requireTodo(id)).toMatchObject({ title: "접수 메일 보내기(2판)", detail: "가짜 내용", done: false });
    expect((await t.tool(t.worker, "todo_update", { id, detail: "새 내용" })).text).toBe(`할 일 #${id} 를 고쳤습니다`);
    expect(t.store.requireTodo(id).detail).toBe("새 내용");
    expect((await t.tool(t.worker, "todo_update", { id, detail: "새 내용" })).text).toContain("이미 그 내용");
    expect(t.notices.length).toBe(notices);
    expect(t.store.todoRevision(id)).toBe(revision);
    expect(t.store.listTodos(t.project.id)).toHaveLength(todos);
  });

  test("남의 할 일·끝난 할 일·빈 고침은 거절한다. 총괄은 프로젝트의 할 일을 고친다", async () => {
    const t = await setup();
    const todo = t.store.createTodo({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "가짜 할 일" });
    expect((await t.tool(t.other, "todo_update", { id: todo.id, title: "남이 고침" })).isError).toBe(true);
    expect((await t.tool(t.worker, "todo_update", { id: todo.id })).isError).toBe(true);
    expect((await t.tool(t.lead, "todo_update", { id: todo.id, title: "총괄이 고침" })).isError).toBeFalsy();
    t.store.closeTodo(todo.id, { outcome: "dropped", reason: "가짜", by: "대표" });
    const finished = await t.tool(t.worker, "todo_update", { id: todo.id, title: "늦은 고침" });
    expect(finished.isError).toBe(true);
    expect(finished.text).toContain("이미 끝났거나 정리된 할 일");
    expect(t.store.requireTodo(todo.id).title).toBe("총괄이 고침");
  });
});

describe("D5-7 자료 판 갈이(file replaces)", () => {
  test("새 판이 옛 판을 대신한다: 목록의 최신 판에 판 수(옛 판은 replacedBy 로, 출시 앱이 열 수 있게 남긴다), 판 목록은 최신부터, 열린 결재의 근거 자료는 새 판으로(결재 판은 그대로)", async () => {
    const t = await setup();
    const publish = async (title: string, replaces?: string) => {
      const result = await t.tool(t.worker, "file", { title, content: `# ${title}`, ...(replaces ? { replaces } : {}) });
      expect(result.isError).toBeFalsy();
      return /#(f_[A-Za-z0-9]+)/.exec(result.text)![1]!;
    };
    const v1 = await publish("안내 문구");
    const { decision } = await ask(t, t.worker, { file_id: v1 });
    const v2 = await publish("안내 문구(고친 판)", v1);
    expect(t.store.requireDecision(decision.id)).toMatchObject({ fileId: v2, updatedAt: decision.updatedAt });
    const v3 = await publish("안내 문구(고친 판 2)", v2);
    const state = await (await t.get(`/api/projects/${t.project.id}/state`)).json() as { files: FileDoc[] };
    expect(state.files.map(f => f.id)).toEqual([v3, v2, v1]);
    expect(state.files[0]).toMatchObject({ replaces: v2, versions: 3 });
    expect(state.files[1]).toMatchObject({ id: v2, replaces: v1, replacedBy: v3 });
    expect("versions" in state.files[1]!).toBe(false);
    expect(state.files.filter(f => !f.replacedBy).map(f => f.id)).toEqual([v3]);
    const versions = await (await t.get(`/api/files/${v1}/versions?lite=1`)).json() as FileDoc[];
    expect(versions.map(f => f.id)).toEqual([v3, v2, v1]);
    expect("body" in versions[0]!).toBe(false);
    expect(await (await t.get(`/api/files/${v1}`)).json()).toMatchObject({ id: v1, replacedBy: v2 });
    // 옛 판은 지우지 않는다(보고가 가리키는 id, 첨부 정리는 모든 판을 본다).
    expect(t.store.listFiles(t.project.id).map(f => f.id).sort()).toEqual([v1, v2, v3].sort());
    expect(t.store.requireDecision(decision.id).fileId).toBe(v3);
    // 판을 간 뒤에 옛 판 id 로 올린 카드도 최신 판을 가리킨다(열린 결재는 판을 갈 때만 옮겨진다). 도구 답이 그렇게 말한다.
    const late = await ask(t, t.worker, { file_id: v1 });
    expect(late.decision.fileId).toBe(v3);
    expect(late.text).toContain(`근거 자료 #${v1} 는 새 판이 있어 최신 판 #${v3} 를 붙였습니다`);
    expect(t.store.listMessages(t.project.id).find(m => m.decisionId === late.decision.id)?.fileId).toBe(v3);
    const current = await ask(t, t.worker, { file_id: v3 });
    expect(current.decision.fileId).toBe(v3);
    expect(current.text).not.toContain("근거 자료");
  });

  test("이미 새 판이 있는 판·남이 올린 자료·다른 프로젝트 자료는 대신하지 못한다. 총괄은 직원의 자료를 새 판으로 바꾼다", async () => {
    const t = await setup();
    const first = /#(f_[A-Za-z0-9]+)/.exec((await t.tool(t.worker, "file", { title: "가짜", content: "가짜" })).text)![1]!;
    const second = /#(f_[A-Za-z0-9]+)/.exec((await t.tool(t.worker, "file", { title: "가짜 2", content: "가짜", replaces: first })).text)![1]!;
    const again = await t.tool(t.worker, "file", { title: "가짜 3", content: "가짜", replaces: first });
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toContain(`이미 새 판(#${second})이 있는 자료입니다`);
    expect((await t.tool(t.other, "file", { title: "남의 판", content: "가짜", replaces: second })).isError).toBe(true);
    const elsewhere = t.store.createProject({ name: "다른", cwd: t.home });
    const foreign = t.store.createFile({ projectId: elsewhere.id, title: "다른 곳", body: "가짜" });
    expect((await t.tool(t.worker, "file", { title: "가짜", content: "가짜", replaces: foreign.id })).isError).toBe(true);
    const files = t.store.listFiles(t.project.id).length;
    const byLead = await t.tool(t.lead, "file", { title: "총괄 판", content: "가짜", replaces: second });
    expect(byLead.isError).toBeFalsy();
    expect(t.store.listFiles(t.project.id)).toHaveLength(files + 1);
  });

  test("판 갈이 열이 없는 DB 도 여는 순간 열을 더한다(판 번호를 올리지 않는다)", () => {
    const t = { db: openDb(":memory:") };
    for (const [table, column] of REVISION_COLUMNS) expect(t.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)).toBe(true);
    t.db.close();
  });
});

describe("D1-5·D3-9 할 일 닫기의 결과(했음·필요 없음·팀장에게 맡김)", () => {
  const make = (t: T) => t.store.createTodo({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "스토어 서류 올리기" });
  const sentTo = (t: T, todo: Todo, memberId: string) => t.store.listDeliveries().filter(d => d.refId === todo.id && d.memberId === memberId);

  test("팀장에게 맡김: '했음'으로 보내지 않고 대표 메모 원문과 첨부를 싣는다. 결과 delegated·닫은 이 대표, 홈의 완료에 남는다", async () => {
    const t = await setup();
    const todo = make(t);
    const shot = await t.upload("안내.png");
    const response = await t.post(`/api/todos/${todo.id}/done`, { done: true, outcome: "delegated", note: "이건 그쪽에서\b 처리해 줘", fileIds: [shot.id] });
    expect(response.status).toBe(200);
    const closed = await response.json() as Todo;
    expect(closed).toMatchObject({ done: true, outcome: "delegated", closedBy: "대표", closeReason: "이건 그쪽에서 처리해 줘", completionNote: "이건 그쪽에서 처리해 줘", completionFileIds: [shot.id] });
    const [toWorker] = sentTo(t, todo, t.worker.id);
    expect(toWorker).toMatchObject({ kind: "todo_done", wake: true });
    expect(toWorker!.text).toStartWith(`[대표] '스토어 서류 올리기' 대표가 하지 않았음 — 이 일을 맡깁니다.`);
    expect(toWorker!.text).not.toContain("했음 #");
    expect(toWorker!.text).toContain("[대표 메모 원문]\n이건 그쪽에서 처리해 줘\n[대표 메모 끝]");
    expect(toWorker!.text).toContain(`대표가 올린 첨부: ${shot.id}`);
    expect(toWorker!.text).toContain(join(t.config.home, "inbox", t.worker.id));
    expect(sentTo(t, todo, t.lead.id)).toHaveLength(1);
    // 같은 결과의 재전송은 그대로, 다른 결과는 409.
    expect((await t.post(`/api/todos/${todo.id}/done`, { done: true, outcome: "delegated" })).status).toBe(200);
    expect((await t.post(`/api/todos/${todo.id}/drop`)).status).toBe(409);
    expect(sentTo(t, todo, t.worker.id)).toHaveLength(1);
  });

  test("필요 없음: 메모가 까닭이 되고 예전 '필요 없음' 글로 간다. 했음(기본)·출시 앱의 몸은 예전 그대로다", async () => {
    const t = await setup();
    const dropped = make(t);
    const response = await t.post(`/api/todos/${dropped.id}/done`, { done: true, outcome: "dropped", note: "다른 길로 풀렸어" });
    expect(await response.json()).toMatchObject({ outcome: "dropped", closeReason: "다른 길로 풀렸어", closedBy: "대표" });
    expect(sentTo(t, dropped, t.worker.id)[0]!.text).toBe(`[대표] '스토어 서류 올리기' 필요 없음 #${dropped.id}\n다른 길로 풀렸어`);
    const quiet = make(t);
    await t.post(`/api/todos/${quiet.id}/done`, { done: true, outcome: "dropped" });
    expect(t.store.requireTodo(quiet.id).closeReason).toBe("대표가 필요 없음으로 정리");
    const done = make(t);
    const legacy = await t.post(`/api/todos/${done.id}/done`, { done: true, note: "올렸어" });
    const doneTodo = await legacy.json() as Todo;
    expect(doneTodo).toMatchObject({ outcome: "done", closedBy: null, closeReason: null });
    expect(sentTo(t, done, t.worker.id)[0]!.text).toBe(formatTodoDone(doneTodo));
    expect(formatTodoDone(doneTodo)).toBe(`[대표] '스토어 서류 올리기' 했음 #${done.id}\n[대표 완료 답 원문]\n올렸어\n[대표 완료 답 끝]`);
    // 체크를 풀 때는 결과를 받지 않는다. 계약 2 도 같다.
    expect((await t.post(`/api/todos/${done.id}/done`, { done: false, outcome: "delegated" })).status).toBe(400);
    const v2 = make(t);
    const revision = t.store.todoRevision(v2.id);
    const strict = await t.post(`/api/todos/${v2.id}/done`, { done: true, outcome: "delegated", note: "맡길게" }, { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` });
    expect(strict.status).toBe(200);
    expect(await strict.json()).toMatchObject({ revision: revision + 1, todo: { outcome: "delegated" } });
  });
});

describe("D3-9 묵은 할 일 안내의 대상과 문구", () => {
  const old = (t: T, input: { memberId: string | null; who?: string }) => {
    const todo = t.store.createTodo({ projectId: t.project.id, title: "가짜 서류", ...input });
    t.store.db.query("UPDATE todos SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * DAY).toISOString(), todo.id);
    return t.store.requireTodo(todo.id);
  };
  test("부탁한 이가 없는 대표 본인의 할 일은 총괄에게 안내하지 않고, 그것 때문에 매일 판 정리를 하지도 않는다", async () => {
    const t = await setup();
    const own = old(t, { memberId: null });
    expect(t.orch.checkStaleTodos()).toEqual([]);
    expect(t.store.listPending(t.lead.id).some(d => d.text.includes(own.id))).toBe(false);
    expect(t.orch.checkBoardTidy()).toEqual([]);
  });
  test("'네가 부탁한'은 받는 이가 부탁한 이일 때만. 부탁한 팀장이 명부에 없으면 그렇다고 말하고 대표에게 묻지 말라고 한다", async () => {
    const t = await setup();
    const fromLead = old(t, { memberId: t.lead.id, who: t.lead.name });
    const gone = old(t, { memberId: "m_gone", who: "옛 운영" });
    const imported = old(t, { memberId: null, who: "가져온 팀장" });
    const fromWorker = old(t, { memberId: t.worker.id, who: t.worker.name });
    expect(t.orch.checkStaleTodos().sort()).toEqual([fromLead.id, gone.id, imported.id, fromWorker.id].sort());
    const toLead = (id: string) => t.store.listPending(t.lead.id).find(d => d.text.includes(`#${id}`))!.text;
    expect(toLead(fromLead.id)).toContain("네가 부탁한 대표의 할 일");
    expect(toLead(gone.id)).toContain("부탁한 팀장(옛 운영)은 지금 명부에 없다");
    expect(toLead(gone.id)).not.toContain("네가 부탁한");
    expect(toLead(gone.id)).toContain("대표에게 묻지 않는다");
    expect(toLead(imported.id)).toContain("부탁한 팀장(가져온 팀장)은 지금 명부에 없다");
    expect(t.store.listPending(t.worker.id).find(d => d.text.includes(`#${fromWorker.id}`))!.text).toContain("네가 부탁한");
  });
});

describe("D5-10 대표 글의 제어문자", () => {
  test("대화 글·결재 메모·할 일 답에 섞인 C0·C1 제어문자는 저장 전에 지운다. 줄바꿈·탭·이모지 결합 문자는 남긴다", async () => {
    const t = await setup();
    expect(stripControls("가\b나\u0000다\r\n라\t마\u0085👨‍👩‍👧")).toBe("가나다\n라\t마👨‍👩‍👧");
    const sent = await t.post(`/api/projects/${t.project.id}/messages`, { text: "목록\b 1번\u001b 고쳐" });
    expect(sent.status).toBe(200);
    expect((await sent.json()).body).toBe("목록 1번 고쳐");
    const empty = await t.post(`/api/projects/${t.project.id}/messages`, { text: "\b\u0007" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "message_empty" });
    const { decision } = await ask(t, t.worker, {});
    expect(await (await t.post(`/api/decisions/${decision.id}/answer`, { note: "좋\b아" })).json()).toMatchObject({ note: "좋아" });
    const todo = t.store.createTodo({ projectId: t.project.id, memberId: t.worker.id, who: t.worker.name, title: "가짜" });
    expect(await (await t.post(`/api/todos/${todo.id}/done`, { done: true, note: "했\u0008어" })).json()).toMatchObject({ completionNote: "했어" });
  });
});

/** ask 를 부르는 짧은 길(테스트 안에서 t 를 넘긴다). */
async function ask(t: T, member: Member, args: Record<string, unknown>) {
  return t.ask(member, args);
}
