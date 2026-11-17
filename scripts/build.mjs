// 빌드: (1) 코어 ESM + 타입 선언, (2) 붙여 넣는 단일 ESM 한 파일, (3) 서버 핸들러·테스트 shim(다른 프로젝트의 통합 테스트용).
// 진입점이 아직 없으면 건너뛴다(--if-present: prepare 단계에서 실패하지 않게).
import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ifPresent = process.argv.includes('--if-present');
const p = (...a) => resolve(root, ...a);
mkdirSync(p('dist'), { recursive: true });

const common = { bundle: true, format: 'esm', target: 'es2022', platform: 'neutral', logLevel: 'info', legalComments: 'none' };
const jobs = [
  // npm 형태: fflate 는 의존성으로 남긴다
  { entry: 'core/src/index.ts', out: 'dist/index.js', opts: { external: ['fflate'], sourcemap: true } },
  // 단일 파일 형태: fflate 까지 넣고 압축한다. 빌드 없이 HTML 의 <script type="module"> 에 붙여 넣거나 import 한다
  { entry: 'core/src/index.ts', out: 'dist/sync-kit.min.js', opts: { minify: true } },
  { entry: 'server/src/handler.ts', out: 'dist/handler.js', opts: { external: ['node:*'] } },
  { entry: 'server/test/d1shim.ts', out: 'dist/testing.js', opts: { platform: 'node', external: ['node:*'] } },
];

let built = 0;
for (const j of jobs) {
  if (!existsSync(p(j.entry))) {
    if (ifPresent) { console.log(`건너뜀(진입점 없음): ${j.entry}`); continue; }
    throw new Error(`진입점이 없습니다: ${j.entry}`);
  }
  await build({ ...common, ...j.opts, entryPoints: [p(j.entry)], outfile: p(j.out) });
  built++;
}

// 타입 선언: 진입점마다 dist/types/<이름>/ 에 내보내고 dist/<이름>.d.ts 가 그것을 다시 export 한다.
// 진입점이 있을 때만 만든다(handler·testing 은 server/ 가 생기면 자동으로 따라온다)
const tsc = p('node_modules/typescript/bin/tsc');
const decl = (entry, name) => {
  execFileSync(process.execPath, [tsc, entry, '--ignoreConfig', '--declaration', '--emitDeclarationOnly', '--skipLibCheck', '--allowImportingTsExtensions',
    '--moduleResolution', 'bundler', '--module', 'ESNext', '--target', 'ES2022', '--lib', 'ES2023,DOM,DOM.Iterable', '--strict', '--types', 'node',
    '--rootDir', dirname(entry), '--outDir', `dist/types/${name}`], { cwd: root, stdio: 'inherit' });
  writeFileSync(p(`dist/${name}.d.ts`), `export * from './types/${name}/${basename(entry, '.ts')}.js';\n`);
};
for (const [entry, name] of [['core/src/index.ts', 'index'], ['server/src/handler.ts', 'handler'], ['server/test/d1shim.ts', 'testing']]) {
  if (existsSync(p(entry))) decl(entry, name);
}
console.log(`빌드 ${built}개 완료`);
