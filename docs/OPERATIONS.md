# 운영

서버를 배포한 뒤 한도를 조정하고 사용량을 점검하는 방법이다. 배포 순서는 [server/README.md](../server/README.md) 에 있다.

## 한도 값과 조정

서버 한도는 `server/wrangler.toml` 의 `[vars]` 에 있다. 파일은 `server/wrangler.toml.example` 을 복사해 만든다.

| 변수 | 기본값 | 의미 | 넘으면 |
|---|---|---|---|
| `ALLOWED_APPS` | 견본 값 `my-app` | 새 공간을 만들 수 있는 appId 목록(쉼표로 구분) | 403 `forbidden` |
| `MAX_ITEM_BYTES` | 262144 | 항목 하나의 blob 길이(base64 문자 수) | 422 `item_too_large` |
| `MAX_SPACE_BYTES` | 5242880 | 공간 하나의 blob 길이 합계(5 MB) | 422 `space_full` |
| `MAX_SPACES` | 60 | 서버 전체의 공간 수. 모든 앱이 나눠 쓴다 | 새 공간이 403 `forbidden` |
| `MAX_ITEMS_PER_SPACE` | 1000 | 공간 하나의 삭제되지 않은 항목 수 | 422 `item_limit` |
| `MAX_DAILY_WRITES` | 300 | 공간 하나가 하루(UTC)에 쓸 수 있는 항목 수 | 429 `daily_write_limit` |
| `TOMBSTONE_DAYS` | 30 | 삭제 항목을 보관하는 일수 | 이 기간이 지난 기기는 resync 를 받는다 |

조정 방법:

1. `server/wrangler.toml` 의 `[vars]` 값을 고친다. 값은 따옴표로 감싼 문자열이다.
2. `server` 폴더에서 `npx wrangler deploy` 를 실행한다. 이미 만든 공간에도 새 값이 바로 적용된다.

`schema.sql` 을 바꿨다면 `npx wrangler d1 execute <db-name> --remote --file=./schema.sql` 을 다시 실행한다. 같은 명령을 여러 번 실행해도 안전하다.

`MAX_BODY_BYTES`, `MAX_PUSH_ITEMS`, `PULL_MAX_ITEMS`, `PULL_MAX_BYTES` 도 같은 방식으로 서버에서 읽지만 견본에는 없다. 클라이언트가 같은 기본값을 전제하므로 바꾸지 않는다.

클라이언트 코어의 `LIMITS` 상수(`core/src/protocol.ts`)는 기본값이다. 서버 값을 바꿔도 다음은 기본값 기준으로 동작한다.

- 사용량 막대의 비율(`usageRatio`)
- 오늘 쓰기가 한도의 80% 에 닿았을 때 푸시 간격을 5분으로 늘리는 판정
- 항목 크기 사전 검사(`MAX_ITEM_BYTES` 를 넘으면 올리지 않고 `oversize` 로 표시)

서버 한도를 기본값보다 크게 올리면 항목 크기 사전 검사가 먼저 걸리고, 작게 낮추면 서버가 422 로 거부한다.

## 무료 플랜 한도

아래 값은 작성 시점에 알려진 값이다. 최신 값은 Cloudflare 공식 문서(https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/d1/platform/limits/)에서 확인한다.

| 항목 | 무료 플랜 한도 |
|---|---|
| Workers 요청 | 하루 10만 회 |
| D1 쓰기 | 하루 10만 행 |
| D1 읽기 | 하루 500만 행 |
| D1 데이터베이스 크기 | 500 MB |

한도를 넘으면 다음 00:00 UTC(한국 시간 오전 9시)까지 요청이 실패한다. 무료 플랜에서는 한도를 넘어도 요금이 청구되지 않는다. 기본 한도(공간 60개 × 5 MB = 300 MB)는 데이터베이스 500 MB 안에 들어온다.

## 실측 사례

md-works 시험(2026-11-17, 공간 1개). 항목은 글·글감·스레드를 합친 것이다. 수치는 Cloudflare 대시보드의 24시간 값이다.

