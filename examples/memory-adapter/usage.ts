// 메모리 어댑터를 엔진에 연결하는 최소 예. 새 앱은 어댑터만 자기 저장소용으로 바꾸면 된다.
// 설치한 패키지에서는 '../../core/src/index.ts' 자리에 'sync-kit' 을 쓴다.
import { createIdbMetaStore, createSyncEngine, generateSyncKey } from '../../core/src/index.ts';
import type { SyncConfig, SyncEngine, SyncMetaStore } from '../../core/src/index.ts';
import { createMemoryNotesAdapter } from './adapter.ts';

const APP_ID = 'notes-demo'; // 서버의 ALLOWED_APPS 에 있는 값. 소문자·숫자·하이픈 32자 이하. 정한 뒤에는 바꾸지 않는다

export function startNotesSync(opts: { workerUrl: string; inviteCode?: string; syncKey?: string; meta?: SyncMetaStore }) {
  // 처음 쓰는 기기는 키를 새로 만든다. 사용자에게 한 번 보여 주고 따로 보관하게 한다. 다른 기기는 이 키를 입력해 연결한다
  const syncKey = opts.syncKey ?? generateSyncKey();

  const config: SyncConfig = { workerUrl: opts.workerUrl, syncKey, ...(opts.inviteCode ? { inviteCode: opts.inviteCode } : {}) };

  let engine: SyncEngine | undefined;
  const notes = createMemoryNotesAdapter([], { onChange: () => engine?.markDirty() });

  // 키 파생(deriveKeys)·암호화·전송은 엔진이 appId 와 config 로 만든다. 호출하는 쪽은 옵션만 채운다
  engine = createSyncEngine({
    appId: APP_ID,
    config,
    adapter: notes.adapter,
    meta: opts.meta ?? createIdbMetaStore(), // 브라우저가 아니면 createMemoryMetaStore()
  });
  engine.subscribe((s) => console.log(`[sync] ${s.phase}`, s.lastError?.message ?? ''));
  engine.start(); // 즉시 한 번 동기화하고 3분 폴링·재접속 감지를 건다
  return { engine, syncKey, notes };
}
