// @vitest-environment node
// sync-kit 자체 통합: 실제 서버 핸들러(+D1 shim) · 실제 키·코덱·전송·엔진 · examples/memory-adapter 를 두 기기 시나리오로 연결한다.
// (참조 구조: md-works tests/sync/integration.test.ts. md-works 어댑터 대신 메모리 어댑터를 쓴다)
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCodec, createMemoryMetaStore, createSyncEngine, createTransport, deriveKeys, generateSyncKey,
  type LocalItem, type SyncAdapter,
} from '../core/src/index.ts';
import { commentItemId, noteItemId } from '../examples/memory-adapter/adapter.ts';
import {
  APP_ID, DAY, INVITE, URL_BASE, converge, expectQuiet, makeDevice, makeServer, metaRevs, ok, snapshot, sortedLocal,
  type Device,
} from './harness.ts';

const titleOf = (d: Device, noteId: string) => d.handle.notes().find((n) => n.id === noteId)?.title;
const noteIdOf = (d: Device, title: string) => d.handle.notes().find((n) => n.title === title)!.id;
const NAME_RE = /^동기화 전\(\d{4}-\d{2}-\d{2}\)$/;
const rnd = (n: number) => randomBytes(n).toString('hex'); // 압축이 거의 안 되는 본문

describe('(a) 메모·댓글 전달과 로컬 id 연결', () => {
  it('A 의 메모(폴더형 제목)와 댓글이 B 에 도착하고 댓글이 B 의 로컬 id 로 부모에 연결된다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    // B 가 먼저 메모 2개를 가져 로컬 id 가 A 와 어긋나게 한다(같은 'note-3' 이 서로 다른 메모를 가리킨다)
    B.handle.put({ title: 'Zeta', body: 'z', updatedAt: 1 });
    B.handle.put({ title: 'Eta', body: 'e', updatedAt: 1 });

    const alpha = A.handle.put({ title: 'Projects/Alpha', body: '# 알파\r\n본문  \r\n끝 공백  ', updatedAt: 100 });
    const deep = A.handle.put({ title: 'Projects/Beta/Deep', body: '깊은 폴더', updatedAt: 110 });
    const plain = A.handle.put({ title: 'Plain', body: '', updatedAt: 120 });
    A.handle.putComment({ id: 'c1', noteId: alpha.id, text: '알파 댓글 1', updatedAt: 130 });
    A.handle.putComment({ id: 'c2', noteId: alpha.id, text: '알파 댓글 2', updatedAt: 131 });
    A.handle.putComment({ id: 'c3', noteId: deep.id, text: '깊은 곳 댓글', updatedAt: 132 });

    await ok(A);
    await ok(B);

    expect(B.handle.notes().map((n) => n.title).sort()).toEqual(['Eta', 'Plain', 'Projects/Alpha', 'Projects/Beta/Deep', 'Zeta']);
    expect(B.handle.notes().find((n) => n.title === 'Projects/Alpha')!.body).toBe('# 알파\r\n본문  \r\n끝 공백  '); // 가공 없이 그대로
    expect(B.handle.notes().find((n) => n.title === 'Plain')!.body).toBe('');
    // 기기마다 로컬 id 가 다르다
    expect(noteIdOf(B, 'Projects/Alpha')).not.toBe(alpha.id);
    expect(noteIdOf(B, 'Projects/Beta/Deep')).not.toBe(deep.id);
    expect(noteIdOf(B, 'Plain')).not.toBe(plain.id);
    // 댓글은 B 의 로컬 id 로 부모에 연결된다
    const cs = B.handle.comments().sort((x, y) => x.id.localeCompare(y.id));
    expect(cs.map((c) => [c.id, c.text, titleOf(B, c.noteId)])).toEqual([
      ['c1', '알파 댓글 1', 'Projects/Alpha'],
      ['c2', '알파 댓글 2', 'Projects/Alpha'],
      ['c3', '깊은 곳 댓글', 'Projects/Beta/Deep'],
    ]);
    expect(cs[0].noteId).toBe(noteIdOf(B, 'Projects/Alpha'));
    expect(B.handle.deferred).toEqual([]);

    // B 가 가진 메모도 A 로 간다. 이후 양쪽 스냅샷이 같다
    await converge(server, [A, B]);
    expect(snapshot(A)).toEqual(snapshot(B));
    expect(A.handle.notes()).toHaveLength(5);

    // 서버에 올라간 항목 id 가 어댑터 id 규칙과 같다
    const ids = server.sql('SELECT item_id FROM items').map((r) => r.item_id).sort();
    expect(ids).toEqual([
      ...['Projects/Alpha', 'Projects/Beta/Deep', 'Plain', 'Zeta', 'Eta'].map(noteItemId),
      ...['c1', 'c2', 'c3'].map(commentItemId),
    ].sort());
  });
});

