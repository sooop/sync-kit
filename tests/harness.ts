// 통합 테스트 하네스: 실제 서버 핸들러(+D1 shim) · 실제 키·코덱·전송·엔진 · examples/memory-adapter 를 '기기' 단위로 묶는다.
import { expect } from 'vitest';
import { handleRequest, type Env } from '../server/src/handler.ts';
import { D1Shim } from '../server/test/d1shim.ts';
import {
  createCodec, createMemoryMetaStore, createSyncEngine, createTransport, deriveKeys,
  type DerivedKeys, type SyncEngine, type SyncMetaStore, type SyncRequest, type SyncResponse,
} from '../core/src/index.ts';
import { createMemoryNotesAdapter, type MemoryNotesHandle, type MemoryNotesOptions } from '../examples/memory-adapter/adapter.ts';

export const URL_BASE = 'https://sync.test';
export const INVITE = 'invite-code';
export const APP_ID = 'notes-demo';
export const DAY = 86_400_000;

// ───────── 서버 ─────────
export interface Exchange { req: SyncRequest; status: number; res?: SyncResponse; invite: string | null; appId: string | null }

export function makeServer(vars: Record<string, string | undefined> = {}) {
  const db = new D1Shim();
  const env: Env = { DB: db, INVITE_CODE: INVITE, ALLOWED_APPS: APP_ID, ...vars };
  const s = {
    db, env,
    /** 서버 시계를 실제 시각에서 이만큼 옮긴다 */
    clockOffset: 0,
    /** 정리(purge) 난수: 1 = 정리 안 함, 0 = 쓰기 요청마다 정리 */
    random: 1,
    log: [] as Exchange[],
    /** 다음 요청 본문을 이 문자열로 바꿔 보낸다(400 시험) */
    mangleBody: null as string | null,
    fetch: (async (url: string, init: RequestInit) => {
      const body = s.mangleBody ?? (init.body as string);
      s.mangleBody = null;
      const resp = await handleRequest(new Request(url, { ...init, body }), env, {
        now: () => Date.now() + s.clockOffset, random: () => s.random,
      });
      let res: SyncResponse | undefined;
      if (resp.status === 200) res = (await resp.clone().json()) as SyncResponse;
      let req: SyncRequest;
      try { req = JSON.parse(body); } catch { req = { cursor: -1, push: [] }; }
      if (!Array.isArray(req?.push)) req = { cursor: -1, push: [] };
      const h = init.headers as Record<string, string>;
      s.log.push({ req, status: resp.status, res, invite: h['X-Invite-Code'] ?? null, appId: h['X-App-Id'] ?? null });
      return resp;
    }) as typeof fetch,
    sql: (sql: string) => db.sqlite.prepare(sql).all() as Record<string, unknown>[],
    /** 서버 항목 id → rev */
    revs: () => Object.fromEntries(db.sqlite.prepare('SELECT item_id, rev FROM items ORDER BY item_id').all().map((r) => [r.item_id as string, r.rev as number])),
  };
  return s;
}
export type Server = ReturnType<typeof makeServer>;

// ───────── 기기 ─────────
export interface Device {
  handle: MemoryNotesHandle;
  meta: SyncMetaStore;
  engine: SyncEngine;
  keys: DerivedKeys;
  appId: string;
  /** 앱이 쓴 변경 알림(엔진 markDirty 로 연결된 횟수). 원격 반영(apply)은 올라가지 않아야 한다 */
  dirtyCalls: { n: number };
  /** 이 기기의 시계를 옮긴다(일일 한도 시험) */
  clock: { skew: number };
}

