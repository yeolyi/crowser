// 남이 만든 C 시험 모음. node test/run.ts --suite [이름…]
// 표준 C17 프로그램만 센다: clang -std=c17 -pedantic-errors 가 받지 않는 것(K&R 정의, 암시적 선언, GNU 확장)과
// 컴파일러 고유 이름(__builtin_* 등)을 쓰는 것은 건너뛰고 이유별로 센다. 표준 라이브러리는 일부만 있으니
// 우리가 모르는 헤더를 쓰는 것도 건너뛴다.
// 시험마다 통과 여부를 .cache/results-<이름>.json 에 남겨 다음에 돌릴 때 새로 깨진 것을 알린다.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Parser } from "web-tree-sitter";
import { HEADERS } from "../src/cpp.ts";
import { run } from "../src/index.ts";

const cache = path.join(import.meta.dirname, ".cache");

type Want = { out?: string; exit?: number; reject?: boolean };
type Case = { name: string; src: string; want: Want; skip?: string };
type Suite = { name: string; title: string; cases: () => Case[] };

// 저장소를 정한 커밋으로 받는다(sparse 면 그 폴더만)
function fetch(url: string, sha: string, dir: string, sparse?: string) {
  if (fs.existsSync(dir)) return dir;
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a]);
  fs.mkdirSync(dir, { recursive: true });
  git("init", "-q");
  git("remote", "add", "origin", url);
  if (sparse) {
    git("config", "core.sparseCheckout", "true");
    git("sparse-checkout", "set", sparse);
  }
  git("fetch", "-q", "--depth=1", "--filter=blob:none", "origin", sha);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

// clang 이 표준 C17 로 받는지. 오래 걸려 내용 해시로 기억해 둔다
const stdFile = path.join(cache, "c17.json");
const stdMemo: Record<string, string> = fs.existsSync(stdFile)
  ? JSON.parse(fs.readFileSync(stdFile, "utf8"))
  : {};
function c17(file: string, src: string): string {
  const key = createHash("sha1").update(src).digest("hex");
  if (stdMemo[key] !== undefined) return stdMemo[key];
  let why = "";
  try {
    execFileSync(
      "clang",
      [
        "-std=c17",
        "-pedantic-errors",
        "-Werror=implicit-function-declaration",
        "-Werror=implicit-int",
        "-Werror=int-conversion",
        "-Werror=incompatible-pointer-types",
        "-Werror=return-type",
        "-fsyntax-only",
        "-w",
        file,
      ],
      { stdio: "pipe" },
    );
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? "");
    why = /error: (.*)/.exec(msg)?.[1]?.slice(0, 60) ?? "clang 거부";
  }
  stdMemo[key] = why;
  return why;
}

// 표준 밖의 것: 컴파일러 고유 이름, 우리가 모르는 헤더
const ALLOWED = new Set([
  "__func__",
  "__LINE__",
  "__FILE__",
  "__STDC__",
  "__STDC_VERSION__",
  "__DATE__",
  "__TIME__",
  "__VA_ARGS__",
  // 컴파일러마다 경고를 끄는 #ifdef 에만 쓰인다. 우리는 정의하지 않으니 그 갈래를 건너뛴다
  "__clang__",
  "__GNUC__",
]);
function outside(src: string): string | undefined {
  for (const m of src.matchAll(/\b__[A-Za-z_]\w*/g))
    if (!ALLOWED.has(m[0])) return `컴파일러 확장 ${m[0].replace(/\d+$/, "")}`;
  for (const m of src.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm))
    if (!HEADERS.includes(m[1])) return `헤더 ${m[1]}`;
}

function standard(file: string, src: string): string | undefined {
  const o = outside(src);
  if (o) return o;
  const why = c17(file, src);
  return why ? `표준 C17 아님: ${why}` : undefined;
}

// torture 는 GNU C 로 쓰였다. 뜻이 같은 표준 C 로 바꿀 수 있는 것만 바꾼다: 최적화를 막는 속성은 지우고,
// __builtin_abort 같은 이름은 표준 함수로, 선언 없이 부르는 abort·exit 등은 헤더를 넣어 선언한다.
// 이 밖의 확장이 남으면 standard() 가 건너뛴다
const ATTRS =
  /__attribute__\s*\(\(\s*(?:(?:noinline|noclone|noipa|used|unused|always_inline|__noinline__|__noclone__|__noipa__|__used__|__unused__|weak|cold|hot|noreturn|__noreturn__|const|pure|__const__|__pure__)\s*,?\s*)+\)\)/g;
const BUILTINS =
  /\b__builtin_(abort|exit|memcpy|memset|memcmp|strcmp|strcpy|strlen|printf|abs|labs)\b/g;
function gnuToStd(src: string) {
  return (
    "#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n" +
    src.replace(ATTRS, "").replace(BUILTINS, "$1")
  );
}