describe('(b) 수정 전파', () => {
  it('B 가 메모와 댓글을 고치면 A 에 반영된다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    const n = A.handle.put({ title: 'Work/Plan', body: '처음', updatedAt: 100 });
    A.handle.putComment({ id: 'c1', noteId: n.id, text: '처음 댓글', updatedAt: 101 });
    await converge(server, [A, B]);

    B.handle.put({ title: 'Work/Plan', body: 'B 가 고침', updatedAt: 5000 });
    B.handle.putComment({ id: 'c1', noteId: noteIdOf(B, 'Work/Plan'), text: 'B 가 고친 댓글', updatedAt: 5001 });
    await ok(B, A);
    expect(A.handle.notes().map((x) => x.body)).toEqual(['B 가 고침']);
    expect(A.handle.comments().map((c) => [c.text, titleOf(A, c.noteId)])).toEqual([['B 가 고친 댓글', 'Work/Plan']]);
    await expectQuiet(server, A, B);
  });
});

describe('(c) 오프라인 동시 수정 충돌', () => {
  async function pair() {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    A.handle.put({ title: 'Docs/공유', body: '처음', updatedAt: 100 });
    await ok(A, B);
    // 두 기기가 각자 오프라인(sync 를 부르지 않음)에서 같은 메모를 고친다
    A.handle.put({ title: 'Docs/공유', body: 'A 의 수정', updatedAt: 1000 });
    B.handle.put({ title: 'Docs/공유', body: 'B 의 수정', updatedAt: 2000 }); // 더 늦다 → B 승
    return { server, A, B };
  }

  it('늦은 쪽(B, 이길 쪽)이 먼저 올리면: A 가 충돌을 감지해 진 A 본문을 이력에 남기고 B 본문을 받는다', async () => {
    const { server, A, B } = await pair();
    await ok(B);
    await ok(A);
    await ok(B);
    expect(A.handle.notes()[0].body).toBe('B 의 수정');
    expect(B.handle.notes()[0].body).toBe('B 의 수정');
    expect(A.handle.history).toHaveLength(1);
    expect(A.handle.history[0]).toMatchObject({ body: 'A 의 수정', title: 'Docs/공유' });
    expect(A.handle.history[0].label).toMatch(NAME_RE);
    expect(B.handle.history).toEqual([]); // 이긴 B 는 이력이 없다
    await expectQuiet(server, A, B); // 반복해도 쓰기·rev·이력 변화 없음
  });

  it('오래된 쪽(A)이 먼저 올리면: B 는 로컬이 이겨 서버(A) 사본을 이력에 남기고 올리며 한 값으로 수렴한다', async () => {
    const { server, A, B } = await pair();
    await ok(A);
    await ok(B);
    await ok(A);
    expect(A.handle.notes()[0].body).toBe('B 의 수정');
    expect(B.handle.notes()[0].body).toBe('B 의 수정');
    expect(B.handle.history).toHaveLength(1);
    expect(B.handle.history[0]).toMatchObject({ body: 'A 의 수정', title: 'Docs/공유' });
    expect(B.handle.history[0].label).toMatch(NAME_RE);
    expect(A.handle.history).toEqual([]);
    expect(server.sql("SELECT rev FROM items")).toEqual([{ rev: 3 }]); // 처음 · A · B
    await expectQuiet(server, A, B);
  });

  it('수렴 뒤 같은 항목을 다시 고쳐 반대 순서로 충돌시켜도 수렴하고 이력은 충돌당 하나다', async () => {
    const { server, A, B } = await pair();
    await ok(B); await ok(A); await ok(B);
    A.handle.put({ title: 'Docs/공유', body: 'A 2차(늦음)', updatedAt: 9000 });
    B.handle.put({ title: 'Docs/공유', body: 'B 2차(오래됨)', updatedAt: 8000 });
    await ok(A); await ok(B); await ok(A);
    expect(A.handle.notes()[0].body).toBe('A 2차(늦음)');
    expect(B.handle.notes()[0].body).toBe('A 2차(늦음)');
    expect(B.handle.history.map((h) => h.body)).toEqual(['B 2차(오래됨)']);
    expect(A.handle.history.map((h) => h.body)).toEqual(['A 의 수정']); // 1차에서 진 것 그대로
    await expectQuiet(server, A, B);
  });
});