| 항목 | 값 | 비고 |
|---|---|---|
| 항목 쓰기 | 56건 | 서버가 받아들인 쓰기 |
| D1 행 쓰기 | 129행 | 쓰기 한 건당 약 2.3행. 설계 때의 추정은 3행 |
| D1 행 읽기 | 974행 | 쿼리 149회 |
| 항목 크기 | 평균 13 KB, 최대 38 KB | 압축·암호화 후 base64 |
| 공간 사용량 | 한도 5 MB 의 6% | |
| 데이터베이스 크기 | 381 kB | |
| 하루 쓰기 | 한도 300 의 19% | 56건 |

### 용량 계산

공간 한 개의 하루 쓰기가 한도(300건)까지 차고 공간이 60개 모두 그렇다고 가정한다.

```
60 공간 × 2.3 행/건 × 300 건 = 41,400 행/일   (무료 한도 100,000 행의 약 41%)
```

공간이 전부 찬 최악의 경우에도 하루 쓰기 한도의 절반을 넘지 않는다. 읽기는 시험에서 하루 974행이었고, 쓰기보다 한도가 50배 넉넉하다(500만 행).

주의:

- 시험은 공간 1개, 약 하루 분량이다. 공간이 늘면 풀 요청(폴링 3분 간격)이 늘어 읽기 행과 Workers 요청이 늘어난다. 이 증가는 측정하지 않았다.
- 쓰기당 2.3행은 이 시험의 평균이다. 새 항목 생성이나 정리 실행(쓰기 요청의 약 5%)이 행 수에 주는 영향은 따로 측정하지 않았다.

## 한 Worker 로 여러 앱 운영

`ALLOWED_APPS` 에 앱 식별자를 쉼표로 나열한다.

```toml
ALLOWED_APPS = "app-a,app-b"
```

- 목록에 없는 앱은 새 공간을 만들 수 없다(403). 이미 만든 공간은 목록을 바꿔도 계속 동작한다.
- 초대 코드는 모든 앱이 함께 쓴다.
- `MAX_SPACES` 는 서버 전체의 공간 수다. 앱별로 나누지 않는다.
- 한도 값(`MAX_ITEM_BYTES` 등)도 앱별로 나누지 않는다.
- 공간은 appId 를 넣어 파생하므로, 같은 동기화 키를 두 앱에 입력해도 서로 다른 공간이다. 이미 있는 공간에 다른 appId 로 접근하면 401 이다.

## 사용량 점검 쿼리

읽기 전용 `SELECT` 다. 서버 폴더에서 실행한다. 쿼리는 D1 의 읽기 행을 소비하므로 필요할 때만 실행한다.

```
npx wrangler d1 execute <db-name> --remote --command "<쿼리>"
```

공간별 항목 수와 용량(공간 식별자는 앞 8자만 본다):

```sql
SELECT substr(space_id, 1, 8) AS space, app_id, item_count, bytes_used,
       ROUND(bytes_used * 100.0 / 5242880, 1) AS used_pct, day, day_writes, seq, purged_seq
FROM spaces ORDER BY bytes_used DESC;
```

`5242880` 은 `MAX_SPACE_BYTES` 를 바꿨다면 그 값으로 고친다. `day_writes` 는 `day`(UTC 날짜)의 쓰기 수다.

공간별 삭제 항목 비율:

```sql
SELECT substr(space_id, 1, 8) AS space, COUNT(*) AS total, SUM(deleted) AS deleted,
       ROUND(SUM(deleted) * 100.0 / COUNT(*), 1) AS deleted_pct
FROM items GROUP BY space_id ORDER BY deleted_pct DESC;
```

삭제 항목이 많이 남아 있다면 보관 기간이 지나기를 기다리는 중이거나, 정리가 아직 실행되지 않은 것이다. 정리는 쓰기 요청의 약 5% 에서만 실행된다.

rev 분포(dirty 루프 점검):

```sql
SELECT rev, COUNT(*) AS items FROM items GROUP BY rev ORDER BY rev DESC LIMIT 10;
```

```sql
SELECT substr(space_id, 1, 8) AS space, substr(item_id, 1, 10) AS item, rev, deleted
FROM items ORDER BY rev DESC LIMIT 10;
```

사용자가 항목을 고친 횟수보다 rev 가 훨씬 높은 항목이 있으면 의심한다. 어댑터의 `apply` 와 `listLocal` 이 일치하지 않아 같은 항목이 계속 다시 올라가는 상태다. 이 상태에서는 하루 쓰기 한도가 빠르게 닳는다. 확인과 수리는 [ADAPTER-GUIDE.md](ADAPTER-GUIDE.md) 의 apply 규칙을 따른다.

