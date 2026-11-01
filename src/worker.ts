// 해석기를 워커에서 돌린다(끝나지 않는 반복이 연산 한도에 걸리기까지 화면이 멈추지 않게)
import grammar from "tree-sitter-c/tree-sitter-c.wasm?url";
import runtime from "web-tree-sitter/web-tree-sitter.wasm?url";
import { loadParser, run } from "./index.ts";

export type ToWorker = { id: number; code: string; limit: number };

const parser = loadParser(runtime, grammar);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const { id, code, limit } = e.data;
  const p = await parser;
  const t = performance.now();
  // 다 돈 뒤 메모리를 읽는 함수(read)는 워커 밖으로 보낼 수 없어 뺀다
  const { read: _, ...result } = run(p, code, { limit });
  self.postMessage({ id, result, seconds: (performance.now() - t) / 1000 });
};
