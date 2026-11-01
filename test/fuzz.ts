// Csmith 로 만든 무작위 프로그램을 clang 과 crowser 로 돌려 출력(체크섬)을 견준다.
// Csmith 프로그램은 정의되지 않은 동작이 없게 만들어지니 다르면 crowser 버그다.
//   node test/fuzz.ts [시작 씨앗] [개수]     (brew install csmith)
// 다른 것은 test/.cache/fuzz/<씨앗>.c 로 남는다
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { run } from "../src/index.ts";

const from = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 100);
const here = import.meta.dirname;
const out = path.join(here, ".cache/fuzz");
fs.mkdirSync(out, { recursive: true });

const csmith = execFileSync("which", ["csmith"]).toString().trim();
const inc = path.join(
  fs.realpathSync(csmith),
  "../../include",
  fs
    .readdirSync(path.join(fs.realpathSync(csmith), "../../include"))
    .find((d) => d.startsWith("csmith"))!,
);

// crowser 는 파일 하나만 받으니 csmith.h 무리를 펼쳐 넣는다(표준 헤더는 그대로).
// 안 쓰는 #if 갈래에도 같은 파일이 있어 한 번만 펼치면 쓰는 갈래에서 빠진다. 거듭 넣고 include 가드에 맡긴다
const inline = (text: string, open: string[] = []): string =>
  text.replace(/^\s*#\s*include\s+"([^"]+)".*$/gm, (_, name: string) => {
    const file = path.join(inc, name);
    if (open.includes(file) || !fs.existsSync(file)) return "";
    return inline(fs.readFileSync(file, "utf8"), [...open, file]);
  });

// packed 는 GNU 확장이라 뺀다. 짝수 씨앗은 const·volatile 을 꺼 표준 제약을 덜 어기게 한다(clang 이 받는 몫이 두 배쯤)
const opts = (seed: number) => [
  "--no-packed-struct",
  "--max-funcs",
  "8",
  ...(seed % 2 ? [] : ["--no-consts", "--no-volatiles"]),
];
// 여러 개를 함께 돌려도 겹치지 않게 프로세스마다 다른 파일
const bin = path.join(out, `bin-${process.pid}`);
let same = 0;
let skipped = 0;
let rejected = 0;
const diff: number[] = [];

for (let seed = from; seed < from + count; seed++) {
  const src = inline(
    execFileSync(csmith, ["--seed", String(seed), ...opts(seed)], {
      cwd: out,
    }).toString(),
  );
  const file = path.join(out, `cur-${process.pid}.c`);
  fs.writeFileSync(file, src);
  // Csmith 는 정의되지 않은 동작만 피하고 표준의 제약(다른 타입 포인터끼리 비교 등)은 어긴다.
  // crowser 는 그런 코드를 컴파일 오류로 거부하니 clang 도 표준 C 로 받는 것만 견준다
  try {
    execFileSync(
      "clang",
      ["-std=c17", "-pedantic-errors", "-fsyntax-only", file],
      {
        stdio: "ignore",
      },
    );
  } catch {
    rejected++;
    // clang 이 거부한 것은 crowser 도 거부해야 한다
    const r = run(src, { limit: 0, ops: 1e8 });
    if (!r.error) {
      diff.push(seed);
      fs.writeFileSync(path.join(out, `${seed}.c`), src);
      console.log(`DIFF ${seed}: clang 은 거부했는데 crowser 는 받았습니다`);
    }
    continue;
  }
  let want: string;
  try {
    execFileSync("clang", ["-std=c17", "-w", "-O1", "-o", bin, file, "-lm"]);
    want = execFileSync(bin, { timeout: 2000 }).toString();
  } catch {
    skipped++;
    continue;
  }
  // 빠른 실행(JIT)과, 앞 2만 단계를 해석기로 기록하는 실행을 둘 다 본다
  const shown = (limit: number) => {
    const r = run(src, { limit, ops: 2e9 });
    if (r.error && /너무 오래/.test(r.error.msg)) return null;
    return r.error ? `오류 ${(r.error.line ?? -1) + 1}: ${r.error.msg}` : r.out;
  };
  const fast = shown(0);
  const rec = fast === null ? null : shown(20_000);
  if (fast === null || rec === null) {
    skipped++;
    continue;
  }
  const got = fast === rec ? fast : `${fast}\n  기록하며: ${rec}`;
  if (got === want) same++;
  else {
    diff.push(seed);
    fs.writeFileSync(path.join(out, `${seed}.c`), src);
    console.log(
      `DIFF ${seed}\n  clang: ${want.trim()}\n  우리:  ${got.trim()}`,
    );
  }
}
console.log(
  `같음 ${same}, 다름 ${diff.length}, 표준 C 아님 ${rejected}, 건너뜀(clang 실패·시간 초과) ${skipped}`,
);
if (diff.length) process.exitCode = 1;
