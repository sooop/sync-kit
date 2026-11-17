// 메모 앱을 가정한 메모리 저장소와 SyncAdapter 구현. 새 앱의 어댑터를 쓸 때 이 파일을 출발점으로 삼는다.
// 규칙의 설명은 각 규칙을 지키는 코드 옆에 있다. 전체 가이드: docs/ADAPTER-GUIDE.md
//
// 데이터 모델
//  - Note    : 메모. 로컬 id 는 기기마다 다르다(note-1, note-2 …). 기기 사이에서 같은 메모를 가리키는 것은 제목이다.
//  - Comment : 메모에 다는 댓글. 부모 메모를 noteId(기기마다 다른 로컬 id)로 가리킨다 → 보낼 때 제목으로 바꾸고, 받을 때 다시 noteId 로 바꾼다.
// 동기화 항목
//  - Note    → kind 'doc'    , id 'n' + contentHash(제목 소문자)  (27자). 이름이 같으면 같은 항목이다.
//  - Comment → kind 'thread' , id 't-' + 댓글 id                   (댓글 id 는 무작위라 기기 사이에서 겹치지 않는다)
import { contentHash } from '../../core/src/index.ts';
import type { LocalItem, SyncAdapter } from '../../core/src/index.ts';

// 평문(SyncPlain.data)의 모양은 앱이 정한다. 코어는 data 를 들여다보지 않는다. 이 예제의 두 종류:
/** kind 'doc': 메모. 이름(제목)이 기기 사이의 정체성이다 */
interface DocData { name: string; content: string }
/** kind 'thread': 댓글. 부모는 로컬 id 가 아니라 부모의 제목(docName)으로 가리킨다 */
interface ThreadData {
  docName: string;
  anchor: { quote: string; prefix: string; suffix: string };
  messages: { id: string; text: string; ts: number }[];
  resolved: boolean;
  createdAt: number;
}

export interface Note { id: string; title: string; body: string; updatedAt: number; deleted: boolean }
export interface Comment { id: string; noteId: string; text: string; updatedAt: number }
/** 충돌에서 진 본문을 이력에 남긴 기록(md-works 의 '동기화 전' 버전에 해당) */
export interface HistoryEntry { noteId: string; title: string; body: string; label: string; ts: number }

/** 항목 id 는 기기 사이에서 같아야 한다. 로컬 id 가 아니라 제목에서 만든다. 대소문자는 구분하지 않는다 */
export const noteItemId = (title: string): string => `n${contentHash(title.toLowerCase())}`;
export const commentItemId = (commentId: string): string => `t-${commentId}`;

export interface MemoryNotesOptions {
  now?: () => number;
  /** 앱이 쓰는 쪽(put·remove·putComment)에서 데이터가 바뀔 때 부른다. 엔진의 markDirty 를 연결하는 자리다 */
  onChange?: () => void;
}

