// 브라우저에서 C 를 돌린다. 워커 하나를 띄워 두고 요청을 차례로 보낸다
import type { CResult } from "./interp.ts";
import type { ToWorker } from "./worker.ts";

export * from "./interp.ts";

export type CRun = Omit<CResult, "read"> & {
  /** 해석기가 돈 시간(진짜 C 보다 훨씬 느리다) */
  seconds: number;
};

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (r: CRun) => void>();

const start = () => {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (
    e: MessageEvent<{ id: number; result: CResult; seconds: number }>,
  ) => {
    const done = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    done?.({ ...e.data.result, seconds: e.data.seconds });
  };
  return worker;
};

/** C 코드를 돌려 줄마다의 기록을 받는다. limit 은 기록할 단계 수(넘으면 기록만 그치고 끝까지 돈다) */
export function runC(code: string, limit = 2000): Promise<CRun> {
  const w = start();
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, code, limit } satisfies ToWorker);
  });
}

/** 화면에서 멀어지면 워커를 내린다(다시 부르면 다시 띄운다) */
export function releaseC() {
  worker?.terminate();
  worker = null;
  waiting.clear();
}
