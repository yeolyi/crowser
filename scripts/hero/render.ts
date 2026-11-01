// README 의 움직이는 그림(hero.gif)을 만든다: demo.c 를 crowser 로 돌린 기록을 단계마다 그려 이어 붙인다.
// node scripts/hero/render.ts (ffmpeg 필요)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { type CStep, replay, run } from "../../src/index.ts";

const dir = import.meta.dirname;
const src = fs.readFileSync(path.join(dir, "demo.c"), "utf8");
const steps = replay(run(src).steps);
const lines = src.trimEnd().split("\n");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const KW =
  /\b(struct|int|void|return|for|while|if|else|sizeof|char|NULL)\b|(#include\s*<[^>]+>)|(\b\d+\b)|("[^"]*")|\b(malloc|free|printf|push|main)\b(?=\()/g;
const highlight = (line: string) =>
  esc(line).replace(KW, (m, kw, inc, num, str, fn) =>
    kw
      ? `<b class=k>${m}</b>`
      : inc
        ? `<b class=i>${m}</b>`
        : num
          ? `<b class=n>${m}</b>`
          : str
            ? `<b class=s>${m}</b>`
            : fn
              ? `<b class=f>${m}</b>`
              : m,
  );
const hex = (a: number) => `0x${a.toString(16)}`;

const page = (s: CStep, i: number) => `<!doctype html><meta charset=utf-8>
<style>
* { box-sizing: border-box; margin: 0; }
body { width: 1100px; height: 760px; background: #0b0d12; font: 15px/1.6 "SF Mono", Menlo, monospace; color: #c9d1d9; padding: 28px; }
.win { height: 100%; border: 1px solid #262b36; border-radius: 14px; background: #11141b; display: grid; grid-template-columns: 1fr 400px; overflow: hidden; }
.bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #262b36; font: 13px -apple-system, sans-serif; color: #7d8590; }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #2d333f; }
.bar span { margin-left: 10px; }
.bar em { margin-left: auto; font-style: normal; color: #58a6ff; }
.code { padding: 12px 0; border-right: 1px solid #262b36; }
.code div { padding: 0 16px; white-space: pre; height: 20.5px; line-height: 20.5px; font-size: 13.5px; }
.code u { text-decoration: none; display: inline-block; width: 28px; color: #484f58; text-align: right; margin-right: 16px; }
.code .on { background: #1f6feb33; box-shadow: inset 3px 0 #58a6ff; }
.code .on u { color: #58a6ff; }
.k { color: #ff7b72; font-weight: normal; } .n { color: #79c0ff; font-weight: normal; } .s { color: #a5d6ff; font-weight: normal; } .f { color: #d2a8ff; font-weight: normal; } .i { color: #8b949e; font-weight: normal; }
.side { padding: 16px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
h3 { font: 600 11px -apple-system, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #7d8590; margin-bottom: 6px; }
.frame { border: 1px solid #262b36; border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
.frame.top { border-color: #58a6ff88; }
.frame b { font-weight: 600; color: #d2a8ff; }
.var { display: flex; justify-content: space-between; } .var span:last-child { color: #79c0ff; }
.blk { display: flex; gap: 10px; border: 1px solid #262b36; border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
.blk .a { color: #7d8590; } .blk.freed { opacity: .45; } .blk.freed .a { text-decoration: line-through; }
.out { white-space: pre; color: #7ee787; }
.empty { color: #484f58; }
</style>
<div class=win>
<div class=bar><i></i><i></i><i></i><span>list.c</span><em>step ${i + 1} / ${steps.length}</em></div>
<div class=code>${lines.map((l, j) => `<div${j === s.line ? " class=on" : ""}><u>${j + 1}</u>${highlight(l)}</div>`).join("")}</div>
<div class=side>
<section><h3>Stack</h3>${s.frames
  .map(
    (f, j) =>
      `<div class="frame${j === s.frames.length - 1 ? " top" : ""}"><b>${f.func}()</b>${f.vars.map((v) => `<div class=var><span>${v.name}</span><span>${esc(v.value)}</span></div>`).join("")}</div>`,
  )
  .join("")}</section>
<section><h3>Heap</h3>${s.heap.length ? s.heap.map((b) => `<div class="blk${b.freed ? " freed" : ""}"><span class=a>${hex(b.addr)}</span><span>${b.freed ? "freed" : esc(b.value ?? "")}</span></div>`).join("") : "<div class=empty>empty</div>"}</section>
<section><h3>Output</h3><div class=out>${s.out ? esc(s.out) : "<span class=empty>—</span>"}</div></section>
</div></div>`;

const tmp = fs.mkdtempSync(path.join(dir, ".frames-"));
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
for (let i = 0; i < steps.length; i++) {
  await p.setContent(page(steps.at(i), i));
  await p.screenshot({ path: path.join(tmp, `${String(i).padStart(3, "0")}.png`) });
}
await browser.close();
// 마지막 장면은 오래 보이게
const out = path.join(dir, "../../.github/hero.gif");
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-framerate", "1.6", "-i", path.join(tmp, "%03d.png"),
  "-vf", "tpad=stop_mode=clone:stop_duration=2,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none",
  out,
]);
fs.rmSync(tmp, { recursive: true });
console.log(out, (fs.statSync(out).size / 1024).toFixed(0), "KB");