## 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| 401 `unauthorized` | 동기화 키가 이 공간의 키와 다르다. appId 가 이 공간을 만든 값과 다르다. 요청 헤더 형식이 틀렸다 | 키를 다시 입력한다. 앱의 appId 설정이 바뀌지 않았는지 확인한다 |
| 403 `forbidden` | 초대 코드가 틀렸다. `INVITE_CODE` 가 설정되지 않았다. `ALLOWED_APPS` 에 appId 가 없다. 공간 수가 `MAX_SPACES` 에 닿았다 | `npx wrangler secret put INVITE_CODE` 를 다시 실행하고 `wrangler.toml` 의 `ALLOWED_APPS`·`MAX_SPACES` 를 확인한다 |
| 413 `body_too_large` | 요청이 `MAX_BODY_BYTES` 를 넘거나 `push` 가 20개를 넘는다 | 코어는 요청을 나눠 보내므로 대개 재시도로 해결된다. 계속되면 직접 만든 클라이언트의 분할을 확인한다 |
| 422 `item_too_large` | 항목 하나가 `MAX_ITEM_BYTES` 를 넘는다 | 항목을 줄이거나 나눈다. 줄이면 자동으로 올라간다 |
| 422 `item_limit` | 항목 수가 `MAX_ITEMS_PER_SPACE` 를 넘는다 | 쓰지 않는 항목을 지우거나 값을 올리고 재배포한다 |
| 422 `space_full` | 공간 용량이 `MAX_SPACE_BYTES` 를 넘는다 | 쓰지 않는 항목을 지우거나 값을 올리고 재배포한다 |
| 429 `daily_write_limit` | 공간의 하루 쓰기가 `MAX_DAILY_WRITES` 에 닿았다 | 다음 00:00 UTC 이후 자동으로 이어진다. 항목은 기기에 남는다. 자주 닿으면 rev 분포로 dirty 루프를 먼저 의심하고, 아니면 값을 올린다 |
| 503 `unavailable` | D1 이나 서버가 잠시 응답하지 않는다. 스키마를 적용하지 않았을 때도 난다 | 코어가 30초부터 늘려 가며 재시도한다. 계속되면 원격 DB 에 `schema.sql` 을 적용했는지 확인한다 |
| 523 | 처음 배포 직후 주소가 준비되지 않았다 | 1분 뒤 다시 시도한다 |
| 브라우저에 CORS 오류 | Worker 주소가 틀렸거나 Worker 가 응답하지 못했다 | 주소 끝의 오타를 확인하고 `/v1/health` 가 `{"ok":true}` 로 열리는지 본다 |
| 오래 쓰지 않은 기기가 "서버에 없는 항목" 을 묻는다 | 보관 기간(`TOMBSTONE_DAYS`)을 넘겨 서버가 삭제 기록을 정리했다 | 서버에 올릴지 이 기기에서 지울지 고른다. 지우기는 되돌릴 수 없다 |
| 항목이 한꺼번에 사라져 보여 멈춘다(대량 삭제 가드) | 저장소를 읽지 못했거나 실제로 많이 지웠다 | 의도한 삭제가 아니면 "서버 사본으로 되돌리기"를 고른다 |
| 같은 항목의 rev 가 계속 오른다 | 어댑터의 `apply` 와 `listLocal` 이 어긋나 dirty 루프가 돈다 | 어댑터 왕복 시험을 추가한다. 가공해서 저장하는 필드를 찾는다 |
| `file://` 로 연 HTML 에서 동작이 이상하다 | 브라우저마다 `file://` 페이지의 요청과 저장 방식이 다르다 | 이 환경의 동작은 확인하지 않았다. HTTPS 로 연 페이지에서 시도한다 |
| 동기화 키를 잃었다 | 서버가 키를 모른다 | 복구할 수 없다. 연결된 다른 기기의 설정 화면에서 키를 복사한다. 모든 기기에서 잃었다면 새 키로 새 공간을 시작해야 하고, 이전 공간의 데이터는 읽을 수 없다 |
| 초대 코드를 바꿨다 | 이미 만든 공간은 초대 코드와 무관하다 | 기존 공간은 계속 동작한다. 새 공간을 만들 때만 새 코드를 입력한다 |
