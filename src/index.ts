// @yeolyi/c: 브라우저 안 C 해석기. tree-sitter-c 로 읽고 우리 해석기(interp.ts)로 돌린다.
// wasm 두 개(web-tree-sitter, tree-sitter-c)는 쓰는 쪽이 주소를 넘긴다. 브라우저는 @yeolyi/c/browser(워커) 를 쓴다.
import { Language, Parser } from "web-tree-sitter";

export * from "./interp.ts";

export async function loadParser(runtime: string, grammar: string) {
  await Parser.init({ locateFile: () => runtime });
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar));
  return parser;
}