describe('(d) 삭제', () => {
  it('메모 삭제가 전파되고 그 메모의 댓글도 정리된다(예제 어댑터: 삭제된 메모의 댓글은 동기화하지 않아 삭제로 올라간다)', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    const keep = A.handle.put({ title: 'Keep', body: '남음', updatedAt: 100 });
    const gone = A.handle.put({ title: 'F/Gone', body: '지워짐', updatedAt: 100 });
    A.handle.putComment({ id: 'cg', noteId: gone.id, text: '지워질 댓글', updatedAt: 101 });
    A.handle.putComment({ id: 'ck', noteId: keep.id, text: '남을 댓글', updatedAt: 101 });
    await converge(server, [A, B]);
    expect(B.handle.comments()).toHaveLength(2);

    A.handle.remove(gone.id);
    await ok(A);
    // 서버의 삭제 항목은 빈 blob
    expect(server.sql(`SELECT deleted, blob, size FROM items WHERE item_id = '${noteItemId('F/Gone')}'`)).toEqual([{ deleted: 1, blob: '', size: 0 }]);
    expect(server.sql(`SELECT deleted, blob FROM items WHERE item_id = '${commentItemId('cg')}'`)).toEqual([{ deleted: 1, blob: '' }]);
    await ok(B);
    expect(B.handle.notes().map((n) => n.title)).toEqual(['Keep']);
    expect(B.handle.comments().map((c) => c.id)).toEqual(['ck']);
    expect(snapshot(B)).toEqual(snapshot(A));
    await expectQuiet(server, A, B);
  });

  it('삭제 vs 수정 충돌(현재 설계): 서버 삭제 사본의 updatedAt 은 0 으로 취급되어 로컬 수정이 이겨 메모가 되살아난다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    const n = A.handle.put({ title: 'Doomed', body: '원본', updatedAt: 100 });
    await converge(server, [A, B]);

    A.handle.remove(n.id);
    await ok(A); // 서버에 삭제(빈 blob)가 올라간다
    expect(server.sql("SELECT deleted FROM items")).toEqual([{ deleted: 1 }]);
    // B 는 오프라인에서 수정. updatedAt 이 A 의 삭제 시각보다 훨씬 과거(= 삭제가 더 늦었다)여도 서버 삭제 사본은 updatedAt 0 이라 B 가 이긴다
    B.handle.put({ title: 'Doomed', body: 'B 의 수정', updatedAt: 150 });
    await ok(B);
    expect(B.handle.notes().map((x) => x.body)).toEqual(['B 의 수정']);
    expect(B.handle.history).toEqual([]); // 삭제 사본은 남길 본문이 없다
    await converge(server, [A, B]);
    expect(A.handle.notes().map((x) => [x.title, x.body])).toEqual([['Doomed', 'B 의 수정']]); // 되살아남
    expect(snapshot(A)).toEqual(snapshot(B));
    expect(server.sql("SELECT deleted FROM items WHERE item_id = '" + noteItemId('Doomed') + "'")).toEqual([{ deleted: 0 }]);
    await expectQuiet(server, A, B);
  });
});

describe('(e) 변경 없는 sync 는 조용하다', () => {
  it('받기만 한 기기는 서버에 쓰지 않고, 연속 sync 에서 서버 쓰기·rev 변화가 없으며, apply 한 값과 listLocal 이 같다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    const a = A.handle.put({ title: 'A/메모1', body: '줄 끝 공백  \r\n\n\n', updatedAt: 100 });
    A.handle.put({ title: 'a/memo 2', body: '  앞 공백', updatedAt: 101 });
    A.handle.putComment({ id: 'c1', noteId: a.id, text: '댓글  ', updatedAt: 102 });
    await ok(A);

    const written = server.db.writes;
    await ok(B);
    expect(server.db.writes).toBe(written); // B 의 첫 sync 는 쓰기 0
    expect(B.dirtyCalls.n).toBe(0); // apply 는 앱 변경 알림을 올리지 않는다
    expect(await sortedLocal(B)).toEqual(await sortedLocal(A)); // apply 후 listLocal == 보낸 쪽 listLocal(해시 일치)
    expect(await metaRevs(B)).toEqual(await metaRevs(A));
    expect(server.sql('SELECT DISTINCT rev FROM items')).toEqual([{ rev: 1 }]);
    expect(B.handle.applyingLog.filter(Boolean).length).toBe(B.handle.applyingLog.filter((x) => !x).length); // setApplying 이 짝을 이룬다
    await expectQuiet(server, A, B);
  });
});

describe('(f) 평문 비노출', () => {
  it('D1 덤프에 제목·본문·댓글 문구·동기화 키가 없다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const n = A.handle.put({ title: '비밀폴더/비밀제목', body: '비밀본문 토큰 xyz123', updatedAt: 100 });
    A.handle.putComment({ id: 'c1', noteId: n.id, text: '비밀댓글 문구', updatedAt: 101 });
    await ok(A);
    const dump = server.db.dump();
    expect(dump.length).toBeGreaterThan(300);
    for (const secret of ['비밀폴더', '비밀제목', '비밀본문', 'xyz123', '비밀댓글', key, key.replace(/-/g, '')]) {
      expect(dump.includes(secret), secret).toBe(false);
    }
    // 서버가 가진 것은 항목 id(제목 해시)·blob·메타뿐이다
    expect(dump.includes(noteItemId('비밀폴더/비밀제목'))).toBe(true);
  });
});