export async function makeDevice(
  server: Server, syncKey: string,
  opts: { appId?: string; invite?: string | false; adapter?: Partial<MemoryNotesOptions> } = {},
): Promise<Device> {
  const appId = opts.appId ?? APP_ID;
  const keys = await deriveKeys(syncKey, appId);
  const dirtyCalls = { n: 0 };
  const clock = { skew: 0 };
  let engine!: SyncEngine;
  const handle = createMemoryNotesAdapter([], { onChange: () => { dirtyCalls.n++; engine?.markDirty(); }, ...opts.adapter });
  const meta = createMemoryMetaStore();
  engine = createSyncEngine({
    appId,
    config: { workerUrl: URL_BASE, syncKey, ...(opts.invite === false ? {} : { inviteCode: opts.invite ?? INVITE }) },
    adapter: handle.adapter, meta,
    codec: createCodec(keys.encKey),
    transport: createTransport({ workerUrl: URL_BASE, appId, spaceId: keys.spaceId, authToken: keys.authToken }, server.fetch),
    now: () => Date.now() + clock.skew,
    autoSchedule: false,
  });
  return { handle, meta, engine, keys, appId, dirtyCalls, clock };
}

// ───────── 단언 보조 ─────────
export const metaRevs = async (d: Device) => (await d.meta.getAll()).map((m) => `${m.id}:${m.rev}`).sort();

/** 동기화 1회가 오류 없이 idle 로 끝난다 */
export async function ok(...ds: Device[]) {
  for (const d of ds) {
    await d.engine.syncNow();
    expect(d.engine.status.lastError, JSON.stringify(d.engine.status.lastError)).toBeUndefined();
    expect(d.engine.status.phase).toBe('idle');
  }
}

/** 변경 없이 연속 sync 해도 서버 쓰기·서버 rev·로컬 메타 rev·이력 길이가 그대로다(dirty 루프 없음) */
export async function expectQuiet(server: Server, ...ds: Device[]) {
  for (let i = 0; i < 3; i++) {
    for (const d of ds) {
      const before = { meta: await metaRevs(d), server: server.revs(), writes: server.db.writes, hist: d.handle.history.length, dirty: d.dirtyCalls.n };
      await ok(d);
      expect(server.db.writes, '서버 쓰기').toBe(before.writes);
      expect(server.revs(), '서버 rev').toEqual(before.server);
      expect(await metaRevs(d), '로컬 메타 rev').toEqual(before.meta);
      expect(d.handle.history.length, '이력').toBe(before.hist);
      expect(d.dirtyCalls.n, 'apply 가 앱 변경 알림을 올리지 않는다').toBe(before.dirty);
    }
  }
}

/** 모든 기기를 돌려가며 sync 하다가 한 바퀴 동안 서버 쓰기가 없으면 끝낸다. 수렴하지 않으면 실패 */
export async function converge(server: Server, ds: Device[], maxRounds = 6): Promise<number> {
  for (let r = 1; r <= maxRounds; r++) {
    const w = server.db.writes;
    await ok(...ds);
    if (server.db.writes === w) return r;
  }
  throw new Error(`${maxRounds} 바퀴 안에 수렴하지 않음(dirty 루프 의심)`);
}

/** 항목 id 로 정렬한 listLocal. 두 기기의 값이 같아야 '적용한 값 == 읽은 값' 이다 */
export async function sortedLocal(d: Device) {
  return (await d.handle.adapter.listLocal()).sort((x, y) => x.id.localeCompare(y.id));
}

/** 제목 → 본문, 댓글은 '부모 제목|내용' 로 본 기기 사이 비교용 스냅샷 */
export function snapshot(d: Device) {
  const notes = d.handle.notes();
  const title = new Map(notes.map((n) => [n.id, n.title]));
  return {
    notes: notes.map((n) => `${n.title}=${n.body}@${n.updatedAt}`).sort(),
    // 삭제된 메모에 매달린 댓글(예제 어댑터가 저장소에 남겨 두지만 동기화하지 않는 것)은 제외한다
    comments: d.handle.comments().filter((c) => title.has(c.noteId)).map((c) => `${title.get(c.noteId)}|${c.text}@${c.updatedAt}`).sort(),
  };
}
