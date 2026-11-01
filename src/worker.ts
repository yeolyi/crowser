// 해석기를 워커에서 돌린다(끝나지 않는 반복이 연산 한도에 걸리기까지 화면이 멈추지 않게)
import { run } from "./interp.ts";

export type ToWorker = { id: number; code: string; limit: number };

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const { id, code, limit } = e.data;
  const t = performance.now();
  // 다 돈 뒤 메모리를 읽는 함수(read)는 워커 밖으로 보낼 수 없어 뺀다
  const { read: _, ...result } = run(code, { limit });
  self.postMessage({ id, result, seconds: (performance.now() - t) / 1000 });
};
