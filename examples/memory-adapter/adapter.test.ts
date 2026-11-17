import { describe, expect, it, vi } from 'vitest';
import { hashItem, ITEM_ID_RE, type LocalItem, type SyncPlain } from '../../core/src/index.ts';
import { commentItemId, createMemoryNotesAdapter, noteItemId } from './adapter.ts';

const doc = (title: string, content: string, updatedAt = 1000): LocalItem => ({
  id: noteItemId(title), kind: 'doc', updatedAt, deleted: false, data: { name: title, content },
});
const comment = (id: string, docName: string, text: string, updatedAt = 1000): LocalItem => ({
  id: commentItemId(id), kind: 'thread', updatedAt, deleted: false,
  data: { docName, anchor: { quote: '', prefix: '', suffix: '' }, messages: [{ id, text, ts: updatedAt }], resolved: false, createdAt: updatedAt },
});
const hashOf = (i: LocalItem) => hashItem({ deleted: i.deleted, data: i.data });

describe('listLocal', () => {
  it('삭제되지 않은 메모를 doc 항목으로 돌려준다', async () => {
    const h = createMemoryNotesAdapter([
      { id: 'a', title: 'Alpha', body: '본문 A', updatedAt: 10, deleted: false },
      { id: 'b', title: 'Beta', body: '본문 B', updatedAt: 20, deleted: true },
    ]);
    const items = await h.adapter.listLocal();
    expect(items).toEqual([
      { id: noteItemId('Alpha'), kind: 'doc', updatedAt: 10, deleted: false, data: { name: 'Alpha', content: '본문 A' } },
    ]);
    expect(items[0].id).toMatch(ITEM_ID_RE);
  });

  it('항목 id 는 로컬 id 가 아니라 제목(대소문자 무시)에서 만든다', async () => {
    const x = createMemoryNotesAdapter([{ id: 'x-1', title: 'Plan', body: '', updatedAt: 1, deleted: false }]);
    const y = createMemoryNotesAdapter([{ id: 'y-99', title: 'plan', body: '', updatedAt: 1, deleted: false }]);
    expect((await x.adapter.listLocal())[0].id).toBe((await y.adapter.listLocal())[0].id);
  });

  it('댓글은 부모 메모의 로컬 id 가 아니라 제목으로 보낸다', async () => {
    const h = createMemoryNotesAdapter([{ id: 'local-7', title: 'Plan', body: '', updatedAt: 1, deleted: false }]);
    h.putComment({ id: 'c1', noteId: 'local-7', text: '확인', updatedAt: 5 });
    const items = await h.adapter.listLocal();
    const t = items.find((i) => i.kind === 'thread')!;
    expect(t.id).toBe('t-c1');
    expect((t.data as { docName: string }).docName).toBe('Plan');
    expect(JSON.stringify(t)).not.toContain('local-7');
  });

  it('삭제된 메모의 댓글은 내보내지 않는다', async () => {
    const h = createMemoryNotesAdapter([{ id: 'n1', title: 'T', body: '', updatedAt: 1, deleted: false }]);
    h.putComment({ id: 'c1', noteId: 'n1', text: 'x' });
    h.remove('n1');
    expect(await h.adapter.listLocal()).toEqual([]);
  });
});

describe('apply 와 listLocal 의 왕복 안정성', () => {
  it('apply 한 항목이 listLocal 에서 같은 해시로 읽힌다(공백·대소문자·줄바꿈 포함)', async () => {
    const h = createMemoryNotesAdapter();
    const remote = doc('  Mixed Case 제목 ', '첫 줄\r\n둘째 줄  \n\n끝 공백   ', 777);
    expect(await h.adapter.apply(remote)).toBe('applied');
    const back = (await h.adapter.listLocal()).find((i) => i.id === remote.id)!;
    expect(back).toBeDefined();
    expect(hashOf(back)).toBe(hashOf(remote));
    expect(back.updatedAt).toBe(777);
  });

  it('댓글도 같은 해시로 읽힌다', async () => {
    const h = createMemoryNotesAdapter();
    await h.adapter.apply(doc('Plan', 'x'));
    const remote = comment('c9', 'plan', '댓글 본문', 55); // 제목 대소문자가 달라도 부모를 찾는다
    expect(await h.adapter.apply(remote)).toBe('applied');
    const back = (await h.adapter.listLocal()).find((i) => i.id === remote.id)!;
    // 부모 제목은 이 기기의 표기('Plan')로 돌아오므로 docName 만 다르다. 나머지 필드는 같다.
    const strip = (i: LocalItem) => ({ ...(i.data as object), docName: undefined });
    expect(strip(back)).toEqual(strip(remote));
  });

  it('같은 항목을 두 번 apply 해도 listLocal 결과가 변하지 않는다', async () => {
    const h = createMemoryNotesAdapter();
    const remote = doc('Plan', '본문');
    await h.adapter.apply(remote);
    const first = await h.adapter.listLocal();
    await h.adapter.apply(remote);
    expect(await h.adapter.listLocal()).toEqual(first);
    expect(h.notes()).toHaveLength(1);
  });

  it('로컬에서 고치면 해시가 달라진다(변경 감지가 동작한다)', async () => {
    const h = createMemoryNotesAdapter();
    const remote = doc('Plan', 'v1');
    await h.adapter.apply(remote);
    h.put({ title: 'Plan', body: 'v2' });
    const back = (await h.adapter.listLocal())[0];
    expect(hashOf(back)).not.toBe(hashOf(remote));
  });

  it('평문 형식(SyncPlain)에 그대로 담긴다', async () => {
    const h = createMemoryNotesAdapter([{ id: 'a', title: 'T', body: 'B', updatedAt: 3, deleted: false }]);
    const [i] = await h.adapter.listLocal();
    const plain: SyncPlain = { v: 1, kind: i.kind, updatedAt: i.updatedAt, data: i.data };
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
  });
});

