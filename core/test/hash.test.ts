import { describe, expect, it } from 'vitest';
import { contentHash } from '../src/hash';

// 기대값은 원본(md-works 의 contentHash)을 실제로 실행해 얻은 값이다. 바뀌면 배포된 항목 id·메타와 어긋난다.
const VECTORS: [string, string, string][] = [
  ['empty', '', '1aee8d83488bdcb8c223ada330'],
  ['ascii', 'hello', '63cd7226bfb06f3af5f5cc476d'],
  ['ascii-sentence', 'The quick brown fox jumps over the lazy dog', 'ebfa20ed344dc3501b0d5c79fe'],
  ['korean', '안녕하세요 세계', '0aef2d01b880745a2103bd9ee8'],
  ['emoji', '😀🎉👨‍👩‍👧', 'b4ea8fe87e65773e6270445c21'],
  ['mixed', 'a한😀b\u0000c', '248d64e45f6836b8407c17909d'],
  ['nul-sep', '문서\u0000내용', '0418e9af83ef0828ca0675fbb6'],
  ['newline', 'line1\nline2\r\n', '832a441a289b8c435bb91a5894'],
  ['long-50000', '가나다abc'.repeat(7143).slice(0, 50000), '1389e051c248a50194a540821d'],
  ['single-char', 'a', '82c97901501c2ba77be9443bfe'],
  ['lone-surrogate', 'x\ud83dy', '68c86ede8909b3e0cc5ae3308d'],
];

describe('contentHash 고정 벡터', () => {
  for (const [name, input, expected] of VECTORS) {
    it(name, () => { expect(contentHash(input)).toBe(expected); });
  }
  it('26자 소문자 16진', () => { expect(contentHash('x')).toMatch(/^[0-9a-f]{26}$/); });
});
