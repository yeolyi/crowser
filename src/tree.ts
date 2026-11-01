// tree-sitter 의 노드는 읽을 때마다 wasm 을 건너가 느리다(반복 100만 번에 50초).
// 실행 전에 한 번 평범한 JS 객체로 옮겨 두고 해석기는 이것만 본다.
import type { Node as TSNode } from "web-tree-sitter";

export class Node {
  type: string;
  text: string;
  row: number;
  isMissing: boolean;
  named = true;
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
    this.named = n.isNamed;
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

// tree-sitter-c 는 본문이 { } 가 아닌 switch(switch (x) case 0: f();)를 읽지 못해 switch (x) 를 ERROR 로 두고
// 본문을 그 뒤 문장으로 읽는다. 본문은 바로 다음 문장 하나인데 case 는 뒤 문장들을 다 품어 읽으니,
// 첫 문장만 남기고 나머지는 switch 뒤로 꺼낸 다음 둘을 switch 문 하나로 묶는다
export function fixSwitch(n: Node): Node {
  for (const c of n.children) fixSwitch(c);
  for (let i = 0; i < n.children.length; i++) {
    const e = n.children[i];
    const cond = e.children[1];
    const body = n.children[i + 1];
    if (
      e.type !== "ERROR" ||
      e.children.length !== 2 ||
      e.children[0].type !== "switch" ||
      cond.type !== "parenthesized_expression" ||
      !body ||
      !n.namedChildren.includes(body)
    )
      continue;
    const rest = body.type === "case_statement" ? trimCase(body) : [];
    const block = make("compound_statement", body, [body]);
    const sw = make("switch_statement", e, [e.children[0], cond, block]);
    sw.fields.set("condition", [cond]);
    sw.fields.set("body", [block]);
    sw.namedChildren = [cond, block];
    n.children.splice(i, 2, sw, ...rest);
    const j = n.namedChildren.indexOf(e);
    n.namedChildren.splice(j, 2, sw, ...rest.filter((r) => r.named));
  }
  return n;
}

// case 뒤 문장 중 첫 것만 case 에 남기고 나머지를 돌려준다
function trimCase(c: Node): Node[] {
  const colon = c.children.findIndex((k) => k.type === ":");
  const first = c.children.findIndex(
    (k, i) => i > colon && k.named && k.type !== "comment",
  );
  if (first < 0) return [];
  const rest = c.children.slice(first + 1);
  c.children = c.children.slice(0, first + 1);
  c.namedChildren = c.namedChildren.filter((k) => !rest.includes(k));
  return rest;
}

function make(type: string, at: Node, kids: Node[]): Node {
  const n = Object.create(Node.prototype) as Node;
  n.type = type;
  n.text = kids.map((k) => k.text).join(" ");
  n.row = at.row;
  n.isMissing = false;
  n.named = true;
  n.children = kids;
  n.namedChildren = kids.filter((k) => k.named);
  n.fields = new Map();
  return n;
}
