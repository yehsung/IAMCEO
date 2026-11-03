import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_hq INTEGER NOT NULL DEFAULT 0,
    cwd TEXT NOT NULL,
    backend TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    model TEXT,
    runner_enabled INTEGER NOT NULL,
    now TEXT NOT NULL DEFAULT '',
    now_at TEXT,
    herdr_workspace_id TEXT,
    herdr_tab_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    cli TEXT NOT NULL DEFAULT 'claude',
    status TEXT NOT NULL,
    now TEXT NOT NULL DEFAULT '',
    next TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    session_id TEXT,
    pane_id TEXT,
    context_pct REAL,
    subagents INTEGER NOT NULL DEFAULT 0,
    parallel INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    token TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, handle)
  );

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT,
    who TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    rec TEXT,
    grp TEXT,
    file_id TEXT,
    images TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    choice TEXT,
    note TEXT,
    batch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    delivered_at TEXT
  );
  CREATE INDEX decisions_project ON decisions(project_id, status);
  CREATE INDEX decisions_member ON decisions(member_id, status);

  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT,
    who TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX todos_project ON todos(project_id, done);

  CREATE TABLE work (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sec TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    who TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    done_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX work_project ON work(project_id, sort_order);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    mine INTEGER NOT NULL DEFAULT 0,
    member_id TEXT,
    who TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    target_member_id TEXT,
    target_name TEXT,
    decision_id TEXT,
    file_id TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    delivery TEXT,
    delivery_note TEXT
  );
  CREATE INDEX messages_project ON messages(project_id, at);

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    who TEXT NOT NULL DEFAULT '',
    member_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    path TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE INDEX files_project ON files(project_id, sort_order);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    wake INTEGER NOT NULL DEFAULT 1,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    hold_reason TEXT,
    ref_type TEXT,
    ref_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX deliveries_member ON deliveries(member_id, status);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX activity_member ON activity(member_id, id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 받을 사람이 없어 '했음'을 아직 못 알린 할 일.
  `ALTER TABLE todos ADD COLUMN notice_pending INTEGER NOT NULL DEFAULT 0;`,
  // 결재 상태는 되돌아갈 수 있다(전달 실패 → 다시 열림). 화면이 새 값과 늦게 온 응답을 가르는 판 번호.
  `ALTER TABLE decisions ADD COLUMN updated_at TEXT;
   UPDATE decisions SET updated_at = COALESCE(delivered_at, answered_at, created_at);`,
  // 어디서도 쓰지 않았다. 탭 번호만 둔다(§5).
  `ALTER TABLE projects DROP COLUMN herdr_workspace_id;`,
  // 설정을 전체 하나로 통일한다. 프로젝트 값은 지우기 전에 직원과 보관 표로 옮겨 잃지 않는다.
  `CREATE TABLE project_settings_v4 AS SELECT id AS project_id, backend, permission_mode, model FROM projects;
   ALTER TABLE members ADD COLUMN backend TEXT;
   ALTER TABLE members ADD COLUMN model_override TEXT;
   ALTER TABLE members ADD COLUMN effort_override TEXT;
   ALTER TABLE members ADD COLUMN applied_config TEXT;
   UPDATE members SET backend = (SELECT p.backend FROM projects p WHERE p.id = members.project_id)
     WHERE origin != 'manual' AND (session_id IS NOT NULL OR pane_id IS NOT NULL);
   UPDATE members SET model_override = (SELECT p.model FROM projects p WHERE p.id = members.project_id) WHERE origin != 'manual';
   UPDATE members SET applied_config = json_object('model', model_override, 'effort', NULL, 'staffModel', NULL, 'staffEffort', NULL)
     WHERE origin = 'runner' AND session_id IS NOT NULL;
   UPDATE settings SET key = 'backend' WHERE key = 'defaultBackend';
   UPDATE settings SET key = 'permissionMode', value = CASE value WHEN '"acceptEdits"' THEN '"auto"' ELSE value END WHERE key = 'defaultPermissionMode';
   ALTER TABLE projects DROP COLUMN backend;
   ALTER TABLE projects DROP COLUMN permission_mode;
   ALTER TABLE projects DROP COLUMN model;`,
  // 자료의 모양과 아티팩트 원본. 원본은 화면 상태에 싣지 않고 따로 받는다.
  `ALTER TABLE files ADD COLUMN kind TEXT;
   ALTER TABLE files ADD COLUMN html TEXT;`,
  // 편입으로 들어온 세션의 표시. 해제할 때 되돌릴 것을 적어 둔다(JSON). 가져온 명부의 빈 자리(세션 없음)는 편입이 아니다.
  `ALTER TABLE members ADD COLUMN adopted_info TEXT;
   UPDATE members SET adopted_info = '{"turnedOnRunner":false}' WHERE origin = 'adopted' AND session_id IS NOT NULL;`,
  // 다시 열린 결재의 직전 답과 이유. 전달 실패로 대표의 메모가 사라지지 않게 한다.
  // 실행을 켠 것이 편입인가는 프로젝트의 사실이다. 켠 직원이 먼저 해제되면 직원 표시는 행과 함께 사라진다.
  `ALTER TABLE decisions ADD COLUMN last_choice TEXT;
   ALTER TABLE decisions ADD COLUMN last_note TEXT;
   ALTER TABLE decisions ADD COLUMN reopen_note TEXT;
   ALTER TABLE projects ADD COLUMN runner_by_adopt INTEGER NOT NULL DEFAULT 0;
   UPDATE projects SET runner_by_adopt = 1
     WHERE runner_enabled = 1 AND id IN (SELECT project_id FROM members WHERE json_extract(adopted_info, '$.turnedOnRunner') = 1);`,
  // v4→v5 이주가 옛 프로젝트의 승인 필요·오토를 조용히 바이패스로 올렸다. 저장한 전역 값과 프로젝트 값 중 가장 엄격한 것을 적는다.
  // 옛 기본은 auto 다. acceptEdits·모르는 값도 바이패스로 올리지 않는다. 프로젝트가 없는 새 DB 만 바이패스 기본을 쓴다.
  // 어느 값이든 바뀌었으면 대표에게 알린다. 바이패스는 대표가 설정에서 직접 고른다.
  `CREATE TEMP TABLE perm_repair AS
     SELECT saved, CASE
       WHEN saved = '"default"' OR strict = '"default"' THEN '"default"'
       WHEN strict = '"bypassPermissions"' AND (saved IS NULL OR saved = '"bypassPermissions"') THEN '"bypassPermissions"'
       ELSE '"auto"' END AS final
     FROM (SELECT
       (SELECT value FROM settings WHERE key = 'permissionMode') AS saved,
       CASE
         WHEN EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode = 'default') THEN '"default"'
         WHEN EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode IS NULL OR permission_mode != 'bypassPermissions') THEN '"auto"'
         ELSE '"bypassPermissions"' END AS strict)
     WHERE EXISTS (SELECT 1 FROM project_settings_v4);
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_permkept', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 권한 모드를 지정했던 값 중 가장 엄격한 ' || CASE final WHEN '"default"' THEN '모두 승인' ELSE '오토' END || ' 으로 정했습니다. 바이패스를 쓰려면 설정에서 직접 골라 주세요.'
     FROM perm_repair
     WHERE EXISTS (SELECT 1 FROM projects WHERE id = 'hq')
       AND ((saved IS NOT NULL AND saved != final)
         OR EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode IS NULL OR json_quote(permission_mode) != final));
   INSERT OR REPLACE INTO settings (key, value) SELECT 'permissionMode', final FROM perm_repair;
   DROP TABLE perm_repair;`,
  // 프로젝트 모델이 이주 시점의 직원에게만 옮겨져 새 직원이 그 값을 잃었다. 하나로 모이면 직급 기본값으로 올리고 직원별 지정을 푼다(그래야 설정의 직급 값이 먹는다).
  // 갈리면 직급 값을 정할 수 없다. 직원별 지정은 두고 대표에게 알린다.
  // 직급 값이 이미 저장돼 있으면 빈 칸만 채운다. 대표가 고른 모델은 덮지 않고, 그 직급의 직원별 지정은 남긴다.
  `INSERT OR IGNORE INTO settings (key, value)
     SELECT 'ranks', json_object(
       'manager', json_object('model', m.model, 'effort', NULL),
       'lead', json_object('model', m.model, 'effort', NULL),
       'staff', json_object('model', NULL, 'effort', NULL))
     FROM (SELECT MAX(model) AS model FROM project_settings_v4 WHERE model IS NOT NULL HAVING COUNT(DISTINCT model) = 1) m;
   UPDATE settings SET value = json_set(value,
       '$.manager', json_object('model', COALESCE(json_extract(value, '$.manager.model'), (SELECT MAX(model) FROM project_settings_v4)), 'effort', json_extract(value, '$.manager.effort')),
       '$.lead', json_object('model', COALESCE(json_extract(value, '$.lead.model'), (SELECT MAX(model) FROM project_settings_v4)), 'effort', json_extract(value, '$.lead.effort')))
     WHERE key = 'ranks' AND (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1;
   UPDATE members SET model_override = NULL
     WHERE origin != 'manual' AND model_override IS NOT NULL
       AND (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND model_override = (SELECT MAX(model) FROM project_settings_v4)
       AND (SELECT json_extract(value, CASE WHEN members.kind IN ('root', 'conductor') THEN '$.manager.model' ELSE '$.lead.model' END) FROM settings WHERE key = 'ranks') = model_override;
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modellift', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트에 지정했던 모델 ' || (SELECT MAX(model) FROM project_settings_v4) || ' 을 부장·팀장 기본값으로 옮겼습니다. 모델을 지정하지 않았던 프로젝트의 세션도 이 값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND (SELECT json_extract(value, '$.manager.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4)
       AND (SELECT json_extract(value, '$.lead.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4)
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modelkept', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트에 지정했던 모델 ' || (SELECT MAX(model) FROM project_settings_v4) || ' 은 저장된 직급 기본값과 달라 직원별 지정으로 남겼습니다. 앞으로 새로 뜨는 직원은 직급 기본값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND NOT (COALESCE((SELECT json_extract(value, '$.manager.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4), 0)
         AND COALESCE((SELECT json_extract(value, '$.lead.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4), 0))
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modelsplit', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트마다 달랐던 모델은 직원별 지정으로 옮겼습니다. 앞으로 새로 뜨는 직원은 직급 기본값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) > 1
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');`,
  // 총괄 이름에 프로젝트 이름을 붙인다. 핸들은 칸 소유 판정에 쓰여 여기서 바꾸지 않는다.
  `UPDATE members SET name = substr((SELECT name FROM projects WHERE projects.id = members.project_id) || ' 총괄', 1, 40)
   WHERE kind = 'conductor' AND name = '총괄';`,
  // 판 정리. 결재를 닫은 이유·닫은 이, 할 일의 끝남/필요 없어짐과 이유, 프로젝트의 마지막 판 정리 시각.
  // 이미 닫힌 결재는 직원이 명부에서 빠질 때 함께 닫힌 것뿐이다. 이유를 채워 결재된 항목에 보이게 한다.
  `ALTER TABLE decisions ADD COLUMN close_kind TEXT;
   ALTER TABLE decisions ADD COLUMN close_reason TEXT;
   ALTER TABLE decisions ADD COLUMN close_quote TEXT;
   ALTER TABLE decisions ADD COLUMN closed_by TEXT;
   ALTER TABLE decisions ADD COLUMN closed_at TEXT;
   UPDATE decisions SET close_reason = '물은 직원이 명부에서 빠져 함께 닫혔습니다', closed_by = '시스템', closed_at = COALESCE(updated_at, created_at)
     WHERE status = 'closed';
   ALTER TABLE todos ADD COLUMN outcome TEXT;
   ALTER TABLE todos ADD COLUMN close_reason TEXT;
   ALTER TABLE todos ADD COLUMN closed_by TEXT;
   ALTER TABLE todos ADD COLUMN updated_at TEXT;
   UPDATE todos SET outcome = 'done' WHERE done = 1;
   UPDATE todos SET updated_at = COALESCE(done_at, created_at);
   ALTER TABLE projects ADD COLUMN board_tidied_at TEXT;`,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  // 토큰과 대화가 들어 있다. 본인만 읽게 한다(폴더가 700 이어도 옮겨지면 소용없다).
  try {
    chmodSync(path, 0o600);
  } catch {
    // 메모리 DB 등. 권한을 걸 파일이 없다.
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function newId(prefix: string): string {
  return prefix + randomBytes(9).toString("base64url").replace(/[-_]/g, "x");
}

export function nowIso(): string {
  return new Date().toISOString();
}
