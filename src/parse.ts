// C17 파서. 전처리를 마친 코드를 재귀 하강으로 읽어 문법 나무를 만든다.
// typedef 이름을 기억하며 읽는다: C 는 T * x; 가 곱셈인지 선언인지를 T 가 타입 이름인지로 가른다.
// 노드의 종류와 필드 이름은 tree-sitter-c 와 같게 두었다(해석기가 그 이름으로 읽는다).

export class Node {
  type: string;
  text: string;
  row: number;
  named: boolean;
  children: Node[] = [];
  namedChildren: Node[] = [];
  fields = new Map<string, Node[]>();
  /** static 지역 변수의 자리(처음 선언을 지날 때 잡아 둔다) */
  memo: number | undefined;
  /** 해석기가 이 노드를 처음 실행할 때 만들어 두는 함수 */
  code: unknown;

  constructor(type: string, text: string, row: number, named = true) {
    this.type = type;
    this.text = text;
    this.row = row;
    this.named = named;
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

export class ParseError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

// ---------- 토큰 ----------

type Tok = {
  k: "id" | "num" | "str" | "chr" | "op" | "eof";
  v: string;
  start: number;
  end: number;
  row: number;
};

const OPS = [
  "...",
  "<<=",
  ">>=",
  "->",
  "++",
  "--",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "*=",
  "/=",
  "%=",
  "+=",
  "-=",
  "&=",
  "^=",
  "|=",
];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let row = 0;
  let i = 0;
  const push = (k: Tok["k"], start: number, startRow: number) =>
    toks.push({ k, v: src.slice(start, i), start, end: i, row: startRow });
  const quoted = (q: string) => {
    i++;
    while (i < src.length && src[i] !== q && src[i] !== "\n") {
      if (src[i] === "\\") {
        const e = src.slice(i + 1, i + 10);
        if (!ESCAPE.test(e))
          throw new ParseError(
            row,
            `알 수 없는 이스케이프 \\${e[0] ?? ""} 입니다`,
          );
        i++;
      }
      i++;
    }
    if (src[i] !== q)
      throw new ParseError(
        row,
        q === '"'
          ? '문자열의 " 가 닫히지 않았습니다'
          : "문자의 ' 가 닫히지 않았습니다",
      );
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      row++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    const start = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /\w/.test(src[i])) i++;
      const word = src.slice(start, i);
      // L"…"·u8'…' 처럼 접두사가 붙은 문자열·문자
      if (/^(L|u|U|u8)$/.test(word) && (src[i] === '"' || src[i] === "'")) {
        const q = src[i];
        quoted(q);
        push(q === '"' ? "str" : "chr", start, row);
      } else push("id", start, row);
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      // 전처리 수: 숫자·글자·점, 그리고 e+ p- 같은 지수 부호
      i++;
      while (
        i < src.length &&
        (/[\w.]/.test(src[i]) ||
          (/[+-]/.test(src[i]) && /[eEpP]/.test(src[i - 1])))
      )
        i++;
      const v = src.slice(start, i);
      if (!NUMBER.test(v))
        throw new ParseError(row, `수 ${v} 의 모양이 잘못됐습니다`);
      push("num", start, row);
      continue;
    }
    if (c === '"' || c === "'") {
      quoted(c);
      push(c === '"' ? "str" : "chr", start, row);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    i += op ? op.length : 1;
    if (!op && !/[-+*/%<>=!~&|^?:;,.()[\]{}]/.test(c))
      throw new ParseError(row, `C 에 없는 글자 ${c}`);
    push("op", start, row);
  }
  toks.push({ k: "eof", v: "", start: src.length, end: src.length, row });
  return toks;
}

// 정수(10·8·16진수와 u·l 접미사)와 실수(10·16진수)
const NUMBER = new RegExp(
  [
    /^(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)(?:[uU](?:l|L|ll|LL)?|(?:l|L|ll|LL)[uU]?)?$/,
    /^(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)[fFlL]?$/,
    /^0[xX](?:[\da-fA-F]*\.[\da-fA-F]+|[\da-fA-F]+\.?)[pP][+-]?\d+[fFlL]?$/,
  ]
    .map((r) => r.source)
    .join("|"),
);

