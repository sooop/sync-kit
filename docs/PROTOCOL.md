# 와이어 프로토콜

서버는 경로 두 개를 제공한다. 동기화는 `POST /v1/sync` 한 곳에서 풀과 푸시를 함께 처리한다. 형식의 정의는 `core/src/protocol.ts`, 동작의 정의는 `server/src/handler.ts` 다.

| 경로 | 메서드 | 응답 |
|---|---|---|
| `/v1/sync` | `POST` | 동기화. 아래에 설명한다 |
| `/v1/health` | `GET`, `HEAD` | `200 {"ok":true}`. 인증이 없다 |
| 위 두 경로 | `OPTIONS` | `204`. CORS 사전 요청 |
| 그 밖의 경로 | 모두 | `404 {"error":"not_found"}` |
| 허용되지 않는 메서드 | | `405 {"error":"method_not_allowed"}` |

모든 응답은 `Content-Type: application/json`, `Cache-Control: no-store` 와 CORS 헤더(`Access-Control-Allow-Origin: *`)를 가진다. 허용 요청 헤더는 `X-App-Id`, `X-Space-Id`, `Authorization`, `X-Invite-Code`, `Content-Type` 이다. 쿠키는 쓰지 않는다.

## 요청

```
POST {Worker 주소}/v1/sync
X-App-Id: notes-demo
X-Space-Id: <공간 식별자, hex 64자>
Authorization: Bearer <인증 토큰, hex 64자>
X-Invite-Code: <초대 코드>            ← 새 공간을 만드는 첫 요청에만
Content-Type: application/json

{ "cursor": 0, "push": [ { "id": "…", "baseRev": 0, "deleted": false, "blob": "…" } ] }
```

| 헤더 | 형식 | 값 |
|---|---|---|
| `X-App-Id` | `^[a-z0-9-]{1,32}$` | 앱 식별자 |
| `X-Space-Id` | `^[A-Za-z0-9_-]{1,128}$` | `hex(SHA-256("space:" + appId + ":" + 키))` |
| `Authorization` | `Bearer ` 다음에 한 글자 이상 | `hex(SHA-256("auth:" + appId + ":" + 키))` |
| `X-Invite-Code` | 임의 문자열 | 공간이 아직 없을 때만 읽는다 |

본문 필드:

| 필드 | 형식 | 설명 |
|---|---|---|
| `cursor` | 0 이상 정수. 생략하면 0 | 마지막으로 받은 `seq` |
| `push` | 배열. 생략하면 빈 배열 | 올릴 항목. 최대 20개 |
| `push[].id` | `^[A-Za-z0-9_-]{1,64}$` | 항목 id |
| `push[].baseRev` | 0 이상 정수 | 이 변경의 바탕이 된 서버 rev. 새 항목은 0 |
| `push[].deleted` | boolean | 삭제 여부 |
| `push[].blob` | 문자열 | 암호화된 평문. 삭제 항목도 필드는 필요하지만 서버가 비워서 저장한다 |

## 응답 (200)

```json
{
  "cursor": 12,
  "hasMore": false,
  "accepted":  [ { "id": "…", "rev": 3 } ],
  "conflicts": [ { "id": "…", "rev": 5, "deleted": false, "blob": "…" } ],
  "changes":   [ { "id": "…", "rev": 4, "deleted": false, "blob": "…" } ],
  "usage":     { "items": 41, "bytes": 530112, "dailyWrites": 19 },
  "resyncRequired": true
}
```

| 필드 | 설명 |
|---|---|
| `cursor` | 다음 요청에 보낼 커서 |
| `hasMore` | 참이면 `changes` 가 끝이 아니다. 같은 요청을 `cursor` 만 바꿔 다시 보낸다 |
| `accepted` | 서버가 쓴 항목과 새 rev. 요청의 `push` 순서와 같다 |
| `conflicts` | `baseRev` 가 서버 rev 와 달라 쓰지 않은 항목의 서버 현재 사본 |
| `changes` | `cursor` 이후 바뀐 항목. `seq` 오름차순 |
| `usage` | 이 공간의 삭제되지 않은 항목 수, blob 길이 합계, 오늘(UTC) 쓴 항목 수 |
| `resyncRequired` | 있을 때만 `true`. 보관 기간이 지나 정리된 삭제를 놓쳤을 수 있다 |