describe('(g) 인증·허가', () => {
  it('같은 공간에 틀린 토큰을 보내면 401 → paused/unauthorized, 로컬은 그대로', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    A.handle.put({ title: 't', body: 'b', updatedAt: 1 });
    await ok(A);

    // 공간 id 는 A 와 같고 토큰·암호 키만 다른(= 틀린 동기화 키) 기기
    const wrong = await deriveKeys(generateSyncKey(), APP_ID);
    const handle = (await makeDevice(server, key)).handle;
    const engine = createSyncEngine({
      appId: APP_ID, config: { workerUrl: URL_BASE, syncKey: 'unused', inviteCode: INVITE },
      adapter: handle.adapter, meta: createMemoryMetaStore(), codec: createCodec(wrong.encKey),
      transport: createTransport({ workerUrl: URL_BASE, appId: APP_ID, spaceId: A.keys.spaceId, authToken: wrong.authToken }, server.fetch),
      autoSchedule: false,
    });
    await engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(401);
    expect(engine.status.phase).toBe('paused');
    expect(engine.status.lastError?.kind).toBe('unauthorized');
    expect(handle.notes()).toEqual([]);
    // 멈춘 뒤에는 자동 실행(markDirty 등)이 서버를 부르지 않는다(autoSchedule false 이므로 syncNow 만 부른다)
  });

  it('초대 코드 없는 새 공간은 403 → paused/forbidden, 공간이 만들어지지 않는다. 코드가 맞으면 첫 요청에만 코드를 보낸다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const D = await makeDevice(server, key, { invite: false });
    D.handle.put({ title: 'a', body: 'a', updatedAt: 1 });
    await D.engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(403);
    expect(D.engine.status.phase).toBe('paused');
    expect(D.engine.status.lastError?.kind).toBe('forbidden');
    expect(server.sql('SELECT * FROM spaces')).toEqual([]);

    const wrongInvite = await makeDevice(server, key, { invite: 'wrong-code' });
    await wrongInvite.engine.syncNow();
    expect(wrongInvite.engine.status.lastError?.kind).toBe('forbidden');
    expect(server.sql('SELECT * FROM spaces')).toEqual([]);

    const E = await makeDevice(server, key);
    E.handle.put({ title: 'a', body: 'a', updatedAt: 1 });
    await ok(E);
    await ok(E);
    expect(server.log.filter((x) => x.invite === INVITE && x.status === 200)).toHaveLength(1);
    expect(server.sql('SELECT * FROM spaces')).toHaveLength(1);
  });

  it('ALLOWED_APPS 에 없는 appId 는 초대 코드가 맞아도 403', async () => {
    const server = makeServer(); // ALLOWED_APPS = notes-demo
    const X = await makeDevice(server, generateSyncKey(), { appId: 'other-app' });
    X.handle.put({ title: 'a', body: 'a', updatedAt: 1 });
    await X.engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(403);
    expect(X.engine.status.phase).toBe('paused');
    expect(X.engine.status.lastError?.kind).toBe('forbidden');
    expect(server.sql('SELECT * FROM spaces')).toEqual([]);
  });

  it('토큰은 맞지만 암호 키가 다르면 crypto 오류이고 로컬 데이터를 건드리지 않는다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    A.handle.put({ title: 't', body: 'b', updatedAt: 1 });
    await ok(A);
    const other = await deriveKeys(generateSyncKey(), APP_ID);
    const handle = (await makeDevice(server, key)).handle;
    handle.put({ title: 'local', body: 'mine', updatedAt: 1 });
    const engine = createSyncEngine({
      appId: APP_ID, config: { workerUrl: URL_BASE, syncKey: key },
      adapter: handle.adapter, meta: createMemoryMetaStore(), codec: createCodec(other.encKey),
      transport: createTransport({ workerUrl: URL_BASE, appId: APP_ID, spaceId: A.keys.spaceId, authToken: A.keys.authToken }, server.fetch),
      autoSchedule: false,
    });
    await engine.syncNow();
    expect(engine.status.lastError?.kind).toBe('crypto');
    expect(handle.notes().map((n) => n.title)).toEqual(['local']);
  });
});

