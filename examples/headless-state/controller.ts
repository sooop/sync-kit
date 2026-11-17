// 프레임워크 없는 동기화 상태 컨트롤러. md-works 의 state.svelte.ts 에서 룬($state)과 모듈 전역 상태를 걷어 낸 것이다.
// React·Vue·바닐라 어디서든 subscribe 로 상태를 받아 화면을 그린다.
//  - 설정(Worker 주소·동기화 키·초대 코드·켜짐 여부)은 storage 의 storageKey 한 곳에만 둔다. 번들·내보내기·백업에는 넣지 않는다.
//  - 한 브라우저에서 엔진은 한 탭에서만 돈다(Web Locks). 탭이 닫히면 다른 탭이 이어받는다.
//  - 초대 코드는 첫 요청이 성공하면 설정에서 지운다.
import {
  APP_ID_RE, createIdbMetaStore, createSyncEngine, formatSyncKey, generateSyncKey, normalizeSyncKey,
} from '../../core/src/index.ts';
import type {
  SyncAdapter, SyncConfig, SyncEngine, SyncEngineOptions, SyncMetaStore, SyncStatus,
} from '../../core/src/index.ts';

export const emptyStatus = (phase: SyncStatus['phase'] = 'off'): SyncStatus => ({ phase, lastSyncAt: 0, oversize: [], throttled: false });

/** 입력 검증 오류. field 는 화면에서 오류를 붙일 입력 칸 */
export class SyncInputError extends Error {
  constructor(public field: 'workerUrl' | 'inviteCode' | 'key', message: string) {
    super(message);
    this.name = 'SyncInputError';
  }
}

