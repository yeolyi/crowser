// tree-sitter 의 노드는 읽을 때마다 wasm 을 건너가 느리다(반복 100만 번에 50초).
// 실행 전에 한 번 평범한 JS 객체로 옮겨 두고 해석기는 이것만 본다.
import type { Node as TSNode } from "web-tree-sitter";

export class Node {
  type: string;
  text: string;
  row: number;
  isMissing: boolean;
  children: Node[] = [];
  namedChildren: Node[] = [];
  fields = new Map<string, Node[]>();
  /** static 지역 변수의 자리(처음 선언을 지날 때 잡아 둔다) */
  memo: number | undefined;

  constructor(n: TSNode) {
    this.type = n.type;
    this.text = n.text;
    this.row = n.startPosition.row;
    this.isMissing = n.isMissing;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  childForFieldName(name: string) {
    return this.fields.get(name)?.[0] ?? null;
  }
  childrenForFieldName(name: string) {
    return this.fields.get(name) ?? [];
  }
}

export function plain(root: TSNode): Node {
  const top = new Node(root);
  const c = root.walk();
  const stack = [top];
  // 커서로 한 번 훑으며 자식과 필드 이름을 함께 옮긴다
  if (c.gotoFirstChild())
    for (;;) {
      const parent = stack[stack.length - 1];
      const n = new Node(c.currentNode);
      parent.children.push(n);
      if (c.currentNode.isNamed) parent.namedChildren.push(n);
      const f = c.currentFieldName;
      if (f) parent.fields.set(f, [...(parent.fields.get(f) ?? []), n]);
      if (c.gotoFirstChild()) {
        stack.push(n);
        continue;
      }
      while (!c.gotoNextSibling()) {
        if (!c.gotoParent()) return top;
        stack.pop();
        if (stack.length === 0) return top;
      }
    }
  return top;
}

// tree-sitter-c 는 -x-- 처럼 단항 연산자(- ! ~ +) 뒤의 후위 ++·-- 를 (-x)-- 로 읽는다.
// 후위 연산자가 먼저 붙으니 -(x--) 로 고쳐 둔다
export function fixPostfix(n: Node): Node {
  for (const c of n.children) {
    const f = fixPostfix(c);
    if (f !== c) replace(n, c, f);
  }
  const arg = n.childForFieldName("argument");
  if (
    n.type !== "update_expression" ||
    n.children[0] !== arg ||
    arg.type !== "unary_expression"
  )
    return n;
  const x = arg.childForFieldName("argument");
  if (!x) return n;
  replace(n, arg, x);
  replace(arg, x, fixPostfix(n));
  return arg;
}

function replace(p: Node, old: Node, nu: Node) {
  const sub = (c: Node) => (c === old ? nu : c);
  p.children = p.children.map(sub);
  p.namedChildren = p.namedChildren.map(sub);
  for (const [k, list] of p.fields) p.fields.set(k, list.map(sub));
}