`changes` 에는 이번 요청에서 올린 항목도 들어간다. 클라이언트는 이미 아는 rev 와 같으면 건너뛴다.

## 오류

본문은 `{"error": "<코드>"}` 이다.

| 상태 | 코드 | 조건 |
|---|---|---|
| 400 | `bad_request` | 본문이 JSON 이 아니거나 객체가 아니다. `cursor` 가 0 이상 정수가 아니다. `push` 가 배열이 아니다. `push` 항목의 형식이 틀렸다 |
| 401 | `unauthorized` | `X-App-Id`·`X-Space-Id`·`Authorization` 헤더가 없거나 형식이 틀렸다. 이미 있는 공간인데 토큰이 맞지 않는다. 이미 있는 공간인데 appId 가 다르다 |
| 403 | `forbidden` | 공간이 없는데 초대 코드가 없거나 틀렸다(또는 서버에 `INVITE_CODE` 가 없다). 공간이 없는데 appId 가 `ALLOWED_APPS` 에 없다. 새 공간을 만들 수 없을 만큼 공간 수가 `MAX_SPACES` 에 닿았다 |
| 413 | `body_too_large` | `Content-Length` 또는 실제 본문이 `MAX_BODY_BYTES` 를 넘는다. `push` 가 20개를 넘는다 |
| 422 | `item_too_large` | `push` 의 항목 하나의 `blob` 길이가 `MAX_ITEM_BYTES` 를 넘는다. 삭제 항목도 검사한다 |
| 422 | `item_limit` | 쓰고 나면 삭제되지 않은 항목 수가 `MAX_ITEMS_PER_SPACE` 를 넘는다 |
| 422 | `space_full` | 쓰고 나면 blob 길이 합계가 `MAX_SPACE_BYTES` 를 넘는다 |
| 429 | `daily_write_limit` | 오늘 쓴 항목 수와 이번 요청의 쓰기 수의 합이 `MAX_DAILY_WRITES` 를 넘는다 |
| 503 | `unavailable` | D1 등 서버 내부 오류. `Retry-After: 10` 헤더가 붙는다 |
| 404, 405 | `not_found`, `method_not_allowed` | 경로·메서드 오류. 클라이언트 코어는 이 코드를 `unknown` 으로 다룬다 |

서버는 `unavailable` 응답에 내부 예외의 내용을 싣지 않는다.

## 요청 처리 순서

서버는 다음 순서로 판정한다. 앞 단계에서 걸리면 뒤 단계는 실행하지 않는다.

1. 헤더 형식 검사(401)
2. `Content-Length` 검사(413)
3. 공간 조회. 없으면 초대 코드와 `ALLOWED_APPS` 를 검사하고(403), 공간 수가 `MAX_SPACES` 미만일 때만 공간을 만든다. 공간은 이 단계에서 만들어지므로, 뒤 단계에서 400 이 나도 공간은 남는다
4. 기존 공간의 appId·토큰 검사(401). 토큰은 SHA-256 해시를 상수 시간으로 비교한다
5. 본문 읽기와 검사(413, 400)
6. `push` 항목 크기 검사(422 `item_too_large`)
7. 항목별 판정과 한도 검사(422 `item_limit`·`space_full`, 429)
8. 쓰기 한 번(D1 배치)
9. 변경분 읽기

한도 검사(7)는 요청 단위다. 하나라도 걸리면 이 요청의 `push` 는 하나도 쓰지 않는다. 쓸 항목이 하나도 없으면(충돌만 있거나 `push` 가 비었으면) 쓰기 한도 검사와 D1 쓰기를 건너뛴다.

