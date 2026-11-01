// crowser: 브라우저 안 C 해석기. 전처리(cpp.ts) → 파서(parse.ts) → 해석기(interp.ts).
// 브라우저는 crowser/browser(워커) 를 쓴다. 기록은 바뀐 것만 담기니 단계의 모습은 replay 로 읽는다.
export * from "./interp.ts";
export * from "./replay.ts";