// \ 뒤에 올 수 있는 것: 정해진 글자, 8진수, \x16진수, \u·\U 유니코드
const ESCAPE =
  /^(?:['"?\\abfnrtv0-7]|x[\da-fA-F]|u[\da-fA-F]{4}|U[\da-fA-F]{8})/;

// ---------- 파서 ----------

const STORAGE = new Set([
  "typedef",
  "extern",
  "static",
  "auto",
  "register",
  "inline",
  "_Noreturn",
  "_Thread_local",
]);
const QUALIFIER = new Set(["const", "volatile", "restrict", "_Atomic"]);
const SIZED = new Set(["signed", "unsigned", "short", "long"]);
const BASE = new Set([
  "void",
  "char",
  "int",
  "float",
  "double",
  "_Bool",
  "_Complex",
]);
const KEYWORDS = new Set([
  ...STORAGE,
  ...QUALIFIER,
  ...SIZED,
  ...BASE,
  "struct",
  "union",
  "enum",
  "if",
  "else",
  "while",
  "do",
  "for",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "goto",
  "sizeof",
  "_Alignof",
  "alignof",
  "_Alignas",
  "_Generic",
  "_Static_assert",
]);
// 헤더가 typedef 로 주는 이름(해석기가 STD_TYPES 로 안다)
const STD_TYPEDEFS = [
  "size_t",
  "ssize_t",
  "ptrdiff_t",
  "intptr_t",
  "uintptr_t",
  "max_align_t",
  "wchar_t",
  "char16_t",
  "char32_t",
  "intmax_t",
  "uintmax_t",
  "va_list",
  "FILE",
  "clock_t",
  "time_t",
  ...["8", "16", "32", "64"].flatMap((n) => [
    `int${n}_t`,
    `uint${n}_t`,
    `int_least${n}_t`,
    `uint_least${n}_t`,
    `int_fast${n}_t`,
    `uint_fast${n}_t`,
  ]),
];

// 지정자 묶음(표준 순서로 놓은 글)으로 될 수 있는 것
const VALID_TYPES =
  /^(?:void|_Bool|float|double|long double|(?:(?:signed|unsigned) )?(?:char|(?:short|long|long long)(?: int)?|int)|signed|unsigned)$/;

const PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
};
const ASSIGN = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  "&=",
  "^=",
  "|=",
]);

type Kid = Node | [string, Node] | null | undefined;