## 항목별 쓰기 규칙

| 상황 | 결과 |
|---|---|
| 서버에 항목이 없고 `baseRev` 가 0 | 새로 만든다. rev 1. `accepted` |
| 서버에 항목이 없고 `baseRev` 가 0 보다 크다 | 쓰지 않는다. `conflicts` 에 `{ "id": …, "rev": 0, "deleted": true, "blob": "" }` |
| 서버 rev 와 `baseRev` 가 같다 | 쓴다. rev + 1. `accepted` |
| 서버 rev 와 `baseRev` 가 다르다(큰 경우와 작은 경우 모두) | 쓰지 않는다. `conflicts` 에 서버의 현재 사본 |
| 같은 요청 안에서 같은 id 가 반복된다 | 처음 것만 처리하고 나머지는 버린다 |

- 삭제 항목(`deleted: true`)은 `blob` 을 빈 문자열로 저장하고, 이후 `changes`·`conflicts` 에서도 `blob` 이 `""` 로 돌아온다. 삭제 항목의 크기는 0 으로 센다.
- 서버에 없는 항목에 `deleted: true` 와 `baseRev` 0 을 보내면 삭제 항목이 새로 만들어진다.
- 항목 수는 삭제되지 않은 항목만 센다. 삭제 항목을 되살리거나 새로 만들면 늘고, 삭제하면 준다.
- 쓰기 한 건마다 공간의 `seq` 가 1 오르고, 그 값이 항목의 `seq` 가 된다. 하루 쓰기 수(`dailyWrites`)는 UTC 날짜가 바뀌면 0 으로 돌아간다.

## 풀 규칙

`cursor` 보다 큰 `seq` 의 항목을 `seq` 오름차순으로 돌려준다.

- 한 응답의 `changes` 는 최대 50개(`PULL_MAX_ITEMS`)이고 blob 길이 합계가 262,144(`PULL_MAX_BYTES`) 이하가 되게 자른다.
- 첫 항목은 크기가 상한을 넘어도 항상 포함한다. 그래야 큰 항목 하나가 풀을 막지 않는다.
- 남은 변경이 있으면 `hasMore: true` 이고 `cursor` 는 응답의 마지막 항목의 `seq` 다.
- 남은 변경이 없으면 `hasMore: false` 이고 `cursor` 는 공간의 현재 `seq`(이번 요청의 쓰기 포함)다.
- 요청의 `cursor` 가 공간의 `seq` 보다 크면 `changes` 는 비고 `cursor` 는 공간의 `seq` 로 내려온다.

## resyncRequired

요청의 `cursor` 가 0 보다 크고 공간의 `purged_seq` 보다 작으면 서버는 `resyncRequired: true` 를 응답에 넣는다. 이때 서버는

- `cursor` 를 0 으로 보고 변경분을 돌려준다.
- `push` 를 무시한다. 항목을 쓰지 않으므로 `accepted` 와 `conflicts` 는 비어 있다. `push` 가 20개를 넘는지만 검사하고, 항목의 형식은 검사하지 않는다.

`cursor` 가 `purged_seq` 와 같으면 해당하지 않는다. 클라이언트는 응답을 모두 받은 뒤 서버에 없는 로컬 항목을 어떻게 할지 정하고, 그 뒤에 `push` 를 다시 보낸다. 흐름은 [ARCHITECTURE.md](ARCHITECTURE.md) 의 삭제와 보관 기간에 있다.

## 삭제 항목의 정리

쓰기가 있었던 요청의 약 5% 에서, 같은 D1 배치 안에서 정리를 실행한다.

1. `purged_seq` 를 `max(현재 값, 정리 대상의 최대 seq)` 로 올린다.
2. `updated_at` 이 `TOMBSTONE_DAYS` 보다 오래된 삭제 항목의 행을 지운다.

정리 대상은 삭제 항목뿐이다. 정리는 쓰기 요청에 얹혀 실행되므로 쓰기가 없으면 일어나지 않는다.
