import { describe, expect, it, vi } from 'vitest';
import { createMemoryMetaStore, type SyncAdapter, type SyncEngineOptions, type SyncStatus } from '../../core/src/index.ts';
import { createSyncController, emptyStatus, SyncInputError, type SyncControllerOptions } from './controller.ts';

const KEY = 'my-app.sync';
const URL_OK = 'https://my-sync.example.workers.dev';
const SYNC_KEY = '0123456789ABCDEFGHJKMNPQRS'; // 26자

function fakeStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

interface FakeEngine {
  opts: SyncEngineOptions;
  status: SyncStatus;
  calls: string[];
  onInviteUsed?: () => void;
  emit(patch: Partial<SyncStatus>): void;
  [k: string]: unknown;
}

function fakeEngines() {
  const made: FakeEngine[] = [];
  const factory = (opts: SyncEngineOptions) => {
    const listeners = new Set<(s: SyncStatus) => void>();
    const e: FakeEngine = {
      opts,
      status: emptyStatus('idle'),
      calls: [],
      subscribe(fn: (s: SyncStatus) => void) { listeners.add(fn); return () => listeners.delete(fn); },
      start() { e.calls.push('start'); },
      stop() { e.calls.push('stop'); },
      markDirty() { e.calls.push('markDirty'); },
      async syncNow() { e.calls.push('syncNow'); },
      async resolveResync(c: string) { e.calls.push(`resolveResync:${c}`); },
      async resolveMassDelete(c: string) { e.calls.push(`resolveMassDelete:${c}`); },
      resume() { e.calls.push('resume'); },
      emit(patch: Partial<SyncStatus>) { e.status = { ...e.status, ...patch }; for (const fn of listeners) fn(e.status); },
    };
    made.push(e);
    return e as unknown as ReturnType<NonNullable<SyncControllerOptions['engineFactory']>>;
  };
  return { made, factory };
}

const adapter = {} as SyncAdapter;

function make(extra: Partial<SyncControllerOptions> & { storage?: ReturnType<typeof fakeStorage> } = {}) {
  const engines = fakeEngines();
  const storage = extra.storage ?? fakeStorage();
  const controller = createSyncController({
    appId: 'my-app',
    storageKey: KEY,
    storage,
    buildAdapter: () => adapter,
    engineFactory: engines.factory,
    metaFactory: () => createMemoryMetaStore(),
    locks: null,
    ...extra,
  });
  return { controller, storage, engines };
}

/** 전체 Web Locks 가 아니라 이 테스트에 필요한 만큼만 흉내 낸다(이름 하나, ifAvailable, 대기열) */
function fakeLocks() {
  let held = false;
  const queue: (() => void)[] = [];
  const grant = (cb: (lock: unknown) => Promise<unknown>): Promise<unknown> => {
    held = true;
    return Promise.resolve(cb({})).finally(() => { held = false; queue.shift()?.(); });
  };
  return {
    request(_name: string, a: unknown, b?: (lock: unknown) => Promise<unknown>): Promise<unknown> {
      const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => Promise<unknown>;
      const ifAvailable = typeof a === 'object' && a !== null && (a as { ifAvailable?: boolean }).ifAvailable;
      if (!held) return grant(cb);
      if (ifAvailable) return Promise.resolve(cb(null));
      return new Promise((resolve) => { queue.push(() => { void grant(cb).then(resolve); }); });
    },
  };
}