export interface SyncControllerState {
  config: SyncConfig | undefined;
  /** 사용자가 자동 동기화를 켜 두었는가(pause 하면 false) */
  enabled: boolean;
  status: SyncStatus;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LocksLike = { request: (name: string, ...rest: any[]) => Promise<unknown> };
type EngineLike = SyncEngine & { onInviteUsed?: () => void };

export interface SyncControllerOptions {
  /** 앱 식별자(소문자·숫자·하이픈 32자 이하). 서버의 ALLOWED_APPS 와 같아야 하고, 바꾸면 기존 공간과 끊긴다 */
  appId: string;
  /** 설정을 저장할 storage 키 */
  storageKey: string;
  /** 기본: localStorage. 쓸 수 없는 환경이면 설정을 메모리에만 둔다 */
  storage?: StorageLike;
  /** 엔진을 만들 때마다 부른다. 앱의 저장소에 연결한 어댑터를 돌려준다 */
  buildAdapter: () => SyncAdapter | Promise<SyncAdapter>;
  /** 기본: createSyncEngine. 테스트에서 가짜 엔진으로 바꾼다 */
  engineFactory?: (opts: SyncEngineOptions) => EngineLike;
  /** 기본: createIdbMetaStore(). 테스트·비브라우저에서는 createMemoryMetaStore */
  metaFactory?: () => SyncMetaStore;
  /** 기본: navigator.locks. null 이면 락 없이 이 탭에서 바로 시작한다 */
  locks?: LocksLike | null;
}

export interface SyncController {
  getState(): SyncControllerState;
  /** 즉시 현재 상태를 한 번 부르고, 이후 바뀔 때마다 부른다. 해제 함수를 돌려준다 */
  subscribe(fn: (s: SyncControllerState) => void): () => void;
  /** 설정이 있고 켜져 있으면 엔진을 시작한다(앱이 시작할 때 한 번) */
  startIfConfigured(): Promise<void>;
  /** 로컬 데이터가 바뀌었음을 엔진에 알린다 */
  markDirty(): void;
  /** 이 기기에서 새로 시작: 새 키를 만들고 초대 코드로 새 공간을 연다. 만든 키를 돌려준다 */
  connectNew(workerUrl: string, inviteCode: string): Promise<string>;
  /** 다른 기기의 키로 연결한다. 키 형식이 틀리면 SyncInputError('key') */
  connectExisting(workerUrl: string, keyInput: string): Promise<string>;
  /** 이 기기의 키·설정만 지운다. 항목은 그대로 둔다 */
  disconnect(): void;
  /** 로컬 동기화 메타(커서·항목별 rev)를 지운다. 다른 공간에 새로 연결하기 전에 부른다 */
  clearSyncMeta(): Promise<void>;
  pause(): void;
  resume(): void;
  syncNow(): Promise<void>;
  resolveResync(choice: 'upload' | 'delete'): Promise<void>;
  resolveMassDelete(choice: 'proceed' | 'restore'): Promise<void>;
}

interface Persisted { workerUrl: string; syncKey: string; inviteCode?: string; enabled: boolean }

const URL_ERR = 'Worker 주소를 https:// 로 시작하는 주소로 입력하세요 (예: https://my-sync.내이름.workers.dev)';

/** 공백·끝 슬래시를 정리하고 https 만 허용한다(localhost·127.0.0.1 은 http 도 허용) */
export function normalizeWorkerUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) throw new SyncInputError('workerUrl', 'Worker 주소를 입력하세요');
  let u: URL;
  try { u = new URL(s); } catch { throw new SyncInputError('workerUrl', URL_ERR); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new SyncInputError('workerUrl', URL_ERR);
  return `${u.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
}

function defaultStorage(): StorageLike | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function createSyncController(options: SyncControllerOptions): SyncController {
  const { appId, storageKey, buildAdapter } = options;
  if (!APP_ID_RE.test(appId)) throw new Error(`appId 형식이 올바르지 않습니다: ${appId}`);
  const storage = options.storage ?? defaultStorage();
  const engineFactory = options.engineFactory ?? createSyncEngine;
  const metaFactory = options.metaFactory ?? (() => createIdbMetaStore());
  const locks: LocksLike | undefined = options.locks === undefined
    ? (typeof navigator !== 'undefined' ? (navigator.locks as unknown as LocksLike | undefined) : undefined)
    : options.locks ?? undefined;
  const lockName = `sync-kit:${appId}:engine`;

  // ---- 저장 ----
  function load(): { config: SyncConfig | undefined; enabled: boolean } {
    const none = { config: undefined, enabled: true };
    let raw: string | null = null;
    try { raw = storage?.getItem(storageKey) ?? null; } catch { /* 저장소를 못 쓰는 환경 */ }
    if (!raw) return none;
    try {
      const o = JSON.parse(raw) as Partial<Persisted> | null;
      if (!o || typeof o !== 'object') return none;
      if (typeof o.workerUrl !== 'string' || typeof o.syncKey !== 'string' || !o.workerUrl || !o.syncKey) return none;
      return {
        config: { workerUrl: o.workerUrl, syncKey: o.syncKey, ...(typeof o.inviteCode === 'string' && o.inviteCode ? { inviteCode: o.inviteCode } : {}) },
        enabled: o.enabled !== false,
      };
    } catch {
      return none;
    }
  }

  function persist(): void {
    try {
      if (!state.config) { storage?.removeItem(storageKey); return; }
      const c = state.config;
      const p: Persisted = { workerUrl: c.workerUrl, syncKey: c.syncKey, ...(c.inviteCode ? { inviteCode: c.inviteCode } : {}), enabled: state.enabled };
      storage?.setItem(storageKey, JSON.stringify(p));
    } catch { /* 저장소를 못 쓰는 환경 */ }
  }

  // ---- 상태 ----
  const initial = load();
  let state: SyncControllerState = {
    config: initial.config,
    enabled: initial.enabled,
    status: emptyStatus(initial.config ? (initial.enabled ? 'idle' : 'paused') : 'off'),
  };
  const listeners = new Set<(s: SyncControllerState) => void>();
  function setState(patch: Partial<SyncControllerState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn(state);
  }

  // ---- 엔진 ----
  let engine: EngineLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let userStopped = false; // pause() 로 stop 했는가(resume 이 start 를 다시 불러야 한다)
  let generation = 0; // 엔진을 만드는 중에 설정이 바뀌면 이전 요청을 버린다

  async function buildEngine(config: SyncConfig): Promise<EngineLike> {
    const adapter = await buildAdapter();
    return engineFactory({ appId, config, adapter, meta: metaFactory() });
  }

  function stopEngine(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    engine?.stop();
    engine = undefined;
  }

  /** 첫 요청이 성공했으면 초대 코드를 설정에서 지운다 */
  function dropInviteCode(): void {
    if (!state.config?.inviteCode) return;
    const { inviteCode: _drop, ...rest } = state.config;
    setState({ config: rest });
    persist();
  }

  function onStatus(s: SyncStatus): void {
    setState({ status: { ...s } });
    if (s.lastSyncAt > 0 && (s.phase === 'idle' || s.phase === 'pending')) dropInviteCode();
  }

  async function startEngine(): Promise<void> {
    stopEngine();
    const config = state.config;
    if (!config) { setState({ status: emptyStatus('off') }); return; }
    const gen = ++generation;
    try {
      const e = await buildEngine({ ...config });
      if (gen !== generation) { e.stop(); return; }
      engine = e;
      userStopped = false;
      e.onInviteUsed = dropInviteCode;
      unsubscribe = e.subscribe(onStatus);
      setState({ status: { ...e.status } });
      e.start();
    } catch (err) {
      if (gen !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: { ...emptyStatus('error'), lastError: { kind: 'network', message: `동기화를 시작하지 못했습니다: ${message}` } } });
    }
  }

  // ---- 탭 하나만 엔진을 돌린다 ----
  let holding = false; // 이 컨트롤러가 락을 쥐고 있는가
  let releaseLock: (() => void) | undefined;

  /** 락을 쥐고 엔진을 시작한 뒤, release 될 때까지(탭이 닫힐 때까지) 락을 놓지 않는다 */
  async function holdAndStart(onStarted: () => void): Promise<void> {
    if (!state.config) { onStarted(); return; } // 기다리는 동안 연결이 해제됐으면 락을 쥐지 않는다
    holding = true;
    try {
      if (state.enabled) await startEngine();
    } finally { onStarted(); }
    await new Promise<void>((resolve) => { releaseLock = resolve; });
    holding = false;
  }

  /** 엔진을 이 탭에서 돌릴 수 있게 한다. 다른 탭이 락을 쥐고 있으면 기다렸다가 이어받는다 */
  function acquire(): Promise<void> {
    if (!locks) return startEngine();
    if (holding) return startEngine();
    return new Promise<void>((resolve) => {
      void locks.request(lockName, { ifAvailable: true }, async (lock: unknown) => {
        if (lock) { await holdAndStart(resolve); return; }
        resolve(); // 다른 탭이 엔진을 돌리는 중이다
        // 락을 쥔 탭이 닫히면 이 탭이 이어받는다
        void locks.request(lockName, () => holdAndStart(() => {}));
      });
    });
  }

  function release(): void {
    const r = releaseLock;
    releaseLock = undefined;
    holding = false;
    r?.();
  }

  // ---- 연결 ----
  async function applyConfig(config: SyncConfig): Promise<void> {
    setState({ config, enabled: true });
    persist();
    await acquire();
  }

  const controller: SyncController = {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => { listeners.delete(fn); };
    },

    async startIfConfigured() {
      if (!state.config) return;
      if (!state.enabled) { setState({ status: emptyStatus('paused') }); return; }
      if (engine) return;
      await acquire();
    },

    markDirty() {
      if (engine && state.enabled) engine.markDirty();
    },

    async connectNew(workerUrl, inviteCode) {
      const url = normalizeWorkerUrl(workerUrl);
      const code = inviteCode.trim();
      if (!code) throw new SyncInputError('inviteCode', '초대 코드를 입력하세요. Worker 를 배포할 때 정한 코드입니다');
      const syncKey = generateSyncKey();
      await applyConfig({ workerUrl: url, syncKey, inviteCode: code });
      return syncKey;
    },

    async connectExisting(workerUrl, keyInput) {
      const url = normalizeWorkerUrl(workerUrl);
      const normalized = normalizeSyncKey(keyInput);
      if (!normalized) throw new SyncInputError('key', '동기화 키가 올바르지 않습니다. 영문 대문자·숫자 26자(4자씩 끊어 표시)인지 확인하세요');
      const syncKey = formatSyncKey(normalized);
      await applyConfig({ workerUrl: url, syncKey });
      return syncKey;
    },

    disconnect() {
      generation++;
      stopEngine();
      release();
      setState({ config: undefined, enabled: true, status: emptyStatus('off') });
      persist();
    },

    async clearSyncMeta() {
      await metaFactory().clear();
    },

    pause() {
      if (!state.config) return;
      setState({ enabled: false });
      persist();
      engine?.stop();
      userStopped = true;
      setState({ status: { ...state.status, phase: 'paused', lastError: undefined } });
    },

    resume() {
      if (!state.config) return;
      setState({ enabled: true });
      persist();
      if (!engine) { void acquire(); return; }
      if (userStopped) { userStopped = false; engine.start(); } else engine.resume();
    },

    async syncNow() {
      if (!state.config) return;
      if (!state.enabled) controller.resume();
      await engine?.syncNow();
    },

    async resolveResync(choice) {
      await engine?.resolveResync(choice);
    },

    async resolveMassDelete(choice) {
      await engine?.resolveMassDelete(choice);
    },
  };
  return controller;
}
