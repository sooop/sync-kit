# sync-kit

sync-kit 은 브라우저 앱의 데이터를 여러 기기에서 맞추는 키트다. 앱이 데이터를 항목으로 나누면, 코어가 항목을 브라우저에서 암호화해 Cloudflare Worker 와 D1 에 올린다. 서버는 암호문만 알고, 같은 동기화 키를 입력한 기기끼리 같은 공간을 공유한다.

## 구성

| 폴더 | 내용 |
|---|---|
| `server/` | Cloudflare Worker + D1 서버. 직접 배포한다. 배포 안내는 [server/README.md](server/README.md) |
| `core/` | 클라이언트 코어(TypeScript). 키 파생, 암호화, 전송, 변경 감지, 충돌 판정, 스케줄 |
| `examples/` | 참고 구현. 메모리 어댑터, 프레임워크 없는 상태 컨트롤러, Svelte 대화상자 |
| `docs/` | 구조, 프로토콜, 어댑터 가이드, 운영 |

앱이 직접 만드는 것은 어댑터(앱 저장소와 항목 사이의 변환)와 설정 화면이다.

## 사용 형태

| 형태 | 방법 |
|---|---|
| npm 모듈 | 앱의 `package.json` 에 `"sync-kit": "file:../sync-kit"` 을 넣고 `npm install` 한다. 설치할 때 `prepare` 가 `dist/` 를 빌드한다. `import { … } from 'sync-kit'` |
| 빌드 없는 단일 ESM 파일 | `npm run build` 가 만든 `dist/sync-kit.min.js` 를 앱 옆에 두고 `import { … } from './sync-kit.min.js'` 한다. `fflate` 까지 들어 있다 |
| 서버 템플릿 | `server/` 를 복사해 앱마다 배포한다. 한 Worker 가 여러 앱을 받을 수 있다 |

## 빠른 시작

1. 서버를 배포한다. 순서는 [server/README.md](server/README.md) 에 있다. 배포가 끝나면 Worker 주소와 초대 코드를 얻는다.
2. 앱에서 어댑터를 구현한다. [docs/ADAPTER-GUIDE.md](docs/ADAPTER-GUIDE.md) 와 `examples/memory-adapter/adapter.ts` 를 따른다.
3. 엔진을 만들어 시작한다.

```ts
import { createIdbMetaStore, createSyncEngine, generateSyncKey } from 'sync-kit';
import { myAdapter } from './my-adapter';                 // SyncAdapter 구현

const config = {
  workerUrl: 'https://my-sync.example.workers.dev',       // 배포 후 얻은 Worker 주소
  syncKey: generateSyncKey(),                             // 이 기기에서 새로 시작할 때. 사용자에게 보여 주고 보관하게 한다
  inviteCode: '배포 때 정한 초대 코드',                       // 새 공간을 만드는 첫 요청에만 쓴다. 성공하면 지운다
};

const engine = createSyncEngine({
  appId: 'my-app',                                        // 서버의 ALLOWED_APPS 에 있는 값
  config,
  adapter: myAdapter,
  meta: createIdbMetaStore(),
});
engine.subscribe((status) => console.log(status.phase));  // 'idle', 'syncing', 'error' …
engine.start();                                           // 즉시 한 번 동기화하고 폴링을 건다
// 앱이 데이터를 쓸 때마다 engine.markDirty();
```

다른 기기는 `syncKey` 에 사용자가 입력한 키를 넣고 `inviteCode` 는 생략한다. 설정 저장, 연결·해제, 탭 하나만 엔진을 돌리는 락은 `examples/headless-state/controller.ts` 가 구현한다.

## 현재 상태

| 구분 | 내용 |
|---|---|
| 검증됨 | 실제 Cloudflare D1 에서 md-works 로 시험했다. 글·글감·스레드 동기화, 삭제 전파, 두 기기 충돌에서 이력 보존 |
| 검증되지 않음 | 보관 기간(30일) 경과 후의 삭제 정리와 resync 의 실환경 동작. `file://` 로 연 HTML 의 동작. 브라우저별 이벤트 차이(`visibilitychange`, `online`, Web Locks) |

모의 D1(`server/test/d1shim.ts`)과 단위 시험은 있지만, 위 미검증 항목은 실제 서버·브라우저에서 돌려 보지 않았다. 암호 설계는 외부 검증을 거치지 않았다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 구성도, 키 파생, 암호화 형식, 동기화 흐름, 충돌 모델, 삭제와 보관 기간, 한도, 보안 모델 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 요청·응답·헤더, 오류 코드, 서버의 확정 동작 |
| [docs/ADAPTER-GUIDE.md](docs/ADAPTER-GUIDE.md) | 새 앱에 붙이는 방법. 항목 설계, 어댑터 규칙, 설정 체크리스트, 점검 목록 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 한도 조정, 무료 플랜 용량 계산, 사용량 점검 쿼리, 문제 해결 |
| [server/README.md](server/README.md) | 서버 배포 안내 |
| [examples/reference-dialog-svelte/README.md](examples/reference-dialog-svelte/README.md) | 동기화 대화상자의 화면 구성과 상태별 안내 문구 |

## 개발

```
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # dist/ 생성
```