describe('createSyncController', () => {
  it('appId 형식이 틀리면 만들 때 던진다', () => {
    expect(() => make({ appId: 'My App' })).toThrow();
  });

  it('설정이 없으면 off 상태이고 엔진을 만들지 않는다', async () => {
    const { controller, engines } = make();
    expect(controller.getState().status.phase).toBe('off');
    await controller.startIfConfigured();
    expect(engines.made).toHaveLength(0);
  });

  it('Worker 주소는 https 만 받고 localhost 는 http 도 받는다', async () => {
    const { controller } = make();
    await expect(controller.connectExisting('http://example.com', SYNC_KEY)).rejects.toMatchObject({ field: 'workerUrl' });
    await expect(controller.connectExisting('', SYNC_KEY)).rejects.toBeInstanceOf(SyncInputError);
    await expect(controller.connectExisting('http://localhost:8787/', SYNC_KEY)).resolves.toContain('-');
    expect(controller.getState().config?.workerUrl).toBe('http://localhost:8787');
  });

  it('틀린 키는 key 칸 오류로 거부하고 설정을 바꾸지 않는다', async () => {
    const { controller, storage } = make();
    await expect(controller.connectExisting(URL_OK, 'abc')).rejects.toMatchObject({ field: 'key' });
    expect(controller.getState().config).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  it('초대 코드가 비면 inviteCode 칸 오류다', async () => {
    const { controller } = make();
    await expect(controller.connectNew(URL_OK, '  ')).rejects.toMatchObject({ field: 'inviteCode' });
  });

  it('connectExisting 은 키를 4자 그룹으로 저장하고 appId 를 엔진에 넘긴다', async () => {
    const { controller, storage, engines } = make();
    const key = await controller.connectExisting(URL_OK, ' 0123 4567-89ab cdef ghjk mnpq rs ');
    expect(key).toBe('0123-4567-89AB-CDEF-GHJK-MNPQ-RS');
    const saved = JSON.parse(storage.data.get(KEY)!);
    expect(saved).toEqual({ workerUrl: URL_OK, syncKey: key, enabled: true });
    expect(engines.made).toHaveLength(1);
    expect(engines.made[0].opts.appId).toBe('my-app');
    expect(engines.made[0].opts.adapter).toBe(adapter);
    expect(engines.made[0].calls).toEqual(['start']);
  });

  it('저장된 설정을 읽어 startIfConfigured 로 시작한다', async () => {
    const storage = fakeStorage(JSON.stringify({ workerUrl: URL_OK, syncKey: SYNC_KEY, enabled: true }));
    const { controller, engines } = make({ storage });
    expect(controller.getState().status.phase).toBe('idle');
    await controller.startIfConfigured();
    expect(engines.made).toHaveLength(1);
  });

  it('꺼 둔 설정은 paused 로 두고 엔진을 만들지 않는다', async () => {
    const storage = fakeStorage(JSON.stringify({ workerUrl: URL_OK, syncKey: SYNC_KEY, enabled: false }));
    const { controller, engines } = make({ storage });
    await controller.startIfConfigured();
    expect(controller.getState().status.phase).toBe('paused');
    expect(engines.made).toHaveLength(0);
  });

  it('망가진 저장값은 설정 없음으로 본다', () => {
    const { controller } = make({ storage: fakeStorage('{not json') });
    expect(controller.getState().config).toBeUndefined();
  });

  it('storage 가 던져도 동작한다', async () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    const { controller, engines } = make({ storage: broken as never });
    await controller.connectExisting(URL_OK, SYNC_KEY);
    expect(engines.made).toHaveLength(1);
    expect(() => controller.disconnect()).not.toThrow();
  });

  it('초대 코드는 첫 성공 뒤 설정에서 지운다', async () => {
    const { controller, storage, engines } = make();
    await controller.connectNew(URL_OK, 'invite-1');
    expect(JSON.parse(storage.data.get(KEY)!).inviteCode).toBe('invite-1');
    expect(engines.made[0].opts.config.inviteCode).toBe('invite-1');
    engines.made[0].emit({ phase: 'syncing' });
    expect(JSON.parse(storage.data.get(KEY)!).inviteCode).toBe('invite-1');
    engines.made[0].emit({ phase: 'idle', lastSyncAt: 1000 });
    expect(controller.getState().config?.inviteCode).toBeUndefined();
    expect(JSON.parse(storage.data.get(KEY)!).inviteCode).toBeUndefined();
  });

  it('엔진이 초대 코드 사용을 알려도 지운다', async () => {
    const { controller, engines } = make();
    await controller.connectNew(URL_OK, 'invite-1');
    engines.made[0].onInviteUsed?.();
    expect(controller.getState().config?.inviteCode).toBeUndefined();
  });

  it('subscribe 는 현재 상태를 바로 부르고 해제할 수 있다', async () => {
    const { controller, engines } = make();
    const seen: string[] = [];
    const off = controller.subscribe((s) => seen.push(s.status.phase));
    expect(seen).toEqual(['off']);
    await controller.connectExisting(URL_OK, SYNC_KEY);
    engines.made[0].emit({ phase: 'syncing' });
    expect(seen.at(-1)).toBe('syncing');
    off();
    const n = seen.length;
    engines.made[0].emit({ phase: 'idle' });
    expect(seen).toHaveLength(n);
  });

  it('pause 와 resume 은 엔진을 멈추고 다시 시작한다', async () => {
    const { controller, storage, engines } = make();
    await controller.connectExisting(URL_OK, SYNC_KEY);
    const e = engines.made[0];
    controller.pause();
    expect(controller.getState().status.phase).toBe('paused');
    expect(JSON.parse(storage.data.get(KEY)!).enabled).toBe(false);
    controller.markDirty();
    expect(e.calls).toEqual(['start', 'stop']);
    controller.resume();
    expect(e.calls).toEqual(['start', 'stop', 'start']);
    expect(JSON.parse(storage.data.get(KEY)!).enabled).toBe(true);
    controller.markDirty();
    expect(e.calls.at(-1)).toBe('markDirty');
  });

  it('syncNow·resolveResync·resolveMassDelete 는 엔진에 전달한다', async () => {
    const { controller, engines } = make();
    await controller.connectExisting(URL_OK, SYNC_KEY);
    await controller.syncNow();
    await controller.resolveResync('upload');
    await controller.resolveMassDelete('restore');
    expect(engines.made[0].calls).toEqual(['start', 'syncNow', 'resolveResync:upload', 'resolveMassDelete:restore']);
  });

  it('disconnect 는 엔진을 멈추고 저장된 설정을 지운다', async () => {
    const { controller, storage, engines } = make();
    await controller.connectExisting(URL_OK, SYNC_KEY);
    controller.disconnect();
    expect(engines.made[0].calls).toEqual(['start', 'stop']);
    expect(controller.getState().config).toBeUndefined();
    expect(controller.getState().status.phase).toBe('off');
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('엔진 생성이 실패하면 error 상태로 알린다', async () => {
    const { controller } = make({ engineFactory: () => { throw new Error('boom'); } });
    await controller.connectExisting(URL_OK, SYNC_KEY);
    const s = controller.getState().status;
    expect(s.phase).toBe('error');
    expect(s.lastError?.message).toContain('boom');
  });

  it('두 컨트롤러 중 락을 쥔 쪽만 엔진을 돌리고, 해제하면 다른 쪽이 이어받는다', async () => {
    const locks = fakeLocks();
    const storage = fakeStorage(JSON.stringify({ workerUrl: URL_OK, syncKey: SYNC_KEY, enabled: true }));
    const a = make({ storage, locks });
    const b = make({ storage, locks });
    await a.controller.startIfConfigured();
    await b.controller.startIfConfigured();
    expect(a.engines.made).toHaveLength(1);
    expect(b.engines.made).toHaveLength(0);
    a.controller.disconnect();
    await vi.waitFor(() => expect(b.engines.made).toHaveLength(1));
    expect(b.engines.made[0].calls).toEqual(['start']);
  });
});