describe('(h) 한도(서버 연결 경로)', () => {
  it('항목 크기: 서버가 422 item_too_large 로 거절하면 그 항목만 oversize 로 남고 나머지는 올라간다(배치 분할)', async () => {
    const server = makeServer({ MAX_ITEM_BYTES: '600' });
    const A = await makeDevice(server, generateSyncKey());
    A.handle.put({ title: 'small1', body: 's1', updatedAt: 1 });
    A.handle.put({ title: 'small2', body: 's2', updatedAt: 1 });
    A.handle.put({ title: 'big/큰 메모', body: rnd(3000), updatedAt: 1 });
    A.handle.put({ title: 'small3', body: 's3', updatedAt: 1 });
    await A.engine.syncNow();
    expect(server.log.some((x) => x.status === 422)).toBe(true);
    expect(A.engine.status.oversize).toHaveLength(1);
    expect(A.engine.status.oversize[0]).toMatchObject({ id: noteItemId('big/큰 메모'), label: 'big/큰 메모' });
    expect(A.engine.status.oversize[0].bytes).toBeGreaterThan(600);
    expect(A.engine.status.lastError?.kind).toBe('item-too-large');
    expect(A.engine.status.phase).toBe('idle'); // 멈추지 않는다
    expect(server.sql('SELECT item_id FROM items').map((r) => r.item_id).sort()).toEqual(['small1', 'small2', 'small3'].map(noteItemId).sort());
    expect(A.handle.notes()).toHaveLength(4); // 로컬은 그대로

    // 작게 고치면 올라가고 oversize 가 비워진다
    A.handle.put({ title: 'big/큰 메모', body: '줄였다', updatedAt: 2 });
    await ok(A);
    expect(A.engine.status.oversize).toEqual([]);
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(4);
  });

  it('항목 수: 422 item_limit → phase error/lastError.kind item-limit, 서버에는 아무것도 쓰이지 않고 줄이면 다시 올라간다', async () => {
    const server = makeServer({ MAX_ITEMS_PER_SPACE: '3' });
    const A = await makeDevice(server, generateSyncKey());
    const ns = ['a', 'b', 'c', 'd', 'e'].map((t) => A.handle.put({ title: t, body: t, updatedAt: 1 }));
    await A.engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(422);
    expect(A.engine.status.phase).toBe('error');
    expect(A.engine.status.lastError?.kind).toBe('item-limit');
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
    for (const n of ns.slice(0, 3)) A.handle.remove(n.id);
    await ok(A);
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(2);
    expect(A.engine.status.usage?.items).toBe(2);
  });

  it('공간 용량: 422 space_full → kind space-full', async () => {
    const server = makeServer({ MAX_SPACE_BYTES: '1500' });
    const A = await makeDevice(server, generateSyncKey());
    for (let i = 0; i < 12; i++) A.handle.put({ title: `m${i}`, body: rnd(60), updatedAt: 1 });
    await A.engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(422);
    expect(A.engine.status.phase).toBe('error');
    expect(A.engine.status.lastError?.kind).toBe('space-full');
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
  });

  it('일일 쓰기 한도: 429 → rate-limited(retryAt = 다음 UTC 자정), 그날은 푸시하지 않고 다음 날 올린다', async () => {
    const server = makeServer({ MAX_DAILY_WRITES: '4' });
    const A = await makeDevice(server, generateSyncKey());
    for (const t of ['a', 'b', 'c']) A.handle.put({ title: t, body: t, updatedAt: 1 });
    await ok(A); // 3 건
    for (const t of ['d', 'e', 'f']) A.handle.put({ title: t, body: t, updatedAt: 1 });
    await A.engine.syncNow(); // 3 + 3 > 4
    expect(server.log.some((x) => x.status === 429)).toBe(true);
    expect(A.engine.status.phase).toBe('error');
    expect(A.engine.status.lastError?.kind).toBe('rate-limited');
    const retryAt = A.engine.status.lastError!.retryAt!;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(new Date(retryAt).getUTCHours()).toBe(0);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(DAY);
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(3);

    // 같은 날 다시 불러도 쓰기 요청을 보내지 않는다
    const before = server.log.length;
    await A.engine.syncNow();
    expect(server.log.slice(before).every((x) => x.req.push.length === 0)).toBe(true);
    expect(A.engine.status.lastError?.kind).toBe('rate-limited');

    // 서버·기기 시계를 하루 뒤로: 새 날이 되어 올라간다
    server.clockOffset = DAY + 3_600_000;
    A.clock.skew = DAY + 3_600_000;
    await ok(A);
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(6);
  });
});

describe('(i) 서버 정리(purge)와 resync', () => {
  async function setup() {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    A.handle.put({ title: '남는', body: 'keep', updatedAt: 100 });
    const g = A.handle.put({ title: '지워질/메모', body: 'to delete', updatedAt: 100 });
    await converge(server, [A, B]);
    // B 가 오프라인인 동안 A 가 메모를 지우고, 31일 뒤 정리가 돌게 한다
    A.handle.remove(g.id);
    await ok(A);
    server.clockOffset = 31 * DAY;
    server.random = 0; // 모든 쓰기 요청에서 정리
    A.handle.put({ title: '남는', body: 'keep 2', updatedAt: 200 });
    await ok(A);
    server.random = 1;
    server.clockOffset = 0;
    expect(server.sql('SELECT purged_seq FROM spaces')[0].purged_seq).toBeGreaterThan(0);
    expect(server.sql('SELECT * FROM items WHERE deleted = 1')).toEqual([]);
    return { server, A, B };
  }

  it('오래된 커서는 resyncRequired → orphans 를 묻고, upload 면 서버에 새 항목(rev 1)으로 올라간다', async () => {
    const { server, A, B } = await setup();
    await B.engine.syncNow();
    expect(server.log.at(-1)!.res?.resyncRequired).toBe(true);
    expect(server.log.some((x) => x.res?.resyncRequired)).toBe(true);
    expect(B.engine.status.resync?.orphans).toHaveLength(1);
    expect(B.engine.status.resync!.orphans[0]).toMatchObject({ id: noteItemId('지워질/메모'), kind: 'doc' });
    expect(B.engine.status.resync!.orphans[0].label).toContain('지워질/메모');
    expect(B.handle.notes().find((n) => n.title === '남는')!.body).toBe('keep 2'); // 받은 변경은 적용됐다
    await B.engine.resolveResync('upload');
    expect(B.engine.status.resync).toBeUndefined();
    expect(B.engine.status.lastError).toBeUndefined();
    expect(server.sql(`SELECT rev, deleted FROM items WHERE item_id = '${noteItemId('지워질/메모')}'`)).toEqual([{ rev: 1, deleted: 0 }]);
    await converge(server, [A, B]);
    expect(A.handle.notes().map((n) => n.title).sort()).toEqual(['남는', '지워질/메모']); // A 에서도 되살아남
    await expectQuiet(server, A, B);
  });

  it('delete 면 B 의 로컬에서만 지워지고 서버는 그대로다', async () => {
    const { server, A, B } = await setup();
    await B.engine.syncNow();
    expect(B.engine.status.resync?.orphans).toHaveLength(1);
    await B.engine.resolveResync('delete');
    expect(B.handle.removedLocal.map((i) => i.id)).toEqual([noteItemId('지워질/메모')]);
    expect(B.handle.notes().map((n) => n.title)).toEqual(['남는']);
    expect(server.sql(`SELECT * FROM items WHERE item_id = '${noteItemId('지워질/메모')}'`)).toEqual([]);
    expect(B.engine.status.lastError).toBeUndefined();
    await ok(A);
    expect(A.handle.notes().map((n) => n.title)).toEqual(['남는']);
    await expectQuiet(server, A, B);
  });
});

