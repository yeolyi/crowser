// 브라우저에서 C 를 돌린다. 워커 하나를 띄워 두고 요청을 차례로 보낸다.
// 돌고 있는 요청을 그만두면(signal) 워커를 내리고 새로 띄워, 남은 요청을 다시 보낸다(끝나지 않는 반복도 바로 끊긴다)
import type { CResult } from "./interp.ts";
import type { ToWorker } from "./worker.ts";
import { workerUrl } from "./worker-url.ts";

export * from "./interp.ts";
export * from "./replay.ts";

export type CRun = Omit<CResult, "read"> & {
  /** 실행에 든 시간(기록까지) */
  seconds: number;
};

type Job = {
  msg: ToWorker;
  resolve: (r: CRun) => void;
  reject: (e: unknown) => void;
};

let worker: Worker | null = null;
let nextId = 0;
// 보낸 차례대로. 워커는 맨 앞 것을 돌리고 있다
const jobs = new Map<number, Job>();

const start = () => {
  if (worker) return worker;
  const w = new Worker(workerUrl(), { type: "module" });
  w.onmessage = (
    e: MessageEvent<{ id: number; result: CResult; seconds: number }>,
  ) => {
    const job = jobs.get(e.data.id);
    jobs.delete(e.data.id);
    job?.resolve({ ...e.data.result, seconds: e.data.seconds });
  };
  for (const job of jobs.values()) w.postMessage(job.msg);
  worker = w;
  return w;
};

const restart = () => {
  worker?.terminate();
  worker = null;
  if (jobs.size) start();
};

/**
 * C 코드를 돌려 줄마다의 기록을 받는다. limit 은 기록할 단계 수(넘으면 기록만 그치고 끝까지 돈다. 0 이면 기록 없이 가장 빠르게).
 * signal 로 그만두면 AbortError 로 끝난다
 */
export function runC(
  code: string,
  { limit = 2000, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<CRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = nextId++;
    const msg: ToWorker = { id, code, limit };
    jobs.set(id, { msg, resolve, reject });
    signal?.addEventListener("abort", () => {
      if (!jobs.has(id)) return;
      const running = jobs.keys().next().value === id;
      jobs.delete(id);
      reject(signal.reason);
      if (running) restart();
    });
    if (worker) worker.postMessage(msg);
    else start();
  });
}

/** 워커를 내린다(다시 부르면 다시 띄운다). 기다리던 요청은 AbortError 로 끝난다 */
export function releaseC() {
  worker?.terminate();
  worker = null;
  for (const job of jobs.values())
    job.reject(new DOMException("released", "AbortError"));
  jobs.clear();
}
