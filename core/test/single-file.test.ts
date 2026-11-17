import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = resolve(__dirname, '../../dist/sync-kit.min.js');
const has = existsSync(file);

describe.skipIf(!has)('단일 파일 번들', () => {
  it('키 생성 → 파생 → 코덱 왕복', async () => {
    const m = await import(/* @vite-ignore */ pathToFileURL(file).href);
    const key = m.generateSyncKey();
    const keys = await m.deriveKeys(key, 'smoke-app');
    const codec = m.createCodec(keys.encKey);
    const plain = { v: 1, kind: 'doc', updatedAt: 1, data: { name: 'n', content: '안녕 😀' } };
    const blob = await codec.encrypt('id1', plain);
    expect(await codec.decrypt('id1', blob)).toEqual(plain);
    expect(typeof m.createSyncEngine).toBe('function');
  });

  it('외부 모듈 참조가 없다(자급)', () => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/(^|[;}\s])import\s*(\(|[\w{*][^;]*?\sfrom\s*)["'`]/m);
    expect(src).not.toMatch(/from\s*["'][^"']+["']/);
    expect(src).not.toContain('fflate');
  });
});