export interface MemoryNotesHandle {
  adapter: SyncAdapter;
  /** 삭제되지 않은 메모 */
  notes(): Note[];
  comments(): Comment[];
  /** 메모를 쓴다. id 가 없으면 같은 제목(대소문자 무시)의 메모를 고치고, 없으면 새로 만든다 */
  put(n: { id?: string; title: string; body?: string; updatedAt?: number }): Note;
  /** 메모를 삭제 표시한다(휴지통). 다음 동기화가 삭제를 서버에 올린다 */
  remove(id: string): void;
  putComment(c: { id?: string; noteId: string; text: string; updatedAt?: number }): Comment;
  /** 엔진이 apply 로 로컬에 반영한 항목(applied 를 돌려준 것만) */
  applied: LocalItem[];
  /** apply 가 'deferred' 를 돌려준 항목 */
  deferred: LocalItem[];
  /** preserveLoser 로 이력에 남은 기록 */
  history: HistoryEntry[];
  /** removeLocal 로 지운 항목 */
  removedLocal: LocalItem[];
  /** setApplying 이 받은 값 순서(true, false …) */
  applyingLog: boolean[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export function createMemoryNotesAdapter(initial: Note[] = [], options: MemoryNotesOptions = {}): MemoryNotesHandle {
  const now = options.now ?? (() => Date.now());
  const noteStore = new Map<string, Note>(initial.map((n) => [n.id, { ...n }]));
  const commentStore = new Map<string, Comment>();
  let noteSeq = initial.length;

  const applied: LocalItem[] = [];
  const deferred: LocalItem[] = [];
  const history: HistoryEntry[] = [];
  const removedLocal: LocalItem[] = [];
  const applyingLog: boolean[] = [];

  // setApplying: 엔진이 apply·removeLocal 을 부르는 동안 true 다.
  // 실제 앱은 이 동안 '앱이 직접 쓴 변경' 알림(markDirty)과 이미지 gc 를 멈춘다. 멈추지 않으면 원격 반영이 로컬 변경으로 보여 다시 올라간다.
  let applyingDepth = 0;
  const notify = () => { if (applyingDepth === 0) options.onChange?.(); };

  const liveNotes = () => [...noteStore.values()].filter((n) => !n.deleted);
  const noteByItemId = (itemId: string) => {
    const same = [...noteStore.values()].filter((n) => noteItemId(n.title) === itemId);
    return same.find((n) => !n.deleted) ?? same[0]; // 같은 제목이면 삭제되지 않은 쪽이 먼저다
  };
  const noteByTitle = (title: string) => liveNotes().find((n) => n.title.toLowerCase() === title.toLowerCase());

  // ───────── 읽기 ─────────
  // listLocal 은 삭제되지 않은 항목을 전부 돌려주거나, 읽다가 실패하면 던진다.
  // 일부만 돌려주고 끝내면 엔진은 빠진 항목을 '지워졌다'고 판단해 서버에 삭제를 올리고, 대량 삭제 가드가 동기화를 멈춘다.
  async function listLocal(): Promise<LocalItem[]> {
    const items: LocalItem[] = [];
    const idToTitle = new Map<string, string>();
    for (const n of liveNotes()) {
      idToTitle.set(n.id, n.title);
      // data 는 평문(SyncPlain)에 들어가는 모양 그대로다. 아래 apply 가 쓴 값이 여기에서 같은 값으로 읽혀야 한다(해시 일치).
      const data: DocData = { name: n.title, content: n.body };
      items.push({ id: noteItemId(n.title), kind: 'doc', updatedAt: n.updatedAt, deleted: false, data });
    }
    for (const c of commentStore.values()) {
      // 부모 메모의 로컬 id 는 다른 기기에서 의미가 없으므로 제목으로 바꿔 보낸다.
      const docName = idToTitle.get(c.noteId);
      if (docName === undefined) continue; // 삭제된 메모의 댓글은 동기화하지 않는다
      const data: ThreadData = {
        docName, anchor: { quote: '', prefix: '', suffix: '' },
        messages: [{ id: c.id, text: c.text, ts: c.updatedAt }], resolved: false, createdAt: c.updatedAt,
      };
      items.push({ id: commentItemId(c.id), kind: 'thread', updatedAt: c.updatedAt, deleted: false, data });
    }
    return items;
  }

  // ───────── 쓰기 ─────────
  async function apply(item: LocalItem): Promise<'applied' | 'deferred'> {
    if (item.kind === 'doc') {
      applyNote(item);
    } else if (item.kind === 'thread') {
      if (!applyComment(item)) { deferred.push(item); return 'deferred'; }
    } else {
      // 이 앱에 없는 종류의 항목: 무시하고 applied 로 답한다(deferred 로 답하면 엔진이 영원히 재시도한다)
    }
    applied.push(item);
    return 'applied';
  }

  function applyNote(item: LocalItem): void {
    const existing = noteByItemId(item.id);
    if (item.deleted || !item.data) {
      if (existing) { existing.deleted = true; notify(); }
      return;
    }
    const d = item.data as DocData;
    // 받은 값을 가공하지 않고 그대로 쓴다. 제목을 다듬거나 본문 끝 공백을 지우면 listLocal 의 해시가 달라져
    // 엔진이 '로컬에서 고쳤다'고 판단하고 다시 올린다. 서버 rev 가 올라가고 다른 기기가 다시 받아 같은 일이 되풀이된다(dirty 루프).
    if (existing) {
      existing.title = d.name; existing.body = d.content; existing.updatedAt = item.updatedAt; existing.deleted = false;
    } else {
      const id = `note-${++noteSeq}`;
      noteStore.set(id, { id, title: d.name, body: d.content, updatedAt: item.updatedAt, deleted: false });
    }
    notify();
  }

  /** 부모 메모를 찾지 못하면 false 를 돌려준다 → apply 가 'deferred' 로 답한다 */
  function applyComment(item: LocalItem): boolean {
    const id = item.id.slice(2);
    if (item.deleted || !item.data) {
      if (commentStore.delete(id)) notify();
      return true;
    }
    const d = item.data as ThreadData;
    // 제목 → 이 기기의 로컬 id. 메모가 아직 도착하지 않았을 수 있다. 엔진은 같은 동기화 안에서 다른 항목을 모두 적용한 뒤 한 번 더 시도한다.
    const parent = noteByTitle(d.docName);
    if (!parent) return false;
    commentStore.set(id, { id, noteId: parent.id, text: d.messages[0]?.text ?? '', updatedAt: item.updatedAt });
    notify();
    return true;
  }

  // 충돌에서 진 쪽의 본문을 이력에 남긴다(글에 해당하는 kind 만). 엔진은 덮어쓰기 전에 부른다.
  // 이긴 쪽이 원격이면 item 은 지는 로컬 사본이고, 이긴 쪽이 로컬이면 item 은 지는 서버 사본이다. 어느 쪽이든 '같은 메모의 이력'에 남는다.
  async function preserveLoser(item: LocalItem): Promise<void> {
    if (item.kind !== 'doc' || !item.data) return;
    const d = item.data as DocData;
    const note = noteByItemId(item.id);
    if (!note) return;
    const t = new Date(now());
    history.push({
      noteId: note.id, title: d.name, body: d.content, ts: item.updatedAt || t.getTime(),
      label: `동기화 전(${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())})`,
    });
  }

  // 되돌릴 수 없다: remove() 의 삭제 표시(휴지통)와 달리 저장소에서 완전히 지운다.
  // 엔진은 오래 접속하지 않은 기기에서 사용자가 '이 기기에서 지우기'를 고른 경우에만 부른다.
  async function removeLocal(item: LocalItem): Promise<void> {
    removedLocal.push(item);
    if (item.kind === 'doc') {
      const n = noteByItemId(item.id);
      if (n) {
        noteStore.delete(n.id);
        for (const c of [...commentStore.values()]) if (c.noteId === n.id) commentStore.delete(c.id);
      }
    } else if (item.kind === 'thread') {
      commentStore.delete(item.id.slice(2));
    }
    notify();
  }

  const adapter: SyncAdapter = {
    listLocal,
    apply,
    preserveLoser,
    removeLocal,
    setApplying(on) {
      applyingLog.push(on);
      applyingDepth = Math.max(0, applyingDepth + (on ? 1 : -1));
    },
  };

  return {
    adapter,
    notes: () => liveNotes().map((n) => ({ ...n })),
    comments: () => [...commentStore.values()].map((c) => ({ ...c })),
    put(n) {
      const found = (n.id !== undefined ? noteStore.get(n.id) : undefined) ?? noteByItemId(noteItemId(n.title));
      const t = n.updatedAt ?? now();
      let rec: Note;
      if (found) {
        found.title = n.title; found.updatedAt = t; found.deleted = false;
        if (n.body !== undefined) found.body = n.body;
        rec = found;
      } else {
        rec = { id: n.id ?? `note-${++noteSeq}`, title: n.title, body: n.body ?? '', updatedAt: t, deleted: false };
        noteStore.set(rec.id, rec);
      }
      options.onChange?.();
      return { ...rec };
    },
    remove(id) {
      const n = noteStore.get(id);
      if (!n) return;
      n.deleted = true;
      options.onChange?.();
    },
    putComment(c) {
      const id = c.id ?? Math.random().toString(36).slice(2, 10);
      const rec: Comment = { id, noteId: c.noteId, text: c.text, updatedAt: c.updatedAt ?? now() };
      commentStore.set(id, rec);
      options.onChange?.();
      return { ...rec };
    },
    applied, deferred, history, removedLocal, applyingLog,
  };
}
