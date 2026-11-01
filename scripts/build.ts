// dist 만들기: 진입점 셋(index·browser·syntax)를 묶고, 워커는 한 파일로 묶어 browser 안에 문자열로 넣는다
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

fs.rmSync("dist", { recursive: true, force: true });

const worker = await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  write: false,
});
const code = worker.outputFiles[0].text;

await build({
  entryPoints: ["src/index.ts", "src/browser.ts", "src/syntax.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  plugins: [
    {
      name: "inline-worker",
      setup(b) {
        b.onResolve({ filter: /\/worker-url\.ts$/ }, () => ({
          path: "worker-url",
          namespace: "inline-worker",
        }));
        b.onLoad({ filter: /.*/, namespace: "inline-worker" }, () => ({
          loader: "js",
          contents: `const code = ${JSON.stringify(code)};
let url;
export const workerUrl = () =>
  (url ??= URL.createObjectURL(new Blob([code], { type: "text/javascript" })));`,
        }));
      },
    },
  ],
});

execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });

// 선언 파일의 상대 import 도 .js 로(tsc 는 JS 출력만 바꾼다)
for (const f of fs.readdirSync("dist"))
  if (f.endsWith(".d.ts")) {
    const p = `dist/${f}`;
    fs.writeFileSync(
      p,
      fs.readFileSync(p, "utf8").replace(/(from "\.\/[\w-]+)\.ts"/g, '$1.js"'),
    );
  }