const SUITES: Suite[] = [
  {
    name: "c-testsuite",
    title: "c-testsuite single-exec",
    cases: () => {
      const dir = path.join(
        fetch(
          "https://github.com/c-testsuite/c-testsuite",
          "5c7275656d751de0e68b2d340a95b5681858ed07",
          path.join(cache, "c-testsuite"),
        ),
        "tests/single-exec",
      );
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".c"))
        .sort()
        .map((f) => {
          const file = path.join(dir, f);
          const src = fs.readFileSync(file, "utf8");
          return {
            name: f,
            src,
            want: {
              out: fs.readFileSync(`${file}.expected`, "utf8"),
              exit: 0,
            },
            skip: standard(file, src),
          };
        });
    },
  },
  {
    // Nora Sandler, Writing a C Compiler 의 시험. 장마다 valid(종료 코드·출력 대조)와 invalid_*(거부해야 함)
    name: "wacc",
    title: "Writing a C Compiler",
    cases: () => {
      const repo = fetch(
        "https://github.com/nlsandler/writing-a-c-compiler-tests",
        "ae12014d2dec14488f3f80d14df4b6d8e4634d7d",
        path.join(cache, "wacc"),
      );
      const expected: Record<string, { return_code: number; stdout?: string }> =
        JSON.parse(
          fs.readFileSync(path.join(repo, "expected_results.json"), "utf8"),
        );
      const props = JSON.parse(
        fs.readFileSync(path.join(repo, "test_properties.json"), "utf8"),
      );
      const multi = new Set<string>([
        ...Object.keys(props.libs ?? {}),
        ...Object.keys(props.assembly_libs ?? {}),
      ]);
      const cases: Case[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".c")) {
            const name = path.relative(path.join(repo, "tests"), p);
            const src = fs.readFileSync(p, "utf8");
            const invalid = /\/invalid_/.test(`/${name}`);
            // 여러 파일을 링크하는 것은 한 파일만 돌리는 우리 범위 밖
            const linked =
              multi.has(name) ||
              /\/(libraries|helper_libs)\//.test(name) ||
              name.includes("_client.c");
            const exp = expected[name];
            cases.push({
              name,
              src,
              want: invalid
                ? { reject: true }
                : { exit: exp?.return_code, out: exp?.stdout ?? "" },
              skip: linked
                ? "여러 파일 링크"
                : !invalid && !exp
                  ? "기대값 없음"
                  : invalid
                    ? outside(src)
                    : standard(p, src),
            });
          }
        }
      };
      walk(path.join(repo, "tests"));
      return cases.sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  {
    // GCC 의 실행 시험. 출력 없이 틀리면 abort(), 맞으면 0 으로 끝난다. GPL 이라 레포에 넣지 않고 받아 쓴다
    name: "torture",
    title: "GCC gcc.c-torture/execute",
    cases: () => {
      const dir = path.join(
        fetch(
          "https://github.com/gcc-mirror/gcc",
          "cf6e20578339f81bb1a029dedd2d3248337aabba",
          path.join(cache, "gcc"),
          "gcc/testsuite/gcc.c-torture/execute",
        ),
        "gcc/testsuite/gcc.c-torture/execute",
      );
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".c"))
        .sort()
        .map((f) => {
          const file = path.join(dir, f);
          const src = gnuToStd(fs.readFileSync(file, "utf8"));
          const tmp = path.join(cache, "torture.c");
          fs.writeFileSync(tmp, src);
          return {
            name: f,
            src,
            want: { exit: 0 },
            skip: /\{\s*dg-/.test(src)
              ? "dg 지시(특정 환경용)"
              : standard(tmp, src),
          };
        });
    },
  },
];

const key = (why: string) =>
  why
    .replace(/0x[0-9a-f]+/g, "0x…")
    .replace(/\d+/g, "N")
    .split(" ")
    .slice(0, 4)
    .join(" ");

function top(map: Map<string, string[]>, n: number) {
  for (const [k, v] of [...map]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, n))
    console.log(String(v.length).padStart(5), k, v.slice(0, 3).join(" "));
}

export function runSuites(parser: Parser, names: string[]) {
  for (const suite of SUITES.filter(
    (s) => !names.length || names.includes(s.name),
  )) {
    const cases = suite.cases();
    fs.writeFileSync(stdFile, JSON.stringify(stdMemo));
    const skipped = new Map<string, string[]>();
    const fails = new Map<string, string[]>();
    const rejects = { pass: 0, total: 0 };
    const passed: string[] = [];
    let total = 0;
    for (const c of cases) {
      if (c.skip) {
        const k = key(c.skip);
        skipped.set(k, [...(skipped.get(k) ?? []), c.name]);
        continue;
      }
      let why: string;
      let errored = false;
      try {
        const r = run(parser, c.src, { limit: 0, ops: 5_000_000 });
        errored = !!r.error;
        why = r.error
          ? r.error.msg
          : c.want.exit !== undefined && (r.exit & 0xff) !== c.want.exit
            ? `종료 코드 ${r.exit & 0xff}(기대 ${c.want.exit})`
            : c.want.out !== undefined && r.out !== c.want.out
              ? "출력 다름"
              : "";
      } catch (e) {
        errored = true;
        why = `JS 예외 ${(e as Error).message}`;
      }
      if (c.want.reject) {
        rejects.total++;
        if (errored && !why.startsWith("JS 예외")) {
          rejects.pass++;
          passed.push(c.name);
        }
        continue;
      }
      total++;
      if (!why) passed.push(c.name);
      else fails.set(key(why), [...(fails.get(key(why)) ?? []), c.name]);
    }
    const resultFile = path.join(cache, `results-${suite.name}.json`);
    const before: string[] = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : [];
    fs.writeFileSync(resultFile, JSON.stringify(passed));
    const now = new Set(passed);
    const broke = before.filter((n) => !now.has(n));

    const ok = passed.length - rejects.pass;
    console.log(
      `\n${suite.title}: 표준 C 실행 ${ok}/${total} (${Math.round((ok / Math.max(total, 1)) * 100)}%)` +
        (rejects.total
          ? `, 잘못된 프로그램 거부 ${rejects.pass}/${rejects.total}`
          : "") +
        `, 건너뜀 ${cases.length - total - rejects.total}`,
    );
    if (broke.length)
      console.log(
        `  새로 깨진 것 ${broke.length}: ${broke.slice(0, 10).join(" ")}`,
      );
    console.log("  실패:");
    top(fails, 25);
    console.log("  건너뜀:");
    top(skipped, 12);
  }
}
