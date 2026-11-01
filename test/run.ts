// 해석기 시험. node test/run.ts [--suite]
// 1. examples/*.c 를 clang 으로 컴파일해 돌린 출력과 우리 출력을 대조한다(글에 넣는 예제는 여기 둔다).
// 2. errors/*.c 는 진짜 C 라면 조용히 망가질 코드다. 첫 줄 주석 `// 오류 <줄>` 의 줄에서 멈춰야 한다.
// 3. --suite: c-testsuite(github.com/c-testsuite/c-testsuite)의 single-exec 220개 통과율. 처음에 test/.cache 로 받는다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadParser, run } from "../src/index.ts";

const here = import.meta.dirname;
const nm = (p: string) => path.join(here, "../node_modules", p);
const parser = await loadParser(
  nm("web-tree-sitter/web-tree-sitter.wasm"),
  nm("tree-sitter-c/tree-sitter-c.wasm"),
);
const bin = path.join(here, ".cache/bin");
fs.mkdirSync(path.dirname(bin), { recursive: true });
let failed = 0;

for (const f of fs.readdirSync(path.join(here, "examples")).sort()) {
  const file = path.join(here, "examples", f);
  execFileSync("clang", ["-std=c17", "-w", "-o", bin, file]);
  const want = execFileSync(bin).toString();
  const r = run(parser, fs.readFileSync(file, "utf8"), { limit: 100_000 });
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
  const r = run(parser, src);
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

if (process.argv.includes("--suite")) {
  const repo = path.join(here, ".cache/c-testsuite");
  if (!fs.existsSync(repo))
    execFileSync("git", [
      "clone",
      "-q",
      "--depth=1",
      "https://github.com/c-testsuite/c-testsuite",
      repo,
    ]);
  const dir = path.join(repo, "tests/single-exec");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".c"))
    .sort();
  const reasons = new Map<string, string[]>();
  let pass = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const want = fs.readFileSync(path.join(dir, `${f}.expected`), "utf8");
    let why: string;
    try {
      const r = run(parser, src, { limit: 0 });
      why = r.error
        ? r.error.msg
        : r.exit !== 0
          ? `exit ${r.exit}`
          : r.out !== want
            ? "출력 다름"
            : "";
    } catch (e) {
      why = `JS 예외 ${(e as Error).message}`;
    }
    if (!why) pass++;
    else {
      const key = why
        .replace(/0x[0-9a-f]+/g, "0x…")
        .split(" ")
        .slice(0, 3)
        .join(" ");
      reasons.set(key, [...(reasons.get(key) ?? []), f]);
    }
  }
  console.log(
    `\nc-testsuite ${pass}/${files.length} (${Math.round((pass / files.length) * 100)}%)`,
  );
  for (const [k, v] of [...reasons]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 25))
    console.log(String(v.length).padStart(4), k, v.slice(0, 3).join(" "));
}
process.exit(failed ? 1 : 0);
