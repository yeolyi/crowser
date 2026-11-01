// 해석기 시험. node test/run.ts [--suite]
// 1. examples/*.c 를 clang 으로 컴파일해 돌린 출력과 우리 출력을 대조한다(글에 넣는 예제는 여기 둔다).
// 2. errors/*.c 는 진짜 C 라면 조용히 망가질 코드다. 첫 줄 주석 `// 오류 <줄>` 의 줄에서 멈춰야 한다.
// 3. --suite [이름…]: 남이 만든 시험 모음의 통과율(suites.ts). 처음에 test/.cache 로 받는다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { run } from "../src/index.ts";
import { runSuites } from "./suites.ts";

const here = import.meta.dirname;
const bin = path.join(here, ".cache/bin");
fs.mkdirSync(path.dirname(bin), { recursive: true });
let failed = 0;

for (const f of fs.readdirSync(path.join(here, "examples")).sort()) {
  const file = path.join(here, "examples", f);
  execFileSync("clang", ["-std=c17", "-w", "-o", bin, file]);
  const want = execFileSync(bin).toString();
  const r = run(fs.readFileSync(file, "utf8"), { limit: 100_000 });
  const got = r.error
    ? `오류 ${r.error.line === null ? "" : r.error.line + 1}: ${r.error.msg}`
    : r.out;
  if (got === want)
    console.log(`ok   ${f} (${r.steps.length}단계, 남은 힙 ${r.leaked})`);
  else {
    failed++;
    console.log(
      `FAIL ${f}\n  clang: ${JSON.stringify(want)}\n  우리:  ${JSON.stringify(got)}`,
    );
  }
}

for (const f of fs.readdirSync(path.join(here, "errors")).sort()) {
  const src = fs.readFileSync(path.join(here, "errors", f), "utf8");
  const want = Number(/^\/\/ 오류 (\d+)/.exec(src)?.[1]);
  const r = run(src);
  const line = r.error?.line == null ? null : r.error.line + 1;
  if (r.error && line === want)
    console.log(`ok   ${f} (${line}줄: ${r.error.msg})`);
  else {
    failed++;
    console.log(
      `FAIL ${f} ${want}줄에서 멈춰야 하는데 ${r.error ? `${line}줄: ${r.error.msg}` : "오류 없음"}`,
    );
  }
}

const at = process.argv.indexOf("--suite");
if (at >= 0) runSuites(process.argv.slice(at + 1));
process.exit(failed ? 1 : 0);
