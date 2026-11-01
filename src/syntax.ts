// 실행하지 않고 C 코드를 문법 나무로만 읽는다. 다른 도구가 crowser 와 같은 문법·같은 오류 말로 C 를 읽게.
// 노드의 종류와 필드 이름은 tree-sitter-c 와 같다
import { preprocess } from "./cpp.ts";
import { Node, ParseError, parse } from "./parse.ts";

export { Node };

export type SyntaxResult =
  | { root: Node; error: null }
  | { root: null; error: { line: number; msg: string } };

/** 전처리하고 문법 나무를 만든다. 줄 번호(row, line)는 0부터 */
export function parseC(src: string): SyntaxResult {
  const pre = preprocess(src);
  if (pre.error) return { root: null, error: pre.error };
  try {
    return { root: parse(pre.code, pre.headers), error: null };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { root: null, error: { line: e.line, msg: e.message } };
  }
}
