import { describe, expect, it } from 'vitest';
import { createSyncEngine } from '../src/engine';
import { createMemoryMetaStore } from '../src/metaStore';
import { resolveLimits, type SyncLimits } from '../src/protocol';
import { usageRatio } from '../src/syncLabels';
import { splitPushBatches } from '../src/transport';
import { FakeServer, MemoryAdapter, fakeCodec } from './helpers';

function device(s: FakeServer, o: { adapter?: MemoryAdapter; meta?: ReturnType<typeof createMemoryMetaStore>; limits?: Partial<SyncLimits> } = {}) {
  const adapter = o.adapter ?? new MemoryAdapter();
  const meta = o.meta ?? createMemoryMetaStore();
  const engine = createSyncEngine({
    appId: 'test-app', config: { workerUrl: 'http://w', syncKey: 'K' }, adapter, meta,
    codec: fakeCodec(), transport: s.transport(), autoSchedule: false, limits: o.limits,
  });
  return { adapter, meta, engine };
}
const putNote = (a: MemoryAdapter, id: string, kind: string, updatedAt = 10) =>
  a.items.set(id, { id, kind, updatedAt, deleted: false, data: { text: id } });
const lastPushPlain = async (s: FakeServer) => {
  const req = s.requests.filter((r) => r.push.length).at(-1)!;
  return fakeCodec().decrypt(req.push[0].id, req.push[0].blob);
};

describe('임의 kind', () => {
  it('push·apply 때 메타에 kind 를 기록한다', async () => {
    const s = new FakeServer();
    const a = device(s), b = device(s);
    putNote(a.adapter, 'n1', 'note');
    await a.engine.syncNow();
    expect((await a.meta.getAll())[0].kind).toBe('note');
    await b.engine.syncNow();
    expect(b.adapter.items.get('n1')?.kind).toBe('note');
    expect((await b.meta.getAll())[0].kind).toBe('note');
  });

  it('로컬 삭제 push: 메타 kind 가 있으면 그것을 쓴다', async () => {
    const s = new FakeServer();
    const a = device(s);
    a.adapter.kindOf = () => 'from-adapter';
    putNote(a.adapter, 'n1', 'note');
    await a.engine.syncNow();
    a.adapter.items.delete('n1');
    await a.engine.syncNow();
    expect((await lastPushPlain(s)).kind).toBe('note');
  });

  async function strippedDevice(s: FakeServer, kindOf?: (id: string) => string | undefined) {
    const a = device(s);
    putNote(a.adapter, 'n1', 'note');
    await a.engine.syncNow();
    const m = (await a.meta.getAll())[0];
    delete m.kind; // 옛 메타(kind 필드 없음)
    await a.meta.put(m);
    const adapter = a.adapter;
    adapter.kindOf = kindOf;
    return device(s, { adapter, meta: a.meta });
  }

  it('로컬 삭제 push: 메타에 kind 가 없으면 kindOfId, 그것도 없으면 unknown', async () => {
    const s1 = new FakeServer();
    const d1 = await strippedDevice(s1, () => 'from-adapter');
    d1.adapter.items.delete('n1');
    await d1.engine.syncNow();
    expect((await lastPushPlain(s1)).kind).toBe('from-adapter');

    const s2 = new FakeServer();
    const d2 = await strippedDevice(s2);
    d2.adapter.items.delete('n1');
    await d2.engine.syncNow();
    const p = await lastPushPlain(s2);
    expect(p.kind).toBe('unknown');
    expect(p.data).toBeNull();
  });

  async function remoteBlankDelete(kindOf: ((id: string) => string | undefined) | undefined, stripMeta: boolean) {
    const s = new FakeServer();
    const a = device(s), b = device(s);
    putNote(a.adapter, 'n1', 'note');
    await a.engine.syncNow();
    await b.engine.syncNow();
    if (stripMeta) {
      const m = (await b.meta.getAll())[0];
      delete m.kind;
      await b.meta.put(m);
    }
    a.adapter.items.delete('n1');
    await a.engine.syncNow();
    s.items.get('n1')!.blob = ''; // 서버는 삭제 blob 을 비워 돌려준다(복호화 없음)
    s.items.get('n1')!.seq = ++s.seq;
    b.adapter.kindOf = kindOf;
    const b2 = device(s, { adapter: b.adapter, meta: b.meta });
    b.adapter.applied.length = 0;
    await b2.engine.syncNow();
    return b.adapter;
  }

  it('내용 없는 원격 삭제: 메타 kind → kindOfId → unknown 순으로 apply 에 전달', async () => {
    const withMeta = await remoteBlankDelete(() => 'from-adapter', false);
    expect(withMeta.applied).toMatchObject([{ id: 'n1', kind: 'note', deleted: true }]);
    const viaAdapter = await remoteBlankDelete(() => 'from-adapter', true);
    expect(viaAdapter.applied).toMatchObject([{ id: 'n1', kind: 'from-adapter', deleted: true }]);
    const none = await remoteBlankDelete(undefined, true);
    expect(none.applied).toMatchObject([{ id: 'n1', kind: 'unknown', deleted: true }]);
    expect(none.items.has('n1')).toBe(false); // kind 가 부정확해도 삭제는 적용된다
  });

});

describe('limits 재정의', () => {
  it('resolveLimits: 기본 + 부분 재정의', () => {
    expect(resolveLimits().MAX_ITEM_BYTES).toBe(262_144);
    expect(resolveLimits({ MAX_ITEM_BYTES: 5 })).toMatchObject({ MAX_ITEM_BYTES: 5, MAX_DAILY_WRITES: 300 });
  });

  it('항목 크기 사전 검사 한도를 따른다', async () => {
    const s = new FakeServer();
    const a = device(s, { limits: { MAX_ITEM_BYTES: 200 } });
    putNote(a.adapter, 'big', 'note');
    a.adapter.items.get('big')!.data = { text: 'x'.repeat(500) };
    putNote(a.adapter, 'small', 'note');
    await a.engine.syncNow();
    expect(a.engine.status.oversize.map((o) => o.id)).toEqual(['big']);
    expect(s.items.has('small')).toBe(true);
    expect(s.items.has('big')).toBe(false);
  });

  it('쓰기 80% 스로틀 기준을 따른다', async () => {
    const run = async (limits?: Partial<SyncLimits>) => {
      const s = new FakeServer();
      s.dailyWrites = 100;
      const a = device(s, { limits });
      putNote(a.adapter, 'n', 'note');
      await a.engine.syncNow();
      return a.engine.status.throttled;
    };
    expect(await run()).toBe(false); // 100/300
    expect(await run({ MAX_DAILY_WRITES: 120 })).toBe(true); // 100/120
  });

  it('usageRatio 와 splitPushBatches 가 재정의를 받는다', () => {
    expect(usageRatio({ items: 50, bytes: 0, dailyWrites: 0 }, { MAX_ITEMS_PER_SPACE: 100 }).items).toBe(0.5);
    expect(usageRatio({ items: 50, bytes: 0, dailyWrites: 0 }).items).toBe(0.05);
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, baseRev: 0, deleted: false, blob: 'x' }));
    expect(splitPushBatches(items, 400_000, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });
});