describe('(j) 서버 응답 규칙', () => {
  it('삭제 항목은 서버에 빈 blob 으로 저장되고 받는 쪽에서 updatedAt 0 의 삭제로 읽힌다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    const n = A.handle.put({ title: 'x/y', body: '본문', updatedAt: 100 });
    await converge(server, [A, B]);
    A.handle.remove(n.id);
    await ok(A);
    const row = server.sql(`SELECT rev, deleted, size, blob FROM items WHERE item_id = '${noteItemId('x/y')}'`);
    expect(row).toEqual([{ rev: 2, deleted: 1, size: 0, blob: '' }]);
    const pulled = server.log.flatMap((x) => x.res?.changes ?? []).filter((c) => c.deleted);
    expect(pulled.every((c) => c.blob === '')).toBe(true);
    await ok(B);
    expect(B.handle.notes()).toEqual([]);
    const del = B.handle.applied.find((i) => i.deleted && i.id === noteItemId('x/y'))!;
    expect(del).toMatchObject({ kind: 'doc', updatedAt: 0, data: null });
  });

  it('서버에 없는 항목을 baseRev>0 으로 올리면 rev 0 충돌 응답 → 엔진이 baseRev 0 으로 다시 올리고 로컬을 지우지 않는다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const n = A.handle.put({ title: '글', body: '첫', updatedAt: 100 });
    A.handle.putComment({ id: 'c1', noteId: n.id, text: '첫 댓글', updatedAt: 101 });
    await ok(A);
    server.db.sqlite.exec('DELETE FROM items'); // purged_seq 는 그대로 → resync 없이 '올린 적 있는데 서버에 없다'
    A.handle.put({ title: '글', body: '둘', updatedAt: 200 });
    A.handle.putComment({ id: 'c1', noteId: n.id, text: '둘 댓글', updatedAt: 201 });
    server.log.length = 0;
    await ok(A);
    const pushes = server.log.flatMap((x) => x.req.push.map((p) => p.baseRev));
    expect(pushes).toEqual([1, 1, 0, 0]); // 먼저 baseRev 1 → 충돌(rev 0) → baseRev 0 으로 재전송
    expect(server.log.flatMap((x) => x.res?.conflicts ?? [])).toEqual([
      { id: noteItemId('글'), rev: 0, deleted: true, blob: '' },
      { id: commentItemId('c1'), rev: 0, deleted: true, blob: '' },
    ]);
    expect(server.sql('SELECT rev, deleted FROM items')).toEqual([{ rev: 1, deleted: 0 }, { rev: 1, deleted: 0 }]);
    expect(A.handle.notes().map((x) => x.body)).toEqual(['둘']);
    expect(A.handle.comments().map((c) => c.text)).toEqual(['둘 댓글']);
    expect(A.handle.removedLocal).toEqual([]);
    await expectQuiet(server, A);
    const B = await makeDevice(server, key);
    await ok(B);
    expect(snapshot(B)).toEqual(snapshot(A));
  });

  for (const vars of [{ PULL_MAX_ITEMS: '5' }, { PULL_MAX_BYTES: '600' }] as Record<string, string>[]) {
    it(`풀 페이지 경계(${JSON.stringify(vars)}): hasMore 를 따라 빠짐·중복 없이 받고 커서가 공간 seq 에 도달한다`, async () => {
      const server = makeServer(vars);
      const key = generateSyncKey();
      const A = await makeDevice(server, key);
      const B = await makeDevice(server, key);
      const titles: string[] = [];
      for (let i = 0; i < 17; i++) { titles.push(`폴더/메모${i}`); A.handle.put({ title: `폴더/메모${i}`, body: `내용 ${i} ${rnd(8)}`, updatedAt: 100 + i }); }
      await ok(A);
      server.log.length = 0;
      await ok(B);
      const pulls = server.log.filter((x) => x.req.push.length === 0);
      expect(pulls.filter((x) => x.res!.hasMore).length).toBeGreaterThan(2);
      expect(pulls.at(-1)!.res!.hasMore).toBe(false);
      const cursors = pulls.map((x) => x.res!.cursor);
      expect(cursors).toEqual([...cursors].sort((x, y) => x - y));
      expect(pulls.at(-1)!.res!.cursor).toBe(server.sql('SELECT seq FROM spaces')[0].seq);
      const got = pulls.flatMap((x) => x.res!.changes.map((c) => c.id));
      expect(new Set(got).size).toBe(17);
      expect(got).toHaveLength(17);
      expect(B.handle.notes().map((n) => n.title).sort()).toEqual([...titles].sort());
      await expectQuiet(server, A, B);
    });
  }

  it('푸시 45건은 20건 단위로 나뉘고 양쪽이 같은 개수로 수렴한다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = await makeDevice(server, key);
    const B = await makeDevice(server, key);
    for (let i = 0; i < 45; i++) A.handle.put({ title: `m${i}`, body: `메모 ${i}`, updatedAt: 1 });
    await ok(A, B);
    expect(server.log.filter((x) => x.req.push.length > 0).map((x) => x.req.push.length)).toEqual([20, 20, 5]);
    expect(B.handle.notes()).toHaveLength(45);
    expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(45);
    await expectQuiet(server, A, B);
  });

  it('400 bad_request(깨진 본문·잘못된 cursor)는 paused 가 아니라 error 이고 다음 sync 가 정상 복구한다', async () => {
    const server = makeServer();
    const A = await makeDevice(server, generateSyncKey());
    A.handle.put({ title: '글', body: '본문', updatedAt: 100 });
    for (const bad of ['{깨진 json', '{"cursor":"x","push":[]}', '{"cursor":0,"push":"no"}', 'null']) {
      server.mangleBody = bad;
      await A.engine.syncNow();
      expect(server.log.at(-1)!.status, bad).toBe(400);
      expect(A.engine.status.phase, bad).toBe('error');
      expect(A.engine.status.lastError?.kind).toBe('unavailable');
      expect(A.engine.status.lastError?.message).toContain('400');
      expect(A.engine.status.lastError?.retryAt).toBeUndefined(); // 자동 재시도 대기 없음
      expect(A.handle.notes()).toHaveLength(1); // 로컬 무사
      // 항목은 쓰이지 않는다(공간 생성은 본문 검사보다 앞이라 일어날 수 있다)
      expect(server.sql('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
    }
    await ok(A);
    expect(server.sql('SELECT rev FROM items')).toEqual([{ rev: 1 }]);
  });
});

