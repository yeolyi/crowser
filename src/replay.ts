// 바뀐 것만 담긴 기록(CResult.steps)에서 단계 i 의 모습을 다시 만든다.
// 몇 단계마다 모습을 통째로 남겨 두고(MARK), 그 사이는 가까운 것부터 바뀐 것을 차례로 얹는다
import type { CBlock, CChange, CStep, CVar } from "./interp.ts";

const MARK = 128;

const apply = (s: CStep, c: CChange): CStep => {
  let frames = s.frames;
  if (c.depth !== undefined || c.frames) {
    frames = s.frames.slice(0, c.depth ?? s.frames.length);
    for (const [i, f] of c.frames ?? []) frames[i] = f;
  }
  let globals = s.globals;
  if (c.globals) {
    globals = [...s.globals];
    for (const v of c.globals) {
      const i = globals.findIndex((g) => g.name === v.name && g.addr === v.addr);
      if (i < 0) globals.push(v);
      else globals[i] = v;
    }
  }
  let heap = s.heap;
  if (c.heap) {
    heap = [...s.heap];
    for (const b of c.heap) {
      // 블록은 주소 순서로 쌓이니 끝에서부터 찾는다
      const i = heap.findLastIndex((h) => h.addr === b.addr);
      if (i < 0) heap.push(b);
      else heap[i] = b;
    }
  }
  return { line: c.line, frames, globals, heap, out: s.out + (c.out ?? "") };
};

const EMPTY: CStep = {
  line: 0,
  frames: [],
  globals: [] as CVar[],
  heap: [] as CBlock[],
  out: "",
};

/** 기록을 단계별 모습으로 읽는다. at(i) 는 MARK 단계 이내만 다시 얹어 빠르다 */
export function replay(steps: CChange[]) {
  const marks: CStep[] = [];
  let s = EMPTY;
  steps.forEach((c, i) => {
    s = apply(s, c);
    if (i % MARK === 0) marks.push(s);
  });
  return {
    length: steps.length,
    /** 처음부터 차례로(단계마다 바뀐 것 하나씩만 얹는다) */
    *[Symbol.iterator](): Generator<CStep> {
      let t = EMPTY;
      for (const c of steps) {
        t = apply(t, c);
        yield t;
      }
    },
    at(i: number): CStep {
      const k = Math.floor(i / MARK);
      let t = marks[k];
      for (let j = k * MARK + 1; j <= i; j++) t = apply(t, steps[j]);
      return t;
    },
  };
}
