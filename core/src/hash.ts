// 항목 id·변경 감지 해시. 알고리즘을 바꾸면 이미 배포된 기기의 id·메타와 어긋난다 — 고정 벡터(test/hash.test.ts)로 보호한다.
/** 문자열의 비암호 해시(cyrb53 두 개 → 26자 16진). 같은 내용·같은 글이면 같은 버전 id 가 되어 되풀이 가져오기가 버전을 늘리지 않는다 */
export function contentHash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, g1 = 0x9e3779b9, g2 = 0x85ebca6b;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    g1 = Math.imul(g1 ^ c, 2246822519); g2 = Math.imul(g2 ^ c, 3266489917);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  g1 = Math.imul(g1 ^ (g1 >>> 16), 2246822507) ^ Math.imul(g2 ^ (g2 >>> 13), 3266489909);
  g2 = Math.imul(g2 ^ (g2 >>> 16), 2246822507) ^ Math.imul(g1 ^ (g1 >>> 13), 3266489909);
  return [h1, h2, g1, g2].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('').slice(0, 26);
}