describe('(k) 한 Worker 의 두 앱 공간', () => {
  it('app-a·app-b 공간은 서로 격리되고 MAX_SPACES 를 공유한다', async () => {
    const server = makeServer({ ALLOWED_APPS: 'app-a, app-b', MAX_SPACES: '2' });
    const key = generateSyncKey(); // 같은 키여도 appId 가 다르면 공간·토큰·암호 키가 모두 다르다
    const a1 = await makeDevice(server, key, { appId: 'app-a' });
    const b1 = await makeDevice(server, key, { appId: 'app-b' });
    expect(a1.keys.spaceId).not.toBe(b1.keys.spaceId);
    a1.handle.put({ title: 'A앱 메모', body: 'a', updatedAt: 1 });
    b1.handle.put({ title: 'B앱 메모', body: 'b', updatedAt: 1 });
    await ok(a1, b1);
    expect(server.sql('SELECT app_id FROM spaces ORDER BY app_id')).toEqual([{ app_id: 'app-a' }, { app_id: 'app-b' }]);

    const a2 = await makeDevice(server, key, { appId: 'app-a' });
    const b2 = await makeDevice(server, key, { appId: 'app-b' });
    await ok(a2, b2);
    expect(a2.handle.notes().map((n) => n.title)).toEqual(['A앱 메모']);
    expect(b2.handle.notes().map((n) => n.title)).toEqual(['B앱 메모']);
    expect(server.sql('SELECT space_id, COUNT(*) AS n FROM items GROUP BY space_id').map((r) => r.n)).toEqual([1, 1]);

    // app-a 의 공간 id·토큰을 app-b 헤더로 보내면 401
    const cross = createTransport({ workerUrl: URL_BASE, appId: 'app-b', spaceId: a1.keys.spaceId, authToken: a1.keys.authToken }, server.fetch);
    await expect(cross.sync({ cursor: 0, push: [] })).rejects.toMatchObject({ status: 401 });

    // 세 번째 공간(다른 키)은 앱이 허용돼 있어도 MAX_SPACES(2) 를 공유하므로 403
    const third = await makeDevice(server, generateSyncKey(), { appId: 'app-a' });
    third.handle.put({ title: 'c', body: 'c', updatedAt: 1 });
    await third.engine.syncNow();
    expect(server.log.at(-1)!.status).toBe(403);
    expect(third.engine.status.lastError?.kind).toBe('forbidden');
    expect(server.sql('SELECT COUNT(*) AS n FROM spaces')[0].n).toBe(2);
    // 기존 공간은 계속 동작한다
    a2.handle.put({ title: 'A앱 두번째', body: 'a2', updatedAt: 2 });
    await ok(a2, a1);
    expect(a1.handle.notes()).toHaveLength(2);
    expect(b1.handle.notes()).toHaveLength(1);
  });
});

