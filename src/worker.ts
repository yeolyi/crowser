// 해석기를 워커에서 돌린다(오래 도는 프로그램에도 화면이 멈추지 않고, 워커를 내려 끊을 수 있게)
import { run } from "./interp.ts";

export type ToWorker = {
  id: number;
  code: string;
  options: { limit?: number; ops?: number; finish?: boolean };
};

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const { id, code, options } = e.data;
  const t = performance.now();
  // 다 돈 뒤 메모리를 읽는 함수(read)는 워커 밖으로 보낼 수 없어 뺀다
  const { read: _, ...result } = run(code, options);
  self.postMessage({ id, result, seconds: (performance.now() - t) / 1000 });
};