export function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const is = (v: string, o = 0) => {
    const t = peek(o);
    return (t.k === "op" || t.k === "id") && t.v === v;
  };
  const fail = (msg: string, t = peek()): never => {
    throw new ParseError(t.row, msg);
  };
  const shown = (t: Tok) => (t.k === "eof" ? "파일 끝" : `'${t.v}'`);
  // 기대한 토큰을 먹고 그 토큰 노드를 돌려준다
  const expect = (v: string, what = `'${v}'`) => {
    const t = peek();
    if (!is(v)) {
      // 문장 끝의 ; 가 빠지면 다음 줄에서야 알게 된다. 빠진 줄(앞 토큰의 줄)을 알린다
      const at = v === ";" && p > 0 ? toks[p - 1] : t;
      fail(`${what} 가 와야 하는데 ${shown(t)} 가 왔습니다`, at);
    }
    p++;
    return leaf(t);
  };
  const leaf = (t: Tok, type = t.v, named = false) =>
    new Node(type, t.v, t.row, named);

  // 노드를 만든다. kids 는 [필드 이름, 노드] 나 노드(필드 없음). 글은 첫 토큰부터 마지막 토큰까지
  const make = (type: string, from: number, kids: Kid[], text?: string) => {
    const first = toks[from];
    const last = toks[Math.max(from, p - 1)];
    const n = new Node(
      type,
      text ?? src.slice(first.start, last.end),
      first.row,
    );
    for (const k of kids) {
      if (!k) continue;
      const [name, c] = Array.isArray(k) ? k : [null, k];
      n.children.push(c);
      if (c.named) n.namedChildren.push(c);
      if (name) n.fields.set(name, [...(n.fields.get(name) ?? []), c]);
    }
    return n;
  };

  // typedef 이름의 범위. 값이 true 면 타입 이름, false 면 같은 이름의 변수가 가린 것
  const scopes: Map<string, boolean>[] = [
    new Map(STD_TYPEDEFS.map((n) => [n, true])),
  ];
  const isTypedef = (name: string) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const v = scopes[i].get(name);
      if (v !== undefined) return v;
    }
    return false;
  };
  const declareName = (name: string, typedef: boolean) =>
    scopes[scopes.length - 1].set(name, typedef);
  const scoped = <T>(f: () => T): T => {
    scopes.push(new Map());
    try {
      return f();
    } finally {
      scopes.pop();
    }
  };

  // 선언이 시작되는가(타입 이름, 저장 부류, 한정자)
  const startsType = (o = 0) => {
    const t = peek(o);
    if (t.k !== "id") return false;
    if (
      STORAGE.has(t.v) ||
      QUALIFIER.has(t.v) ||
      SIZED.has(t.v) ||
      BASE.has(t.v) ||
      t.v === "struct" ||
      t.v === "union" ||
      t.v === "enum" ||
      t.v === "_Alignas" ||
      t.v === "_Static_assert"
    )
      return true;
    return isTypedef(t.v);
  };

  // --- 선언 지정자 ---
  // int long unsigned static 처럼 아무 순서로 와도 받는다. 타입 노드 하나와 저장 부류·한정자 노드들을 준다
  const specifiers = () => {
    const extras: Node[] = [];
    const words: string[] = [];
    let type: Node | null = null;
    const from = p;
    let wordRow = peek().row;
    for (;;) {
      const t = peek();
      if (t.k !== "id") break;
      if (t.v === "typedef") {
        p++;
        extras.push(leaf(t));
      } else if (STORAGE.has(t.v)) {
        p++;
        extras.push(leaf(t, "storage_class_specifier", true));
      } else if (QUALIFIER.has(t.v)) {
        p++;
        extras.push(leaf(t, "type_qualifier", true));
      } else if (t.v === "_Alignas") {
        const s = p;
        p++;
        expect("(");
        const inner = startsType() ? typeName() : expr();
        expect(")");
        extras.push(make("type_qualifier", s, [inner]));
      } else if (SIZED.has(t.v) || BASE.has(t.v)) {
        if (type) fail(`타입이 둘입니다: ${type.text} 와 ${t.v}`);
        if (!words.length) wordRow = t.row;
        words.push(t.v);
        p++;
      } else if (t.v === "struct" || t.v === "union") {
        if (type || words.length) fail(`타입이 둘입니다(${t.v})`);
        type = structSpec();
      } else if (t.v === "enum") {
        if (type || words.length) fail("타입이 둘입니다(enum)");
        type = enumSpec();
      } else if (!type && !words.length && isTypedef(t.v)) {
        p++;
        type = leaf(t, "type_identifier", true);
      } else break;
    }
    if (words.length) {
      const sized = words.some((w) => SIZED.has(w));
      // 표준 순서로 다시 놓은 글: unsigned long int
      const rank = (w: string) =>
        w === "signed" || w === "unsigned" ? 0 : SIZED.has(w) ? 1 : 2;
      const text = [...words].sort((a, b) => rank(a) - rank(b)).join(" ");
      type = new Node(
        sized ? "sized_type_specifier" : "primitive_type",
        text,
        wordRow,
      );
      if (!sized && words.length > 1) fail(`타입이 둘입니다: ${text}`);
      if (words.includes("_Complex"))
        fail("복소수(_Complex)는 지원하지 않습니다");
      if (!VALID_TYPES.test(text)) fail(`${text} 는 없는 타입입니다`);
    }
    const storage = extras.filter(
      (e) =>
        (e.type === "typedef" || e.type === "storage_class_specifier") &&
        !/^(inline|_Noreturn|_Thread_local)$/.test(e.text),
    );
    if (storage.length > 1)
      fail(
        `저장 부류는 하나만 씁니다(${storage.map((e) => e.text).join(", ")})`,
      );
    return { type, extras, from };
  };

  const structSpec = () => {
    const from = p;
    const kw = peek().v;
    p++;
    const kwNode = leaf(toks[from]);
    let name: Node | null = null;
    if (peek().k === "id" && !KEYWORDS.has(peek().v))
      name = leaf(toks[p++], "type_identifier", true);
    let body: Node | null = null;
    if (is("{")) {
      const b = p;
      const open = expect("{");
      const kids: Node[] = [open];
      while (!is("}")) {
        if (peek().k === "eof") fail("struct 의 } 가 없습니다");
        kids.push(fieldDecl());
      }
      if (kids.length === 1) fail(`${kw} 에 멤버가 하나도 없습니다`);
      kids.push(expect("}"));
      body = make("field_declaration_list", b, kids);
    }
    if (!name && !body) fail(`${kw} 뒤에 이름이나 { 가 와야 합니다`);
    return make(`${kw}_specifier`, from, [
      kwNode,
      name && ["name", name],
      body && ["body", body],
    ]);
  };

  const fieldDecl = () => {
    const from = p;
    if (is("_Static_assert")) {
      const e = staticAssert();
      return make("field_declaration", from, [e]);
    }
    const { type, extras } = specifiers();
    if (!type)
      fail(`struct 멤버의 타입이 와야 하는데 ${shown(peek())} 가 왔습니다`);
    const kids: Kid[] = [...extras, ["type", type as Node]];
    if (!is(";"))
      for (;;) {
        if (is(":")) {
          // 이름 없는 비트 필드
          kids.push(bitfield());
        } else {
          kids.push(["declarator", declarator("field")]);
          if (is(":")) kids.push(bitfield());
        }
        if (!is(",")) break;
        kids.push(expect(","));
      }
    kids.push(expect(";"));
    return make("field_declaration", from, kids);
  };
  const bitfield = () => {
    const from = p;
    const colon = expect(":");
    return make("bitfield_clause", from, [colon, condExpr()]);
  };

  const enumSpec = () => {
    const from = p;
    const kw = leaf(toks[p++]);
    let name: Node | null = null;
    if (peek().k === "id" && !KEYWORDS.has(peek().v))
      name = leaf(toks[p++], "type_identifier", true);
    let body: Node | null = null;
    if (is("{")) {
      const b = p;
      const kids: Node[] = [expect("{")];
      while (!is("}")) {
        const e = p;
        const t = peek();
        if (t.k !== "id")
          fail(`enum 안에는 이름이 와야 하는데 ${shown(t)} 가 왔습니다`);
        p++;
        declareName(t.v, false);
        const id = leaf(t, "identifier", true);
        let value: Node | null = null;
        let eq: Node | null = null;
        if (is("=")) {
          eq = expect("=");
          value = condExpr();
        }
        kids.push(
          make("enumerator", e, [["name", id], eq, value && ["value", value]]),
        );
        if (!is(",")) break;
        kids.push(expect(","));
      }
      kids.push(expect("}"));
      body = make("enumerator_list", b, kids);
    }
    if (!name && !body) fail("enum 뒤에 이름이나 { 가 와야 합니다");
    return make("enum_specifier", from, [
      kw,
      name && ["name", name],
      body && ["body", body],
    ]);
  };

  // --- 선언자 ---
  // mode: "named" 는 이름이 꼭 있다, "abstract" 는 없다, "either" 는 매개변수처럼 둘 다 된다.
  // base: 이름 노드의 종류(변수 identifier, typedef 는 type_identifier, struct 멤버는 field_identifier)
  type Mode = "named" | "abstract" | "either";
  // 선언자가 선언하는 이름(매개변수 목록 안의 이름은 아니다)
  const nameOf = (d: Node | null): string | null => {
    for (let n = d; n; ) {
      if (/^(identifier|type_identifier|field_identifier)$/.test(n.type))
        return n.text;
      n =
        n.childForFieldName("declarator") ??
        (n.type === "parenthesized_declarator" ? n.namedChildren[0] : null);
    }
    return null;
  };
  const declarator = (
    base: "identifier" | "type" | "field",
    mode: Mode = "named",
  ): Node => {
    const from = p;
    if (is("*")) {
      const star = expect("*");
      const quals: Node[] = [];
      while (peek().k === "id" && QUALIFIER.has(peek().v))
        quals.push(leaf(toks[p++], "type_qualifier", true));
      const inner = abstractEnd() ? null : declarator(base, mode);
      if (!inner && mode === "named") fail("선언할 이름이 없습니다");
      return make(
        inner?.type.startsWith("abstract") || !inner
          ? "abstract_pointer_declarator"
          : "pointer_declarator",
        from,
        [star, ...quals, inner && ["declarator", inner]],
      );
    }
    let d: Node | null = null;
    const t = peek();
    if (
      t.k === "id" &&
      !KEYWORDS.has(t.v) &&
      mode !== "abstract" &&
      !(mode === "either" && isTypedef(t.v) && base !== "type")
    ) {
      p++;
      d = leaf(
        t,
        base === "type"
          ? "type_identifier"
          : base === "field"
            ? "field_identifier"
            : "identifier",
        true,
      );
    } else if (is("(") && parenDeclarator(mode)) {
      const open = expect("(");
      const inner = declarator(base, mode);
      const close = expect(")");
      d = make(
        inner.type.startsWith("abstract")
          ? "abstract_parenthesized_declarator"
          : "parenthesized_declarator",
        from,
        [open, inner, close],
      );
    } else if (mode === "named")
      fail(`선언할 이름이 와야 하는데 ${shown(t)} 가 왔습니다`);
    // 뒤에 붙는 [크기] 와 (매개변수)
    for (;;) {
      const abs = !d || d.type.startsWith("abstract");
      if (is("[")) {
        const open = expect("[");
        const quals: Node[] = [];
        while (
          peek().k === "id" &&
          (QUALIFIER.has(peek().v) || peek().v === "static")
        )
          quals.push(leaf(toks[p++], "type_qualifier", true));
        let size: Node | null = null;
        if (is("*") && is("]", 1)) size = leaf(toks[p++]);
        else if (!is("]")) size = assignExpr();
        const close = expect("]");
        d = make(abs ? "abstract_array_declarator" : "array_declarator", from, [
          d && ["declarator", d],
          open,
          ...quals,
          size && ["size", size],
          close,
        ]);
      } else if (is("(")) {
        const params = paramList();
        d = make(
          abs ? "abstract_function_declarator" : "function_declarator",
          from,
          [d && ["declarator", d], ["parameters", params]],
        );
      } else break;
    }
    if (!d) fail(`선언자가 와야 하는데 ${shown(peek())} 가 왔습니다`);
    return d as Node;
  };
  // 추상 선언자가 여기서 끝나는가
  const abstractEnd = () =>
    is(")") ||
    is(",") ||
    is("]") ||
    is(";") ||
    is("=") ||
    is(":") ||
    peek().k === "eof";
  // ( 가 괄호 친 선언자인가, 매개변수 목록인가
  const parenDeclarator = (mode: Mode) => {
    const n = peek(1);
    if (n.v === "*" || n.v === "(" || n.v === "[") return n.k === "op";
    if (mode === "abstract") return false;
    return n.k === "id" && !KEYWORDS.has(n.v) && !isTypedef(n.v);
  };

  const paramList = () =>
    scopedParams(() => {
      const from = p;
      const kids: Node[] = [expect("(")];
      if (!is(")"))
        for (;;) {
          if (is("...")) {
            const t = toks[p++];
            kids.push(leaf(t, "variadic_parameter", true));
            break;
          }
          const s = p;
          const { type, extras } = specifiers();
          const storage = extras.find(
            (e) =>
              e.type === "typedef" ||
              (e.type === "storage_class_specifier" && e.text !== "register"),
          );
          if (storage)
            fail(`매개변수에는 ${storage.text} 를 붙일 수 없습니다`, toks[s]);
          if (!type) {
            if (peek().k === "id")
              fail(
                "옛 K&R 함수 정의(int f(a) int a; { … })는 받지 않습니다. 매개변수마다 타입을 씁시다",
              );
            fail(`매개변수의 타입이 와야 하는데 ${shown(peek())} 가 왔습니다`);
          }
          const d =
            is(",") || is(")") ? null : declarator("identifier", "either");
          const name = nameOf(d);
          if (name) declareName(name, false);
          kids.push(
            make("parameter_declaration", s, [
              ...extras,
              ["type", type as Node],
              d && ["declarator", d],
            ]),
          );
          if (!is(",")) break;
          kids.push(expect(","));
        }
      kids.push(expect(")"));
      return make("parameter_list", from, kids);
    });
  // 매개변수 이름은 그 함수 본문까지 보인다. 본문을 읽을 때 다시 넣으려고 목록마다 남긴다
  const paramScopes = new WeakMap<Node, Map<string, boolean>>();
  const scopedParams = (f: () => Node): Node => {
    scopes.push(new Map());
    let list: Node | null = null;
    try {
      list = f();
      return list;
    } finally {
      const s = scopes.pop();
      if (list && s) paramScopes.set(list, s);
    }
  };
  // 함수 이름에 바로 붙은 function_declarator(int (*f(int a))(char) 이면 (int a) 쪽)
  const nameFunction = (d: Node | null): Node | null => {
    for (
      let n = d;
      n;
      n = n.childForFieldName("declarator") ?? n.namedChildren[0] ?? null
    ) {
      const inner = n.childForFieldName("declarator");
      if (n.type === "function_declarator" && inner) {
        let x: Node | null = inner;
        while (x?.type === "parenthesized_declarator") x = x.namedChildren[0];
        if (x?.type === "identifier") return n;
      }
      if (n.type === "identifier") return null;
    }
    return null;
  };

  const typeName = () => {
    const from = p;
    const { type, extras } = specifiers();
    if (!type) fail(`타입이 와야 하는데 ${shown(peek())} 가 왔습니다`);
    const storage = extras.find((e) => e.type !== "type_qualifier");
    if (storage)
      fail(`타입 이름에는 ${storage.text} 를 쓸 수 없습니다`, toks[from]);
    const d = abstractEnd() ? null : declarator("identifier", "abstract");
    return make("type_descriptor", from, [
      ...extras,
      ["type", type as Node],
      d && ["declarator", d],
    ]);
  };

  // --- 선언 ---
  // 선언 하나(;까지). top 이면 함수 정의일 수 있다
  const declaration = (top: boolean): Node => {
    const from = p;
    if (is("_Static_assert")) {
      const e = staticAssert();
      return make("expression_statement", from, [e, expect(";")]);
    }
    const { type, extras } = specifiers();
    if (!type)
      fail(
        extras.length
          ? `타입이 없습니다(${extras.map((e) => e.text).join(" ")} 뒤)`
          : `선언이 와야 하는데 ${shown(peek())} 가 왔습니다`,
      );
    const t = type as Node;
    const typedef = extras.some((e) => e.text === "typedef");
    // struct s { … }; 처럼 선언자가 없으면 그 타입만
    if (is(";") && !typedef) {
      p++;
      return extras.length
        ? make("declaration", from, [...extras, ["type", t]])
        : t;
    }
    const kids: Kid[] = [...extras, ["type", t]];
    for (let first = true; ; first = false) {
      const dFrom = p;
      const d = declarator(typedef ? "type" : "identifier");
      const name = nameOf(d);
      if (name) declareName(name, typedef);
      const fn = top && first && is("{") ? nameFunction(d) : null;
      if (fn) {
        if (typedef) fail("typedef 로 함수를 정의할 수 없습니다");
        const params = paramScopes.get(
          fn.childForFieldName("parameters") as Node,
        );
        const body = scoped(() => {
          for (const [k, v] of params ?? []) declareName(k, v);
          return compound();
        });
        return make("function_definition", from, [
          ...extras,
          ["type", t],
          ["declarator", d],
          ["body", body],
        ]);
      }
      if (is("=")) {
        if (typedef) fail("typedef 에는 = 로 값을 줄 수 없습니다");
        const eq = expect("=");
        const value = is("{") ? initList() : assignExpr();
        kids.push([
          "declarator",
          make("init_declarator", dFrom, [
            ["declarator", d],
            eq,
            ["value", value],
          ]),
        ]);
      } else kids.push(["declarator", d]);
      if (!is(",")) break;
      kids.push(expect(","));
    }
    kids.push(expect(";"));
    return make(typedef ? "type_definition" : "declaration", from, kids);
  };
  const staticAssert = () => {
    const from = p;
    const name = leaf(toks[p++], "identifier", true);
    const a = p;
    const open = expect("(");
    const cond = condExpr();
    const kids: Node[] = [open, cond];
    if (is(",")) {
      kids.push(expect(","));
      kids.push(primary());
    }
    kids.push(expect(")"));
    return make("call_expression", from, [
      ["function", name],
      ["arguments", make("argument_list", a, kids)],
    ]);
  };

  const initList = (): Node => {
    const from = p;
    const kids: Node[] = [expect("{")];
    if (is("}")) fail("빈 { } 초기화는 C23 부터입니다. { 0 } 을 씁니다");
    while (!is("}")) {
      const s = p;
      const designators: Kid[] = [];
      while (is("[") || is(".")) {
        const d = p;
        if (is("[")) {
          const open = expect("[");
          const e = condExpr();
          designators.push([
            "designator",
            make("subscript_designator", d, [open, e, expect("]")]),
          ]);
        } else {
          const dot = expect(".");
          const t = peek();
          if (t.k !== "id") fail(`. 뒤에 멤버 이름이 와야 합니다`);
          p++;
          designators.push([
            "designator",
            make("field_designator", d, [
              dot,
              leaf(t, "field_identifier", true),
            ]),
          ]);
        }
      }
      if (designators.length) {
        const eq = expect("=");
        const value = is("{") ? initList() : assignExpr();
        kids.push(
          make("initializer_pair", s, [...designators, eq, ["value", value]]),
        );
      } else kids.push(is("{") ? initList() : assignExpr());
      if (!is(",")) break;
      kids.push(expect(","));
    }
    kids.push(expect("}", "초기화의 '}'"));
    return make("initializer_list", from, kids);
  };

  // --- 문장 ---
  const compound = (): Node =>
    scoped(() => {
      const from = p;
      const kids: Node[] = [expect("{")];
      while (!is("}")) {
        if (peek().k === "eof") fail("{ 를 닫는 } 가 없습니다", toks[from]);
        kids.push(blockItem(true));
      }
      kids.push(expect("}"));
      return make("compound_statement", from, kids);
    });

  // 블록 안의 한 항목: 선언이나 문장
  const blockItem = (inBlock: boolean): Node => {
    // 이름: 은 레이블(타입 이름이어도 : 가 오면 레이블)
    if (peek().k === "id" && is(":", 1) && !KEYWORDS.has(peek().v))
      return statement(inBlock);
    if (startsType()) return declaration(false);
    return statement(inBlock);
  };

  const statement = (inBlock = false): Node => {
    const from = p;
    const t = peek();
    if (t.k === "op" && t.v === "{") return compound();
    if (t.k === "op" && t.v === ";")
      return make("expression_statement", from, [expect(";")]);
    if (t.k === "id" && !KEYWORDS.has(t.v) && is(":", 1)) {
      const label = leaf(toks[p++], "statement_identifier", true);
      const colon = expect(":");
      return make("labeled_statement", from, [
        ["label", label],
        colon,
        labelBody(inBlock),
      ]);
    }
    if (t.k === "id")
      switch (t.v) {
        case "if": {
          const kw = leaf(toks[p++]);
          const cond = parenExpr();
          const then = statement();
          let alt: Node | null = null;
          if (is("else")) {
            const e = p;
            const ekw = leaf(toks[p++]);
            alt = make("else_clause", e, [ekw, statement()]);
          }
          return make("if_statement", from, [
            kw,
            ["condition", cond],
            ["consequence", then],
            alt && ["alternative", alt],
          ]);
        }
        case "while": {
          const kw = leaf(toks[p++]);
          const cond = parenExpr();
          return make("while_statement", from, [
            kw,
            ["condition", cond],
            ["body", statement()],
          ]);
        }
        case "do": {
          const kw = leaf(toks[p++]);
          const body = statement();
          const w = expect("while");
          const cond = parenExpr();
          return make("do_statement", from, [
            kw,
            ["body", body],
            w,
            ["condition", cond],
            expect(";"),
          ]);
        }
        case "for":
          return scoped(() => {
            const kw = leaf(toks[p++]);
            const open = expect("(");
            let init: Node | null = null;
            let semi: Node | null = null;
            if (startsType()) init = declaration(false);
            else {
              if (!is(";")) init = expr();
              semi = expect(";");
            }
            const cond = is(";") ? null : expr();
            const semi2 = expect(";");
            const update = is(")") ? null : expr();
            const close = expect(")");
            return make("for_statement", from, [
              kw,
              open,
              init && ["initializer", init],
              semi,
              cond && ["condition", cond],
              semi2,
              update && ["update", update],
              close,
              ["body", statement()],
            ]);
          });
        case "switch": {
          const kw = leaf(toks[p++]);
          const cond = parenExpr();
          let body = statement();
          // 본문이 { } 가 아니어도 된다(switch (x) case 0: f();). 해석기는 블록으로 읽으니 감싼다
          if (body.type !== "compound_statement") {
            const block = new Node("compound_statement", body.text, body.row);
            block.children.push(body);
            block.namedChildren.push(body);
            body = block;
          }
          return make("switch_statement", from, [
            kw,
            ["condition", cond],
            ["body", body],
          ]);
        }
        case "case":
        case "default": {
          const kw = leaf(toks[p++]);
          const value = t.v === "case" ? condExpr() : null;
          const colon = expect(":", `${t.v} 뒤의 ':'`);
          // 블록 안이면 다음 case·default·} 까지의 문장이 이 case 의 몸이다
          const body: Node[] = [labelBody(inBlock)];
          if (inBlock)
            while (
              !is("}") &&
              !is("case") &&
              !is("default") &&
              peek().k !== "eof"
            )
              body.push(blockItem(true));
          return make("case_statement", from, [
            kw,
            value && ["value", value],
            colon,
            ...body,
          ]);
        }
        case "break":
        case "continue": {
          const kw = leaf(toks[p++]);
          return make(`${t.v}_statement`, from, [kw, expect(";")]);
        }
        case "return": {
          const kw = leaf(toks[p++]);
          const e = is(";") ? null : expr();
          return make("return_statement", from, [kw, e, expect(";")]);
        }
        case "goto": {
          const kw = leaf(toks[p++]);
          const l = peek();
          if (l.k !== "id") fail("goto 뒤에 레이블 이름이 와야 합니다");
          p++;
          return make("goto_statement", from, [
            kw,
            ["label", leaf(l, "statement_identifier", true)],
            expect(";"),
          ]);
        }
        case "else":
          fail("짝이 되는 if 가 없는 else 입니다");
      }
    if (startsType()) {
      fail(
        inBlock
          ? "선언이 여기 올 수 없습니다"
          : "if·while·for 의 몸에 선언만 둘 수 없습니다. { } 로 감쌉시다",
      );
    }
    const e = expr();
    return make("expression_statement", from, [e, expect(";")]);
  };

  // 레이블 바로 뒤에는 문장이 와야 한다(선언은 C23 부터)
  const labelBody = (inBlock: boolean) => {
    if (is("}")) fail("레이블 뒤에 문장이 없습니다. 빈 문장이면 ; 를 씁니다");
    if (startsType() && !is(":", 1))
      fail(
        "레이블 바로 뒤에는 선언을 둘 수 없습니다. 선언을 { } 로 감싸거나 앞에 ; 를 둡니다",
      );
    return statement(inBlock);
  };

  const parenExpr = () => {
    const from = p;
    const open = expect("(");
    const e = expr();
    return make("parenthesized_expression", from, [open, e, expect(")")]);
  };

  // --- 식 ---
  const expr = (): Node => {
    const from = p;
    let left = assignExpr();
    while (is(",")) {
      const comma = expect(",");
      const right = assignExpr();
      left = make("comma_expression", from, [
        ["left", left],
        comma,
        ["right", right],
      ]);
    }
    return left;
  };

  const assignExpr = (): Node => {
    const from = p;
    const left = condExpr();
    if (peek().k === "op" && ASSIGN.has(peek().v)) {
      const op = leaf(toks[p++]);
      const right = assignExpr();
      return make("assignment_expression", from, [
        ["left", left],
        ["operator", op],
        ["right", right],
      ]);
    }
    return left;
  };

  const condExpr = (): Node => {
    const from = p;
    const c = binary(1);
    if (!is("?")) return c;
    const q = expect("?");
    const a = expr();
    const colon = expect(":", "삼항 연산자의 ':'");
    const b = condExpr();
    return make("conditional_expression", from, [
      ["condition", c],
      q,
      ["consequence", a],
      colon,
      ["alternative", b],
    ]);
  };

  const binary = (min: number): Node => {
    const from = p;
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t.k === "op" ? PREC[t.v] : undefined;
      if (prec === undefined || prec < min) return left;
      p++;
      const right = binary(prec + 1);
      left = make("binary_expression", from, [
        ["left", left],
        ["operator", leaf(t)],
        ["right", right],
      ]);
    }
  };

  // ( 다음이 타입 이름인가(형 변환·복합 리터럴·sizeof(타입))
  const parenType = () => is("(") && startsType(1);

  const unary = (): Node => {
    const from = p;
    const t = peek();
    if (t.k === "op") {
      if (t.v === "++" || t.v === "--") {
        p++;
        const arg = unary();
        return make("update_expression", from, [
          ["operator", leaf(t)],
          ["argument", arg],
        ]);
      }
      if (t.v === "&" || t.v === "*") {
        p++;
        const arg = castExpr();
        return make("pointer_expression", from, [
          ["operator", leaf(t)],
          ["argument", arg],
        ]);
      }
      if (t.v === "-" || t.v === "+" || t.v === "!" || t.v === "~") {
        p++;
        const arg = castExpr();
        return make("unary_expression", from, [
          ["operator", leaf(t)],
          ["argument", arg],
        ]);
      }
      if (parenType()) return castExpr();
    }
    if (
      t.k === "id" &&
      (t.v === "sizeof" || t.v === "_Alignof" || t.v === "alignof")
    ) {
      const kw = leaf(toks[p++]);
      const kind =
        t.v === "sizeof" ? "sizeof_expression" : "alignof_expression";
      if (parenType()) {
        const open = expect("(");
        const ty = typeName();
        const close = expect(")");
        // sizeof (int){1} 은 복합 리터럴의 크기
        if (t.v === "sizeof" && is("{")) {
          const lit = postfix(
            make("compound_literal_expression", from + 1, [
              open,
              ["type", ty],
              close,
              ["value", initList()],
            ]),
            from + 1,
          );
          return make(kind, from, [kw, ["value", lit]]);
        }
        return make(kind, from, [kw, open, ["type", ty], close]);
      }
      if (t.v !== "sizeof") fail(`${t.v} 뒤에는 ( 타입 ) 이 와야 합니다`);
      const v = unary();
      return make(kind, from, [kw, ["value", v]]);
    }
    return postfix(primary(), from);
  };

  const castExpr = (): Node => {
    if (!parenType()) return unary();
    const from = p;
    const open = expect("(");
    const ty = typeName();
    const close = expect(")");
    if (is("{"))
      return postfix(
        make("compound_literal_expression", from, [
          open,
          ["type", ty],
          close,
          ["value", initList()],
        ]),
        from,
      );
    const v = castExpr();
    return make("cast_expression", from, [
      open,
      ["type", ty],
      close,
      ["value", v],
    ]);
  };

  const postfix = (base: Node, from: number): Node => {
    let e = base;
    for (;;) {
      const t = peek();
      if (t.k !== "op") return e;
      if (t.v === "(") {
        const a = p;
        const kids: Node[] = [expect("(")];
        if (!is(")"))
          for (;;) {
            kids.push(assignExpr());
            if (!is(",")) break;
            kids.push(expect(","));
          }
        kids.push(expect(")", "함수 인자의 ')'"));
        e = make("call_expression", from, [
          ["function", e],
          ["arguments", make("argument_list", a, kids)],
        ]);
      } else if (t.v === "[") {
        const open = expect("[");
        const i = expr();
        e = make("subscript_expression", from, [
          ["argument", e],
          open,
          ["index", i],
          expect("]"),
        ]);
      } else if (t.v === "." || t.v === "->") {
        p++;
        const f = peek();
        if (f.k !== "id") fail(`${t.v} 뒤에 멤버 이름이 와야 합니다`);
        p++;
        e = make("field_expression", from, [
          ["argument", e],
          ["operator", leaf(t)],
          ["field", leaf(f, "field_identifier", true)],
        ]);
      } else if (t.v === "++" || t.v === "--") {
        p++;
        e = make("update_expression", from, [
          ["argument", e],
          ["operator", leaf(t)],
        ]);
      } else return e;
    }
  };

  const primary = (): Node => {
    const from = p;
    const t = peek();
    switch (t.k) {
      case "num":
        p++;
        return leaf(t, "number_literal", true);
      case "chr":
        p++;
        return leaf(t, "char_literal", true);
      case "str": {
        const parts: Node[] = [];
        while (peek().k === "str")
          parts.push(leaf(toks[p++], "string_literal", true));
        return parts.length === 1
          ? parts[0]
          : make("concatenated_string", from, parts);
      }
      case "id": {
        if (t.v === "_Generic") return generic();
        if (t.v === "offsetof" && is("(", 1) && !isTypedef(t.v))
          return offsetOf();
        if (KEYWORDS.has(t.v)) fail(`식이 와야 하는데 ${shown(t)} 가 왔습니다`);
        p++;
        return leaf(t, "identifier", true);
      }
      case "op":
        if (t.v === "(") return parenExpr();
    }
    return fail(
      t.k === "eof"
        ? "식이 와야 하는데 파일이 끝났습니다"
        : `식이 와야 하는데 ${shown(t)} 가 왔습니다`,
    );
  };

  const generic = () => {
    const from = p;
    const kw = leaf(toks[p++]);
    const open = expect("(");
    const kids: Node[] = [kw, open, assignExpr()];
    while (is(",")) {
      kids.push(expect(","));
      if (is("default")) kids.push(leaf(toks[p++], "identifier", true));
      else kids.push(typeName());
      kids.push(expect(":"));
      kids.push(assignExpr());
    }
    kids.push(expect(")"));
    return make("generic_expression", from, kids);
  };

  const offsetOf = () => {
    const from = p;
    const kw = leaf(toks[p++]);
    const open = expect("(");
    const ty = typeName();
    const comma = expect(",");
    const m = peek();
    if (m.k !== "id") fail("offsetof 의 둘째 자리에는 멤버 이름이 옵니다");
    p++;
    return make("offsetof_expression", from, [
      kw,
      open,
      ["type", ty],
      comma,
      ["member", leaf(m, "field_identifier", true)],
      expect(")"),
    ]);
  };

  // --- 맨 위 ---
  const kids: Node[] = [];
  while (peek().k !== "eof") {
    if (is(";")) {
      kids.push(make("expression_statement", p, [expect(";")]));
      continue;
    }
    if (!startsType()) {
      const t = peek();
      if (t.k === "id" && is("(", 1) && !KEYWORDS.has(t.v))
        fail(
          `${t.v} 앞에 타입이 없습니다. 함수 밖에는 선언만 올 수 있고, 함수라면 int ${t.v}(…) 처럼 돌려줄 타입을 씁니다`,
        );
      fail(`함수 밖에는 선언만 올 수 있는데 ${shown(t)} 가 왔습니다`);
    }
    kids.push(declaration(true));
  }
  const root = new Node("translation_unit", src, 0);
  for (const k of kids) {
    root.children.push(k);
    root.namedChildren.push(k);
  }
  return root;
}