describe('(l) kindOfId', () => {
  // 앱 고유 종류('memo','remark')와 접두사 규칙이 없는 id. 삭제 항목은 blob 이 비어 있어 종류를 id 로만 알 수 있다
  function kvAdapter(withKindOfId: boolean) {
    const store = new Map<string, LocalItem>();
    const applied: LocalItem[] = [];
    const adapter: SyncAdapter = {
      async listLocal() { return [...store.values()].map((i) => structuredClone(i)); },
      async apply(item) {
        applied.push(structuredClone(item));
        if (item.deleted) store.delete(item.id); else store.set(item.id, structuredClone(item));
        return 'applied';
      },
      async preserveLoser() {},
      async removeLocal(item) { store.delete(item.id); },
      ...(withKindOfId ? { kindOfId: (id: string) => (id.startsWith('memo_') ? 'memo' : id.startsWith('rmk_') ? 'remark' : undefined) } : {}),
    };
    return { adapter, store, applied };
  }
  const put = (kv: ReturnType<typeof kvAdapter>, id: string, kind: string, text: string) =>
    kv.store.set(id, { id, kind, updatedAt: 10, deleted: false, data: { text } });
  async function engineFor(server: ReturnType<typeof makeServer>, key: string, kv: ReturnType<typeof kvAdapter>) {
    const keys = await deriveKeys(key, APP_ID);
    return createSyncEngine({
      appId: APP_ID, config: { workerUrl: URL_BASE, syncKey: key, inviteCode: INVITE },
      adapter: kv.adapter, meta: createMemoryMetaStore(), codec: createCodec(keys.encKey),
      transport: createTransport({ workerUrl: URL_BASE, appId: APP_ID, spaceId: keys.spaceId, authToken: keys.authToken }, server.fetch),
      autoSchedule: false,
    });
  }

  it('kindOfId 가 있는 어댑터는 삭제 항목(빈 blob)을 올바른 kind 로 받는다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = kvAdapter(true), B = kvAdapter(true);
    const eA = await engineFor(server, key, A), eB = await engineFor(server, key, B);
    put(A, 'memo_1', 'memo', '메모'); put(A, 'rmk_1', 'remark', '덧글');
    await eA.syncNow(); await eB.syncNow();
    expect(B.applied.map((i) => [i.id, i.kind]).sort()).toEqual([['memo_1', 'memo'], ['rmk_1', 'remark']]);

    A.store.delete('memo_1'); A.store.delete('rmk_1');
    await eA.syncNow();
    expect(server.sql('SELECT deleted, blob FROM items')).toEqual([{ deleted: 1, blob: '' }, { deleted: 1, blob: '' }]);
    await eB.syncNow();
    expect(eB.status.lastError).toBeUndefined();
    const dels = B.applied.filter((i) => i.deleted).map((i) => [i.id, i.kind]).sort();
    expect(dels).toEqual([['memo_1', 'memo'], ['rmk_1', 'remark']]); // 어댑터 경로(kind)가 맞다
    expect(B.store.size).toBe(0);
  });

  it('kindOfId 가 없는 어댑터: 내용을 받은 적 있는 항목의 삭제는 기억한 kind 로, 처음 보는 삭제는 어댑터가 정한 기본 종류로 전달되며 멈추지 않는다', async () => {
    const server = makeServer();
    const key = generateSyncKey();
    const A = kvAdapter(true), C = kvAdapter(false), D = kvAdapter(false);
    const eA = await engineFor(server, key, A), eC = await engineFor(server, key, C), eD = await engineFor(server, key, D);
    put(A, 'memo_1', 'memo', '메모'); put(A, 'rmk_1', 'remark', '덧글');
    await eA.syncNow(); await eC.syncNow();
    A.store.delete('memo_1'); A.store.delete('rmk_1');
    await eA.syncNow();
    await eC.syncNow();
    expect(eC.status.lastError).toBeUndefined();
    const cDel = C.applied.filter((i) => i.deleted).map((i) => [i.id, i.kind]).sort();
    expect(cDel).toEqual([['memo_1', 'memo'], ['rmk_1', 'remark']]); // 메타가 kind 를 기억한다
    // D 는 삭제만 본다(내용을 받은 적 없음): kindOfId 도 메타도 없어 종류를 알 수 없다
    await eD.syncNow();
    expect(eD.status.lastError).toBeUndefined();
    expect(eD.status.phase).toBe('idle');
    // 로컬에 없는 항목의 삭제는 이미 같은 상태(삭제)이므로 엔진이 apply 를 부르지 않는다. 어댑터에는 잘못된 kind 가 전달될 일이 없다
    expect(D.applied).toEqual([]);
  });
});