describe('삭제 적용', () => {
  it('삭제 항목을 apply 하면 메모가 목록에서 사라진다', async () => {
    const h = createMemoryNotesAdapter();
    await h.adapter.apply(doc('Plan', 'x'));
    expect(h.notes()).toHaveLength(1);
    const del: LocalItem = { id: noteItemId('Plan'), kind: 'doc', updatedAt: 0, deleted: true, data: null };
    expect(await h.adapter.apply(del)).toBe('applied');
    expect(h.notes()).toEqual([]);
    expect(await h.adapter.listLocal()).toEqual([]);
  });

  it('없는 메모의 삭제는 오류 없이 applied 다', async () => {
    const h = createMemoryNotesAdapter();
    const del: LocalItem = { id: noteItemId('Nope'), kind: 'doc', updatedAt: 0, deleted: true, data: null };
    expect(await h.adapter.apply(del)).toBe('applied');
  });

  it('삭제됐던 제목이 다시 도착하면 되살아난다', async () => {
    const h = createMemoryNotesAdapter();
    await h.adapter.apply(doc('Plan', 'v1'));
    await h.adapter.apply({ id: noteItemId('Plan'), kind: 'doc', updatedAt: 0, deleted: true, data: null });
    await h.adapter.apply(doc('Plan', 'v2', 50));
    expect(h.notes().map((n) => n.body)).toEqual(['v2']);
  });
});

describe('deferred', () => {
  it('부모 메모가 없는 댓글은 deferred 다', async () => {
    const h = createMemoryNotesAdapter();
    const c = comment('c1', 'Missing', '고아');
    expect(await h.adapter.apply(c)).toBe('deferred');
    expect(h.deferred).toEqual([c]);
    expect(h.applied).toEqual([]);
    expect(h.comments()).toEqual([]);
  });

  it('부모가 도착한 뒤 다시 apply 하면 applied 다', async () => {
    const h = createMemoryNotesAdapter();
    const c = comment('c1', 'Plan', '나중에');
    expect(await h.adapter.apply(c)).toBe('deferred');
    await h.adapter.apply(doc('Plan', 'x'));
    expect(await h.adapter.apply(c)).toBe('applied');
    expect(h.comments()).toHaveLength(1);
    expect(h.comments()[0].noteId).toBe(h.notes()[0].id);
  });
});

describe('preserveLoser · removeLocal · setApplying', () => {
  it('preserveLoser 는 진 본문을 같은 메모의 이력에 남긴다', async () => {
    const h = createMemoryNotesAdapter(
      [{ id: 'a', title: 'Plan', body: '이긴 본문', updatedAt: 200, deleted: false }],
      { now: () => new Date(2026, 10, 17, 12).getTime() },
    );
    await h.adapter.preserveLoser(doc('Plan', '진 본문', 100));
    expect(h.history).toEqual([
      { noteId: 'a', title: 'Plan', body: '진 본문', ts: 100, label: '동기화 전(2026-11-17)' },
    ]);
    expect(h.notes()[0].body).toBe('이긴 본문');
  });

  it('preserveLoser 는 메모가 없거나 doc 이 아니면 아무것도 하지 않는다', async () => {
    const h = createMemoryNotesAdapter();
    await h.adapter.preserveLoser(doc('Nope', 'x'));
    await h.adapter.preserveLoser(comment('c', 'Nope', 'x'));
    expect(h.history).toEqual([]);
  });

  it('removeLocal 은 메모와 그 댓글을 완전히 지운다', async () => {
    const h = createMemoryNotesAdapter([{ id: 'a', title: 'Plan', body: 'x', updatedAt: 1, deleted: false }]);
    h.putComment({ id: 'c1', noteId: 'a', text: 'x' });
    const [item] = await h.adapter.listLocal();
    await h.adapter.removeLocal(item);
    expect(h.removedLocal).toEqual([item]);
    expect(h.notes()).toEqual([]);
    expect(h.comments()).toEqual([]);
  });

  it('setApplying 중에는 apply 가 onChange 를 부르지 않는다', async () => {
    const onChange = vi.fn();
    const h = createMemoryNotesAdapter([], { onChange });
    h.adapter.setApplying?.(true);
    await h.adapter.apply(doc('A', 'x'));
    h.adapter.setApplying?.(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(h.applyingLog).toEqual([true, false]);
    h.put({ title: 'B', body: 'y' }); // 앱이 직접 쓴 변경은 알린다
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
