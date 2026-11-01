// C 부분집합 해석기. tree-sitter-c 의 구문 트리를 따라가며 실행하고, 문장마다 호출 스택의 변수·힙·출력을 기록한다.
// 진짜 C 처럼 메모리는 바이트 배열 하나(16MB)다: 문자열 0x1000~, 전역 0x2000~, 힙 0x4000~(위로), 스택은 맨 끝에서 아래로 1MB.
// 전역이 커서 0x4000 을 넘으면 힙 시작을 그 뒤로 민다(작은 프로그램은 늘 같은 주소).
// 크기는 64비트 clang 과 같게(char 1, short 2, int 4, long 8, 포인터 8) 맞춰 실제 컴파일러와 출력을 대조할 수 있다.
// 진짜 C 라면 조용히 망가질 일(배열 밖 인덱스, NULL 따라가기, free 한 메모리 쓰기, 두 번 free)은 그 줄에서 멈추고 알린다.
import type { Parser } from "web-tree-sitter";
import { preprocess } from "./cpp.ts";
import { fixPostfix, type Node, plain } from "./tree.ts";

const MEM_SIZE = 0x1000000;
const STR_BASE = 0x1000;
const GLOBAL_BASE = 0x2000;
const HEAP_BASE = 0x4000;
const STACK_TOP = MEM_SIZE;
const HEAP_END = STACK_TOP - 0x100000;
// 무한 반복으로 화면이 멈추지 않게 연산 수에 한도를 둔다
const OPS_LIMIT = 20_000_000;

// ---------- 타입 ----------
type IntType = {
  k: "int";
  size: number;
  align: number;
  signed: boolean;
  name: string;
};
type PtrType = { k: "ptr"; to: CType; size: 8; align: 8 };
type ArrayType = {
  k: "array";
  of: CType;
  n: number;
  size: number;
  align: number;
};
type Field = { name: string; type: CType; offset: number };
type StructType = {
  k: "struct";
  name: string;
  union: boolean;
  fields: Field[] | null;
  size: number;
  align: number;
};
type VoidType = { k: "void"; size: 1; align: 1; name: "void" };
type FloatType = { k: "float"; size: 4 | 8; align: 4 | 8; name: string };
// 함수는 메모리에 없지만 포인터로 가리킬 수 있게 0x100 부터 가짜 주소를 하나씩 준다
type FuncType = { k: "func"; size: 1; align: 1; name: string; ret: CType };
export type CType =
  | IntType
  | FloatType
  | PtrType
  | ArrayType
  | StructType
  | VoidType
  | FuncType;

const int = (name: string, size: number, signed: boolean): IntType => ({
  k: "int",
  size,
  align: size,
  signed,
  name,
});
const T = {
  void: { k: "void", size: 1, align: 1, name: "void" } as VoidType,
  bool: int("bool", 1, false),
  char: int("char", 1, true),
  uchar: int("unsigned char", 1, false),
  short: int("short", 2, true),
  ushort: int("unsigned short", 2, false),
  int: int("int", 4, true),
  uint: int("unsigned int", 4, false),
  long: int("long", 8, true),
  ulong: int("unsigned long", 8, false),
  float: { k: "float", size: 4, align: 4, name: "float" } as FloatType,
  double: { k: "float", size: 8, align: 8, name: "double" } as FloatType,
};
const func = (ret: CType): FuncType => ({
  k: "func",
  size: 1,
  align: 1,
  name: `${typeName(ret)} ()`,
  ret,
});
const ptr = (to: CType): PtrType => ({ k: "ptr", to, size: 8, align: 8 });
// stdio 의 FILE 은 속을 볼 수 없는 struct. stdin·stdout·stderr 는 가짜 주소(메모리 맨 앞, 아무것도 없는 곳)
const FILE: CType = {
  k: "struct",
  name: "FILE",
  union: false,
  fields: [],
  size: 1,
  align: 1,
};
const STREAMS: Record<string, number> = {
  stdin: 0x10,
  stdout: 0x18,
  stderr: 0x20,
};

const STD_TYPES: Record<string, CType> = {
  va_list: ptr(T.char),
  _Bool: T.bool,
  FILE,
  clock_t: T.long,
  time_t: T.long,
  wchar_t: T.int,
  char16_t: T.ushort,
  char32_t: T.uint,
  intmax_t: T.long,
  uintmax_t: T.ulong,
  size_t: T.ulong,
  ptrdiff_t: T.long,
  intptr_t: T.long,
  uintptr_t: T.ulong,
  int8_t: T.char,
  uint8_t: T.uchar,
  int16_t: T.short,
  uint16_t: T.ushort,
  int32_t: T.int,
  uint32_t: T.uint,
  int64_t: T.long,
  uint64_t: T.ulong,
};
const arr = (of: CType, n: number): ArrayType => ({
  k: "array",
  of,
  n,
  size: of.size * n,
  align: of.align,
});

export function typeName(t: CType): string {
  switch (t.k) {
    case "ptr":
      return `${typeName(t.to)} *`;
    case "array":
      return `${typeName(t.of)}[${t.n}]`;
    case "struct":
      return `${t.union ? "union" : "struct"} ${t.name}`;
    default:
      return t.name;
  }
}

// printf 의 %f·%e·%g
function formatFloat(v: number, c: string, p: number, flags: string): string {
  const sign =
    v < 0 || Object.is(v, -0)
      ? "-"
      : flags.includes("+")
        ? "+"
        : flags.includes(" ")
          ? " "
          : "";
  const a = Math.abs(v);
  const upper = c === "F" || c === "E" || c === "G";
  let s: string;
  if (!Number.isFinite(a)) s = Number.isNaN(a) ? "nan" : "inf";
  else {
    const exp = (x: number, q: number) => {
      const [m, e] = x.toExponential(q).split("e");
      const n = Number(e);
      return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
    };
    const lc = c.toLowerCase();
    if (lc === "f") s = a.toFixed(p);
    else if (lc === "e") s = exp(a, p);
    else {
      const P = p === 0 ? 1 : p;
      const X = a === 0 ? 0 : Number(a.toExponential(P - 1).split("e")[1]);
      s = P > X && X >= -4 ? a.toFixed(P - 1 - X) : exp(a, P - 1);
      if (!flags.includes("#"))
        s = s.replace(/\.?0+(?=e|$)/, (z) =>
          z.includes(".") || s.includes(".") ? "" : z,
        );
    }
  }
  return sign + (upper ? s.toUpperCase() : s);
}

// 표준 함수가 돌려주는 값의 타입(나머지는 int). sizeof(malloc(1)) 처럼 부르지 않고 타입만 볼 때 쓴다
const BUILTIN_RET: Record<string, CType> = {
  malloc: ptr(T.void),
  calloc: ptr(T.void),
  realloc: ptr(T.void),
  free: T.void,
  memset: ptr(T.void),
  memcpy: ptr(T.void),
  strcpy: ptr(T.char),
  strcat: ptr(T.char),
  strlen: T.ulong,
  labs: T.long,
  llabs: T.long,
  atol: T.long,
  atoll: T.long,
  strtol: T.long,
  strtoll: T.long,
  strtoul: T.ulong,
  strtoull: T.ulong,
  clock: T.long,
  time: T.long,
  strchr: ptr(T.char),
  strrchr: ptr(T.char),
  strstr: ptr(T.char),
  strncpy: ptr(T.char),
  strncat: ptr(T.char),
  memmove: ptr(T.void),
  aligned_alloc: ptr(T.void),
  bsearch: ptr(T.void),
  qsort: T.void,
  atof: T.double,
  strtod: T.double,
  ...Object.fromEntries(
    `sqrt fabs floor ceil round trunc sin cos tan asin acos atan sinh cosh tanh exp exp2 log log10 log2 cbrt pow fmod atan2 hypot fmin fmax fdim copysign fma`
      .split(" ")
      .map((f) => [f, T.double]),
  ),
  srand: T.void,
  exit: T.void,
  abort: T.void,
};

// ---------- 결과 ----------
export type CVar = {
  name: string;
  type: string;
  addr: number;
  size: number;
  /** 사람이 읽는 값(포인터는 0x… 주소, NULL) */
  value: string;
};
export type CFrame = { func: string; vars: CVar[] };
export type CBlock = {
  addr: number;
  size: number;
  freed: boolean;
  /** 이 블록을 처음 가리킨 포인터의 타입으로 읽은 내용(아직 모르면 null) */
  type: string | null;
  value: string | null;
};
type Block = {
  addr: number;
  size: number;
  freed: boolean;
  ctype: CType | null;
};
export type CStep = {
  /** 이제 실행할 줄(0부터) */
  line: number;
  /** 바깥(main)부터 지금 함수까지의 호출 스택 */
  frames: CFrame[];
  globals: CVar[];
  heap: CBlock[];
  out: string;
};
export type CError = { line: number | null; msg: string };
export type CResult = {
  steps: CStep[];
  out: string;
  error: CError | null;
  exit: number;
  /** 기록 한도(limit)를 넘어 뒤쪽 단계는 기록하지 않았다(실행은 끝까지 했다) */
  truncated: boolean;
  /** free 하지 않은 힙 블록 수 */
  leaked: number;
  /** 다 돈 뒤 메모리(주소 → 바이트를 읽는 함수) */
  read: (addr: number, size: number) => number[];
};

class Fail extends Error {
  line: number | null;
  constructor(line: number | null, msg: string) {
    super(msg);
    this.line = line;
  }
}
class Return {
  v: Val | null;
  constructor(v: Val | null) {
    this.v = v;
  }
}
class Break {}
class Exit {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}
class Continue {}
class Goto {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

// 식의 결과: 값(rvalue) 또는 자리(lvalue, 주소). 배열·struct 자리는 쓸 때 바뀐다
type Val = { t: CType; v: Num; lv?: false; agg?: boolean };
type Place = { t: CType; addr: number; lv: true };
type X = Val | Place;

type Func = {
  name: string;
  addr: number;
  type: FuncType;
  ret: CType;
  params: { name: string; type: CType }[];
  /** 매개변수 뒤에 ... 가 있다 */
  variadic: boolean;
  body: Node;
};
// decl: 이 이름을 만든 선언. goto 로 같은 선언을 다시 지나면 자리를 새로 잡지 않고 다시 쓴다
type Binding = { addr: number; type: CType; decl?: Node };

const hex = (v: number) => `0x${v.toString(16)}`;

// 정수 값. 64비트 정수가 2^53 을 넘으면 JS 수로는 끝자리가 틀려 bigint 로 둔다. 그 안쪽이면 늘 number 라
// (norm) 두 값의 표현이 다르면 값도 다르고, === 비교가 그대로 맞는다
type Num = number | bigint;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const norm = (b: bigint): Num => (b >= -SAFE && b <= SAFE ? Number(b) : b);
const num = (v: Num) => (typeof v === "number" ? v : Number(v));
const big = (v: Num) =>
  typeof v === "bigint" ? v : BigInt(Number.isFinite(v) ? Math.trunc(v) : 0);
// 16진 실수 0x1.8p3 = 1.5 × 2^3 (Number 는 읽지 못한다)
const hexFloat = (text: string) => {
  const m = /^(-?)0x([0-9a-f]*)(?:\.([0-9a-f]*))?p([-+]?\d+)$/i.exec(text);
  if (!m) return Number.NaN;
  const frac = m[3] ?? "";
  const mant = Number.parseInt(`${m[2]}${frac}` || "0", 16) / 16 ** frac.length;
  return (m[1] ? -1 : 1) * mant * 2 ** Number(m[4]);
};
const neg = (v: Num): Num => (typeof v === "number" ? -v : norm(-v));
const ESC: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};
// 해석기 안의 문자열은 글자 하나가 바이트 하나다(C 처럼 strlen 이 바이트 수). 한글·이모지는 UTF-8 바이트로 넣고
// 화면에 보낼 때(text) 다시 글자로 읽는다
const utf8 = new TextEncoder();
const bytesOf = (s: string) => String.fromCharCode(...utf8.encode(s));
export const text = (bytes: string) =>
  new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
const unquote = (s: string) =>
  s.replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)|[\u0080-￿]+/g, (m, c?: string) =>
    c === undefined
      ? bytesOf(m)
      : c[0] === "x"
        ? String.fromCharCode(Number.parseInt(c.slice(1), 16) & 0xff)
        : /^[0-7]/.test(c)
          ? String.fromCharCode(Number.parseInt(c, 8) & 0xff)
          : (ESC[c] ?? c),
  );

type Tree = {
  type: string;
  isMissing: boolean;
  row?: number;
  children: (Tree | null)[];
};
function findError<N extends Tree>(n: N): N | null {
  if (n.type === "ERROR" || n.isMissing) return n;
  for (const c of n.children) {
    if (!c) continue;
    const e = findError(c as N);
    if (e) return e;
  }
  return null;
}

/** 문법 오류가 있는 첫 줄(0부터). 없으면 null. 편집기가 치는 동안 쓴다 */
export function syntaxError(parser: Parser, src: string): CError | null {
  const pre = preprocess(src);
  if (pre.error) return pre.error;
  const tree = parser.parse(pre.code);
  if (!tree) return null;
  const e = findError(plain(tree.rootNode));
  tree.delete();
  return e ? { line: e.row, msg: "문법 오류" } : null;
}

export function run(
  parser: Parser,
  src: string,
  {
    limit = 3000,
    ops: opsLimit = OPS_LIMIT,
  }: { limit?: number; ops?: number } = {},
): CResult {
  const pre = preprocess(src);
  const parsed = pre.error ? null : parser.parse(pre.code);
  const tree = parsed ? { rootNode: fixPostfix(plain(parsed.rootNode)) } : null;
  parsed?.delete();
  const mem = new DataView(new ArrayBuffer(MEM_SIZE));
  const structs = new Map<string, StructType>();
  const typedefs = new Map<string, CType>();
  const enums = new Map<string, number>();
  const funcs = new Map<string, Func>();
  const byAddr = new Map<number, Func>();
  const globals = new Map<string, Binding>();
  const heap: Block[] = [];
  // 힙 시작. 맨 위 선언을 다 읽고 전역의 끝을 안 뒤에 정한다
  let heapBase = HEAP_BASE;
  let heapTop = HEAP_BASE;
  let strTop = STR_BASE;
  // 맨 위 선언을 다 읽고 main 을 부르기 시작했는지
  let started = false;
  let globalTop = GLOBAL_BASE;
  let sp = STACK_TOP;
  let ops = 0;
  // va: 가변 인자 함수면 넘겨받은 가변 인자의 첫 칸 주소
  const frames: {
    name: string;
    scopes: Map<string, Binding>[];
    va?: number;
  }[] = [];
  const steps: CStep[] = [];
  let out = "";
  let seed = 1;
  const began = performance.now();
  let truncated = false;

  const read = (addr: number, size: number) =>
    Array.from({ length: size }, (_, i) => mem.getUint8(addr + i));
  const lineOf = (n: Node) => n.row;
  const fail = (n: Node | null, msg: string): never => {
    throw new Fail(n ? lineOf(n) : null, msg);
  };
  const field = (n: Node, name: string) =>
    n.childForFieldName(name) ?? fail(n, `${name} 이 없습니다`);

  const base = { steps, read, truncated: false };
  if (!tree)
    return {
      ...base,
      out,
      error: pre.error ?? { line: null, msg: "파싱 실패" },
      exit: 1,
      leaked: 0,
    };
  const syntaxErr = findError(tree.rootNode);
  if (syntaxErr)
    return {
      ...base,
      out,
      error: { line: lineOf(syntaxErr), msg: "문법 오류" },
      exit: 1,
      leaked: 0,
    };

  // --- 메모리 읽기·쓰기 ---
  // 힙은 앞으로만 쌓으니(주소를 다시 쓰지 않는다) 그 주소 앞에서 시작한 마지막 블록이 그 주소의 주인이다
  const blockAt = (addr: number) => heap.findLast((h) => h.addr <= addr);
  // sizeof 처럼 타입만 알면 되는 식은 계산하지 않는다(dry). 메모리를 읽고 쓰지 않고, 함수를 부르지 않고, 오류도 내지 않는다
  let dry = 0;
  const typeOnly = (n: Node): CType => {
    const savedSp = sp;
    dry++;
    try {
      return evalExpr(n).t;
    } finally {
      dry--;
      sp = savedSp;
    }
  };
  const check = (n: Node | null, addr: number, size: number) => {
    if (addr === 0) fail(n, "NULL 포인터를 따라갔습니다");
    if (addr < 0 || addr + size > MEM_SIZE)
      fail(n, `메모리 밖(${hex(addr)})을 건드렸습니다`);
    if (addr >= heapBase && addr < HEAP_END) {
      const b = blockAt(addr);
      if (!b) fail(n, `할당하지 않은 힙(${hex(addr)})을 건드렸습니다`);
      else if (b.freed) fail(n, `free 한 메모리(${hex(addr)})를 건드렸습니다`);
      else if (addr + size > b.addr + b.size)
        fail(
          n,
          `malloc 으로 받은 ${b.size}바이트 밖(${hex(addr)})을 건드렸습니다`,
        );
    }
  };
  const load = (n: Node | null, addr: number, t: CType): Num => {
    if (dry) return 0;
    check(n, addr, t.size);
    if (t.k === "ptr") return Number(mem.getBigUint64(addr, true));
    if (t.k === "float")
      return t.size === 4
        ? mem.getFloat32(addr, true)
        : mem.getFloat64(addr, true);
    if (t.k !== "int") return fail(n, `${typeName(t)} 값은 읽을 수 없습니다`);
    switch (t.size) {
      case 1:
        return t.signed ? mem.getInt8(addr) : mem.getUint8(addr);
      case 2:
        return t.signed ? mem.getInt16(addr, true) : mem.getUint16(addr, true);
      case 4:
        return t.signed ? mem.getInt32(addr, true) : mem.getUint32(addr, true);
      default:
        return norm(
          t.signed ? mem.getBigInt64(addr, true) : mem.getBigUint64(addr, true),
        );
    }
  };
  const store = (n: Node | null, addr: number, t: CType, v: Num) => {
    if (dry) return;
    check(n, addr, t.size);
    if (t.k === "ptr") return mem.setBigUint64(addr, BigInt(num(v)), true);
    if (t.k === "float")
      return t.size === 4
        ? mem.setFloat32(addr, num(v), true)
        : mem.setFloat64(addr, num(v), true);
    if (t.k !== "int") return fail(n, `${typeName(t)} 에는 쓸 수 없습니다`);
    if (t.size === 8)
      return mem.setBigUint64(addr, BigInt.asUintN(64, big(v)), true);
    const x = typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : v;
    switch (t.size) {
      case 1:
        return mem.setUint8(addr, x & 0xff);
      case 2:
        return mem.setUint16(addr, x & 0xffff, true);
      default:
        return mem.setUint32(addr, x >>> 0, true);
    }
  };
  const copy = (n: Node | null, to: number, from: number, size: number) => {
    if (dry) return;
    check(n, to, size);
    check(n, from, size);
    for (let i = 0; i < size; i++) mem.setUint8(to + i, mem.getUint8(from + i));
  };
  // C 정수 규칙: 타입 크기로 자른다
  function wrap(t: CType, v: Num): Num {
    if (t.k === "float") return t.size === 4 ? Math.fround(num(v)) : num(v);
    if (t.k !== "int") return num(v);
    if (t === T.bool) return v ? 1 : 0;
    if (t.size === 8) {
      if (typeof v === "number") {
        const x = Math.trunc(v);
        if (Number.isSafeInteger(x) && (t.signed || x >= 0)) return x;
      }
      return norm(
        t.signed ? BigInt.asIntN(64, big(v)) : BigInt.asUintN(64, big(v)),
      );
    }
    const bits = t.size * 8;
    if (typeof v === "bigint")
      return Number(
        t.signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v),
      );
    const m = 2 ** bits;
    let r = ((Math.trunc(v) % m) + m) % m;
    if (Number.isNaN(r)) r = 0;
    if (t.signed && r >= m / 2) r -= m;
    return r;
  }

  // --- 타입 읽기 ---
  const typeOf = (node: Node): CType => {
    switch (node.type) {
      case "primitive_type":
      case "sized_type_specifier": {
        const s = node.text
          .replace(/\s+/g, " ")
          .replace(/\bsigned /, "")
          .replace(/ int$/, "")
          .trim();
        const map: Record<string, CType> = {
          int: T.int,
          signed: T.int,
          char: T.char,
          void: T.void,
          bool: T.bool,
          _Bool: T.bool,
          short: T.short,
          long: T.long,
          "long long": T.long,
          float: T.float,
          double: T.double,
          "long double": T.double,
          size_t: T.ulong,
          unsigned: T.uint,
          "unsigned char": T.uchar,
          "unsigned short": T.ushort,
          "unsigned long": T.ulong,
          "unsigned long long": T.ulong,
        };
        return (
          map[s] ??
          STD_TYPES[s] ??
          fail(node, `지원하지 않는 타입 ${node.text}`)
        );
      }
      case "type_identifier": {
        const std = STD_TYPES[node.text];
        if (std) return std;
        return (
          typedefs.get(node.text) ??
          fail(node, `선언하지 않은 타입 이름 ${node.text}`)
        );
      }
      case "struct_specifier":
      case "union_specifier": {
        const union = node.type === "union_specifier";
        const name =
          node.childForFieldName("name")?.text ??
          `(익명)${node.row}:${node.text.length}`;
        const body = node.childForFieldName("body");
        const key = `${union ? "union" : "struct"} ${name}`;
        let st = structs.get(key);
        if (!st) {
          st = { k: "struct", name, union, fields: null, size: 0, align: 1 };
          structs.set(key, st);
        }
        if (body) defineStruct(st, body);
        return st;
      }
      case "enum_specifier": {
        const body = node.childForFieldName("body");
        if (body) {
          let next = 0;
          for (const e of body.namedChildren) {
            if (!e || e.type !== "enumerator") continue;
            const v = e.childForFieldName("value");
            if (v) next = constEval(v);
            enums.set(field(e, "name").text, next++);
          }
        }
        return T.int;
      }
      default:
        return fail(node, `지원하지 않는 타입 ${node.type}`);
    }
  };
  const defineStruct = (st: StructType, body: Node) => {
    const fields: Field[] = [];
    let off = 0;
    let align = 1;
    let size = 0;
    for (const fd of body.namedChildren) {
      if (!fd || fd.type !== "field_declaration") continue;
      const b = typeOf(field(fd, "type"));
      const decls = fd.childrenForFieldName("declarator");
      // 이름 없는 struct·union 멤버: 그 필드들이 바깥 struct 의 필드가 된다
      if (!decls.length && b.k === "struct") {
        off = st.union ? 0 : Math.ceil(off / b.align) * b.align;
        for (const f of b.fields ?? [])
          fields.push({ ...f, offset: off + f.offset });
        if (st.union) size = Math.max(size, b.size);
        else off += b.size;
        align = Math.max(align, b.align);
        continue;
      }
      for (const d of decls) {
        if (!d) continue;
        const { name, type } = declare(b, d);
        if (st.union) {
          fields.push({ name, type, offset: 0 });
          size = Math.max(size, type.size);
        } else {
          off = Math.ceil(off / type.align) * type.align;
          fields.push({ name, type, offset: off });
          off += type.size;
        }
        align = Math.max(align, type.align);
      }
    }
    st.fields = fields;
    st.align = align;
    st.size = Math.ceil((st.union ? size : off) / align) * align;
  };
  // 선언자를 풀어 이름과 타입을 얻는다. 바깥 선언자부터 타입을 감싸며 안으로 들어간다:
  // int *a[3] 은 [3] 이 바깥이라 (int * 의 배열 3), int (*a)[3] 은 * 가 바깥이라 (int[3] 을 가리키는 포인터).
  // 이름이 함수면 fn 에 그 함수 선언자(매개변수 목록이 있는 곳)를 준다
  const declare = (
    b: CType,
    d: Node,
  ): { name: string; type: CType; fn?: Node } => {
    switch (d.type) {
      case "identifier":
      case "field_identifier":
      case "type_identifier":
        return { name: d.text, type: b };
      case "pointer_declarator":
        return declare(ptr(b), field(d, "declarator"));
      case "array_declarator": {
        const sizeNode = d.childForFieldName("size");
        return declare(
          arr(b, sizeNode ? constEval(sizeNode) : 0),
          field(d, "declarator"),
        );
      }
      case "init_declarator":
        return declare(b, field(d, "declarator"));
      case "function_declarator": {
        // int f(int) 는 함수 원형, int (*f)(int) 는 함수를 가리키는 포인터
        const inner = field(d, "declarator");
        if (inner.type === "identifier")
          return { name: inner.text, type: func(b), fn: d };
        return declare(func(b), inner);
      }
      case "parenthesized_declarator":
        return declare(b, d.namedChildren[0] ?? fail(d, "빈 선언"));
      default:
        return fail(d, `지원하지 않는 선언 ${d.type}`);
    }
  };
  // 이름 없는 선언자(형 변환·sizeof 의 타입): 규칙은 declare 와 같다
  const abstract = (b: CType, d: Node | null): CType => {
    if (!d) return b;
    switch (d.type) {
      case "abstract_pointer_declarator":
        return abstract(ptr(b), d.childForFieldName("declarator"));
      case "abstract_array_declarator": {
        const s = d.childForFieldName("size");
        return abstract(
          arr(b, s ? constEval(s) : 0),
          d.childForFieldName("declarator"),
        );
      }
      case "abstract_function_declarator":
        return abstract(func(b), d.childForFieldName("declarator"));
      case "abstract_parenthesized_declarator":
        return abstract(
          b,
          d.namedChildren.find((c) => c.type.startsWith("abstract_")) ?? null,
        );
      default:
        return b;
    }
  };

  const constEval = (n: Node): number => num(rvalue(n, evalExpr(n)).v);

  // --- 변수 ---
  const frame = () => frames[frames.length - 1];
  const lookup = (n: Node, name: string): Binding => {
    const f = frame();
    if (f)
      for (let i = f.scopes.length - 1; i >= 0; i--) {
        const v = f.scopes[i].get(name);
        if (v) return v;
      }
    return globals.get(name) ?? fail(n, `선언하지 않은 이름 ${name}`);
  };
  const alloca = (n: Node, type: CType) => {
    sp -= type.size;
    sp -= sp % Math.max(type.align, 1);
    if (sp < HEAP_END) fail(n, "스택이 넘쳤습니다(재귀가 너무 깊습니다)");
    return sp;
  };

  // --- 값 ---
  const rvalue = (n: Node, x: X): Val => {
    if (!x.lv) return x;
    if (x.t.k === "array") return { t: ptr(x.t.of), v: x.addr };
    if (x.t.k === "struct") return { t: x.t, v: x.addr, agg: true };
    if (x.t.k === "func") return { t: x.t, v: x.addr };
    return { t: x.t, v: load(n, x.addr, x.t) };
  };

  const literal = (n: Node) =>
    n.type === "string_literal"
      ? unquote(n.text.slice(1, -1))
      : n.namedChildren.map((c) => unquote(c.text.slice(1, -1))).join("");
  const evalString = (n: Node, str: string): Place => ({
    t: arr(T.char, str.length + 1),
    addr: strAddr(str),
    lv: true,
  });
  const strings = new Map<string, number>();
  const strAddr = (s: string) => {
    const known = strings.get(s);
    if (known !== undefined) return known;
    // 문자열은 실행 전에 다 모아 둔다(collectStrings). 그 뒤에 처음 보는 것(__func__ 등)은 전역 자리에
    const a = started ? staticAlloc(null, arr(T.char, s.length + 1)) : strTop;
    for (let i = 0; i < s.length; i++) mem.setUint8(a + i, s.charCodeAt(i));
    mem.setUint8(a + s.length, 0);
    if (!started) strTop += s.length + 1;
    strings.set(s, a);
    return a;
  };
  const readStr = (n: Node, a: number) => {
    let s = "";
    for (let i = 0; i < 100000; i++) {
      const c = num(load(n, a + i, T.uchar));
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    return s;
  };
  // 정수 승격: 둘 중 큰 쪽(4바이트 미만은 int)
  const promote = (a: CType, b: CType): IntType => {
    const ai = a.k === "int" ? a : T.long;
    const bi = b.k === "int" ? b : T.long;
    const big = ai.size >= bi.size ? ai : bi;
    if (big.size < 4) return T.int;
    if (ai.size === bi.size && (!ai.signed || !bi.signed))
      return ai.size === 8 ? T.ulong : T.uint;
    return big;
  };

  const arith = (n: Node, op: string, a: Val, b: Val): Val => {
    if (a.t.k === "ptr" && b.t.k === "int" && (op === "+" || op === "-"))
      return {
        t: a.t,
        v:
          num(a.v) +
          (op === "+" ? 1 : -1) * num(b.v) * Math.max(a.t.to.size, 1),
      };
    if (a.t.k === "int" && b.t.k === "ptr" && op === "+")
      return { t: b.t, v: num(b.v) + num(a.v) * Math.max(b.t.to.size, 1) };
    if (a.t.k === "ptr" && b.t.k === "ptr" && op === "-")
      return {
        t: T.long,
        v: Math.trunc((num(a.v) - num(b.v)) / Math.max(a.t.to.size, 1)),
      };
    if (a.t.k === "float" || b.t.k === "float") return floatArith(n, op, a, b);
    // 시프트의 타입은 왼쪽 값만 보고 정한다(오른쪽은 몇 칸인지일 뿐)
    const shift = op === "<<" || op === ">>";
    const t = shift ? promote(a.t, a.t) : promote(a.t, b.t);
    const x = a.t.k === "int" ? wrap(t, a.v) : a.v;
    const y = shift ? num(b.v) : b.t.k === "int" ? wrap(t, b.v) : b.v;
    const cmp: Record<string, boolean> = {
      "<": x < y,
      ">": x > y,
      "<=": x <= y,
      ">=": x >= y,
      "==": x === y,
      "!=": x !== y,
    };
    if (op in cmp) return { t: T.int, v: cmp[op] ? 1 : 0 };
    if ((op === "/" || op === "%") && y === 0) {
      if (dry) return { t, v: 0 };
      fail(n, "0으로 나눴습니다");
    }
    if (t.size === 8) return { t, v: arith64(n, op, t, x, y) };
    return { t, v: wrap(t, arith32(n, op, t, num(x), num(y))) };
  };
  // 4바이트 이하 정수(int 로 승격된 값)
  const arith32 = (n: Node, op: string, t: IntType, x: number, y: number) => {
    let v: number;
    switch (op) {
      case "+":
        v = x + y;
        break;
      case "-":
        v = x - y;
        break;
      case "*":
        v = Math.imul(x, y);
        break;
      case "/":
        v = Math.trunc(x / y);
        break;
      case "%":
        v = x % y;
        break;
      case "&":
        v = x & y;
        break;
      case "|":
        v = x | y;
        break;
      case "^":
        v = x ^ y;
        break;
      case "<<":
        v = x * 2 ** (y & 31);
        break;
      case ">>":
        v = t.signed ? x >> y : x >>> y;
        break;
      default:
        return fail(n, `지원하지 않는 연산자 ${op}`);
    }
    return v;
  };
  // 8바이트 정수. 결과가 2^53 안쪽이면 수로 빨리, 아니면 bigint 로 정확히
  const arith64 = (n: Node, op: string, t: IntType, x: Num, y: Num): Num => {
    if (typeof x === "number" && typeof y === "number") {
      const r =
        op === "+"
          ? x + y
          : op === "-"
            ? x - y
            : op === "*"
              ? x * y
              : op === "%"
                ? x % y
                : op === "/" && Math.abs(x) <= 0xffffffff
                  ? Math.trunc(x / y)
                  : Number.NaN;
      if (Number.isSafeInteger(r) && (t.signed || r >= 0)) return r;
    }
    const X = big(x);
    const Y = big(y);
    let v: bigint;
    switch (op) {
      case "+":
        v = X + Y;
        break;
      case "-":
        v = X - Y;
        break;
      case "*":
        v = X * Y;
        break;
      case "/":
        v = X / Y;
        break;
      case "%":
        v = X % Y;
        break;
      case "&":
        v = X & Y;
        break;
      case "|":
        v = X | Y;
        break;
      case "^":
        v = X ^ Y;
        break;
      case "<<":
        v = X << (Y & 63n);
        break;
      case ">>":
        v = X >> (Y & 63n);
        break;
      default:
        return fail(n, `지원하지 않는 연산자 ${op}`);
    }
    return wrap(t, v);
  };

  // 실수가 끼면 실수로: 하나라도 double 이면 double, 아니면 float
  const floatArith = (n: Node, op: string, a: Val, b: Val): Val => {
    const t = a.t === T.double || b.t === T.double ? T.double : T.float;
    const x = num(a.v);
    const y = num(b.v);
    const cmp: Record<string, boolean> = {
      "<": x < y,
      ">": x > y,
      "<=": x <= y,
      ">=": x >= y,
      "==": x === y,
      "!=": x !== y,
    };
    if (op in cmp) return { t: T.int, v: cmp[op] ? 1 : 0 };
    const v =
      op === "+"
        ? x + y
        : op === "-"
          ? x - y
          : op === "*"
            ? x * y
            : op === "/"
              ? x / y
              : fail(n, `실수에는 ${op}를 쓸 수 없습니다`);
    return { t, v: wrap(t, v) };
  };
  const assign = (n: Node, place: X, val: Val) => {
    if (!place.lv) return fail(n, "대입할 수 없는 자리입니다");
    // malloc 이 준 블록은 타입이 없다. 처음 담긴 포인터의 타입으로 블록을 읽어 보인다
    if (
      place.t.k === "ptr" &&
      place.t.to.k !== "void" &&
      num(val.v) >= heapBase
    ) {
      const b = heap.find((h) => h.addr === val.v);
      if (b && !b.ctype) b.ctype = place.t.to;
    }
    if (place.t.k === "struct")
      return copy(n, place.addr, num(val.v), place.t.size);
    if (place.t.k === "array")
      return fail(n, "배열에는 통째로 대입할 수 없습니다");
    if (place.t.k === "ptr" && val.t.k === "int" && val.v !== 0)
      fail(n, "정수를 포인터에 대입했습니다");
    store(n, place.addr, place.t, wrap(place.t, val.v));
  };

  // 초기화: 배열·struct 는 { … } 로, 나머지는 식으로
  const initialize = (n: Node, addr: number, type: CType, v: Node) => {
    if (type.k === "array" && v.type === "string_literal") {
      const str = unquote(v.text.slice(1, -1));
      if (str.length > type.n) fail(n, "문자열이 배열보다 깁니다");
      for (let i = 0; i < type.n; i++)
        store(n, addr + i, T.char, i < str.length ? str.charCodeAt(i) : 0);
      return;
    }
    if (v.type === "initializer_list") {
      const items = v.namedChildren.filter((x): x is Node => !!x);
      for (let i = 0; i < type.size; i++) mem.setUint8(addr + i, 0);
      if (type.k === "array") {
        // [2] = 5 처럼 자리를 지정하면 그 다음부터 이어 센다
        let i = 0;
        for (const it of items) {
          let value = it;
          if (it.type === "initializer_pair") {
            const des = field(it, "designator");
            if (des.type !== "subscript_designator")
              fail(it, "배열 초기화의 자리는 [n] 으로 씁니다");
            i = constEval(des.namedChildren[0] ?? fail(des, "자리가 없습니다"));
            value = field(it, "value");
          }
          if (i >= type.n) fail(it, "초기화 값이 배열보다 많습니다");
          initialize(n, addr + i * type.of.size, type.of, value);
          i++;
        }
        return;
      }
      if (type.k === "struct" && type.fields) {
        let i = 0;
        for (const it of items) {
          if (it.type === "initializer_pair") {
            const des = field(it, "designator").text.replace(/^\./, "");
            const fi = type.fields.findIndex((f) => f.name === des);
            if (fi < 0) fail(it, `${des} 필드가 없습니다`);
            const f = type.fields[fi];
            initialize(n, addr + f.offset, f.type, field(it, "value"));
            i = fi + 1;
          } else {
            const f =
              type.fields[i++] ?? fail(it, "초기화 값이 필드보다 많습니다");
            initialize(n, addr + f.offset, f.type, it);
          }
        }
        return;
      }
      const first = items[0];
      if (first)
        assign(n, { t: type, addr, lv: true }, rvalue(n, evalExpr(first)));
      return;
    }
    assign(n, { t: type, addr, lv: true }, rvalue(n, evalExpr(v)));
  };

  // 지금 실행 중인 곳(해석기 자체가 멈출 때 그 줄을 알리려고)
  let here: Node | null = null;
  const tick = (n: Node) => {
    here = n;
    if (++ops > opsLimit)
      fail(n, "너무 오래 걸려 멈췄습니다. 끝나지 않는 반복이 있는지 봅시다");
  };

  function evalExpr(n: Node): X {
    tick(n);
    switch (n.type) {
      case "number_literal": {
        const hexNum = /^-?0x/i.test(n.text);
        if (hexNum ? /[.pP]/.test(n.text) : /[.eE]/.test(n.text)) {
          const f = /[fF]$/.test(n.text);
          const body = n.text.replace(/[fFlL]$/, "");
          const v = hexNum ? hexFloat(body) : Number(body);
          return { t: f ? T.float : T.double, v: f ? Math.fround(v) : v };
        }
        const suffix = /[uUlL]*$/.exec(n.text)?.[0].toLowerCase() ?? "";
        // tree-sitter 가 앞의 - 까지 수에 붙여 읽을 때가 있다. 수와 단항 - 로 나눠 계산한다
        const minus = n.text.startsWith("-");
        const text = n.text.slice(minus ? 1 : 0, n.text.length - suffix.length);
        // 0 으로 시작하면 8진수(017 은 15). BigInt 가 0x·0o·0b 를 읽는다
        const v = BigInt(text.replace(/^0(?=[0-7])/, "0o"));
        // 값이 들어가는 첫 타입(C17 6.4.4.1). 10진수는 부호 있는 타입만, 16·8진수는 부호 없는 것도 거친다
        const decimal = !/^0./.test(text);
        const types = suffix.includes("u")
          ? suffix.includes("l")
            ? [T.ulong]
            : [T.uint, T.ulong]
          : suffix.includes("l")
            ? decimal
              ? [T.long]
              : [T.long, T.ulong]
            : decimal
              ? [T.int, T.long]
              : [T.int, T.uint, T.long, T.ulong];
        const fits = (t: IntType) =>
          v < 2n ** BigInt(t.size * 8 - (t.signed ? 1 : 0));
        const t = types.find(fits) ?? T.ulong;
        return { t, v: minus ? wrap(t, -v) : norm(v) };
      }
      case "char_literal":
        return { t: T.int, v: unquote(n.text.slice(1, -1)).charCodeAt(0) };
      // 문자열 상수는 char 배열이다(sizeof "ab" 는 3, 쓰면 첫 글자 주소로 바뀐다)
      case "string_literal":
      case "concatenated_string":
        return evalString(n, literal(n));
      case "null":
        return { t: ptr(T.void), v: 0 };
      case "true":
        return { t: T.int, v: 1 };
      case "false":
        return { t: T.int, v: 0 };
      case "identifier": {
        const name = n.text;
        const e = enums.get(name);
        if (e !== undefined) return { t: T.int, v: e };
        const fn = funcs.get(name);
        if (fn && !lookupMaybe(name)) return { t: fn.type, v: fn.addr };
        const stream = STREAMS[name];
        if (stream && !lookupMaybe(name)) return { t: ptr(FILE), v: stream };
        if (name === "__func__" && !lookupMaybe(name))
          return evalString(n, frame()?.name ?? "");
        // sizeof(T) 의 T 처럼 타입 이름이 식 자리에 오면 파서는 이름으로 읽는다. 값 없이 타입만 준다
        const typeName =
          !lookupMaybe(name) && (typedefs.get(name) ?? STD_TYPES[name]);
        if (typeName) return { t: typeName, v: 0 };
        const v = lookup(n, name);
        return { t: v.type, addr: v.addr, lv: true };
      }
      case "parenthesized_expression":
        return evalExpr(n.namedChildren[0] ?? fail(n, "빈 괄호"));
      case "comma_expression":
        evalExpr(field(n, "left"));
        return evalExpr(field(n, "right"));
      case "assignment_expression": {
        const op = field(n, "operator").text;
        const place = evalExpr(field(n, "left"));
        let val = rvalue(n, evalExpr(field(n, "right")));
        if (op !== "=") val = arith(n, op.slice(0, -1), rvalue(n, place), val);
        assign(n, place, val);
        return { t: place.t, v: wrap(place.t, val.v) };
      }
      case "binary_expression": {
        const op = field(n, "operator").text;
        const a = rvalue(n, evalExpr(field(n, "left")));
        if (op === "&&")
          return {
            t: T.int,
            v: a.v && rvalue(n, evalExpr(field(n, "right"))).v ? 1 : 0,
          };
        if (op === "||")
          return {
            t: T.int,
            v: a.v || rvalue(n, evalExpr(field(n, "right"))).v ? 1 : 0,
          };
        return arith(n, op, a, rvalue(n, evalExpr(field(n, "right"))));
      }
      case "unary_expression": {
        const op = field(n, "operator").text;
        const a = rvalue(n, evalExpr(field(n, "argument")));
        const t = a.t.k === "int" && a.t.size < 4 ? T.int : a.t;
        if (op === "-") return { t, v: wrap(t, neg(a.v)) };
        if (op === "+") return { t, v: a.v };
        if (op === "!") return { t: T.int, v: a.v ? 0 : 1 };
        if (op === "~")
          return { t, v: wrap(t, t.size === 8 ? ~big(a.v) : ~num(a.v)) };
        return fail(n, `지원하지 않는 연산자 ${op}`);
      }
      case "pointer_expression": {
        const op = field(n, "operator").text;
        const argNode = field(n, "argument");
        if (op === "&") {
          const x = evalExpr(argNode);
          if (x.t.k === "func")
            return { t: ptr(x.t), v: x.lv ? x.addr : num(x.v) };
          if (!x.lv) return fail(n, "주소를 얻을 수 없는 식입니다");
          return { t: ptr(x.t), v: x.addr };
        }
        const p = rvalue(n, evalExpr(argNode));
        if (p.t.k !== "ptr") return fail(n, "포인터가 아닌 것을 따라갔습니다");
        if (p.v === 0 && !dry) fail(n, "NULL 포인터를 따라갔습니다");
        return { t: p.t.to, addr: num(p.v), lv: true };
      }
      case "update_expression": {
        const op = field(n, "operator").text;
        const place = evalExpr(field(n, "argument"));
        const old = rvalue(n, place);
        const nv = arith(n, op === "++" ? "+" : "-", old, { t: T.int, v: 1 });
        assign(n, place, nv);
        const prefix = n.firstChild?.type === op;
        return prefix ? { t: old.t, v: wrap(old.t, nv.v) } : old;
      }
      case "field_expression": {
        const op = field(n, "operator").text;
        const b = evalExpr(field(n, "argument"));
        const fname = field(n, "field").text;
        let st: StructType;
        let addr: number;
        if (op === "->") {
          const p = rvalue(n, b);
          if (p.t.k !== "ptr" || p.t.to.k !== "struct")
            return fail(n, "-> 앞은 struct 포인터여야 합니다");
          st = p.t.to;
          addr = num(p.v);
          if (addr === 0 && !dry) fail(n, "NULL 포인터를 따라갔습니다");
        } else {
          if (b.t.k !== "struct") return fail(n, ". 앞은 struct 여야 합니다");
          st = b.t;
          addr = b.lv ? b.addr : num(b.v);
        }
        const f = st.fields?.find((x) => x.name === fname);
        if (!f) return fail(n, `${typeName(st)}에 ${fname} 필드가 없습니다`);
        return { t: f.type, addr: addr + f.offset, lv: true };
      }
      case "subscript_expression": {
        const arrayNode = field(n, "argument");
        const base0 = evalExpr(arrayNode);
        const a = rvalue(n, base0);
        const i = rvalue(n, evalExpr(field(n, "index")));
        if (a.t.k !== "ptr")
          return fail(n, "[] 앞은 배열이나 포인터여야 합니다");
        const iv = num(i.v);
        if (
          !dry &&
          base0.lv &&
          base0.t.k === "array" &&
          (iv < 0 || iv >= base0.t.n)
        )
          fail(
            n,
            `배열 ${arrayNode.text}[${base0.t.n}]의 범위 밖 인덱스 ${iv}입니다`,
          );
        return { t: a.t.to, addr: num(a.v) + iv * a.t.to.size, lv: true };
      }
      case "sizeof_expression": {
        const tn = n.childForFieldName("type");
        if (tn) return { t: T.ulong, v: typeOfDescriptor(tn).size };
        return { t: T.ulong, v: typeOnly(field(n, "value")).size };
      }
      case "cast_expression": {
        const t = typeOfDescriptor(field(n, "type"));
        const x = rvalue(n, evalExpr(field(n, "value")));
        if (t.k === "void") return { t, v: 0 };
        return { t, v: wrap(t, x.v) };
      }
      case "conditional_expression": {
        const c = rvalue(n, evalExpr(field(n, "condition")));
        return rvalue(
          n,
          evalExpr(field(n, c.v ? "consequence" : "alternative")),
        );
      }
      case "call_expression":
        return call(n);
      case "compound_literal_expression": {
        // (Point){1, 2}: 이름 없는 변수를 지금 함수의 스택에 잡아 초기화한다
        let t = typeOfDescriptor(field(n, "type"));
        const init = field(n, "value");
        if (t.k === "array" && !t.n) t = arr(t.of, init.namedChildren.length);
        const addr = frames.length ? alloca(n, t) : staticAlloc(n, t);
        initialize(n, addr, t, init);
        return { t, addr, lv: true };
      }
      default:
        return fail(n, `지원하지 않는 식 ${n.type}`);
    }
  }
  const lookupMaybe = (name: string) => {
    const f = frame();
    if (f) for (const s of f.scopes) if (s.has(name)) return true;
    return globals.has(name);
  };

  const typeOfDescriptor = (td: Node): CType =>
    abstract(typeOf(field(td, "type")), td.childForFieldName("declarator"));

  // --- 함수 부르기 ---
  function call(n: Node): Val {
    const fnNode = field(n, "function");
    const name = fnNode.text;
    const args = field(n, "arguments")
      .namedChildren.filter((a): a is Node => !!a)
      .map((a) => rvalue(n, evalExpr(a)));
    const arg = (i: number) =>
      args[i] ?? fail(n, `${name}에 인자가 모자랍니다`);
    const argN = (i: number) => num(arg(i).v);
    // 이름으로 부르면 표준 함수일 수 있다. 같은 이름의 변수나 직접 만든 함수가 있으면 그쪽
    const builtin =
      fnNode.type === "identifier" && !lookupMaybe(name) && !funcs.has(name);
    if (dry) {
      if (builtin) return { t: BUILTIN_RET[name] ?? T.int, v: 0 };
      const ft = rvalue(n, evalExpr(fnNode)).t;
      const fty = ft.k === "ptr" ? ft.to : ft;
      return { t: fty.k === "func" ? fty.ret : T.int, v: 0 };
    }
    if (!builtin) {
      const fv = rvalue(n, evalExpr(fnNode));
      const isFn =
        fv.t.k === "func" || (fv.t.k === "ptr" && fv.t.to.k === "func");
      const f = isFn ? byAddr.get(num(fv.v)) : undefined;
      if (!f)
        return fail(
          n,
          fv.v === 0 && isFn
            ? "NULL 함수 포인터를 불렀습니다"
            : `함수가 아닌 ${name}을 불렀습니다`,
        );
      if (
        f.variadic
          ? args.length < f.params.length
          : f.params.length !== args.length
      )
        fail(
          n,
          `${f.name}에 인자를 ${f.params.length}개${f.variadic ? " 이상" : ""} 넘겨야 합니다`,
        );
      return invoke(f, args, n);
    }
    const lib = libCall(n, name, args);
    if (lib) return lib;
    switch (name) {
      case "__va_start": {
        const va = frame().va;
        if (va === undefined)
          return fail(n, "va_start 는 가변 인자 함수 안에서만 씁니다");
        return { t: ptr(T.char), v: va };
      }
      case "__va_next": {
        // 지금 칸을 돌려주고 다음 칸으로(칸은 8바이트 단위)
        const at = argN(0);
        const cur = num(load(n, at, ptr(T.char)));
        store(n, at, ptr(T.char), cur + Math.ceil(argN(1) / 8) * 8);
        return { t: ptr(T.void), v: cur };
      }
      case "malloc":
      case "calloc": {
        const size = name === "calloc" ? argN(0) * argN(1) : argN(0);
        const addr = heapAlloc(size, n);
        for (let i = 0; i < size; i++)
          mem.setUint8(addr + i, name === "calloc" ? 0 : 0xcd);
        return { t: ptr(T.void), v: addr };
      }
      case "realloc": {
        const old = argN(0);
        const size = argN(1);
        const r = heapAlloc(size, n);
        if (old) {
          const b = heap.find((h) => h.addr === old && !h.freed);
          if (!b) fail(n, "malloc 으로 받지 않은 주소를 realloc 했습니다");
          else {
            copy(n, r, old, Math.min(b.size, size));
            b.freed = true;
          }
        }
        return { t: ptr(T.void), v: r };
      }
      case "free": {
        const a = argN(0);
        if (a === 0) return { t: T.void, v: 0 };
        const b = heap.find((h) => h.addr === a);
        if (!b) fail(n, "malloc 으로 받지 않은 주소를 free 했습니다");
        else if (b.freed) fail(n, "같은 메모리를 두 번 free 했습니다");
        else b.freed = true;
        return { t: T.void, v: 0 };
      }
      case "printf": {
        const s = format(n, readStr(n, argN(0)), args.slice(1));
        out += s;
        return { t: T.int, v: s.length };
      }
      case "fprintf": {
        const s = format(n, readStr(n, argN(1)), args.slice(2));
        out += s;
        return { t: T.int, v: s.length };
      }
      case "putchar":
        out += String.fromCharCode(argN(0) & 0xff);
        return { t: T.int, v: argN(0) };
      case "puts":
        out += `${readStr(n, argN(0))}\n`;
        return { t: T.int, v: 0 };
      case "strlen":
        return { t: T.ulong, v: readStr(n, argN(0)).length };
      case "strcmp": {
        const a = readStr(n, argN(0));
        const b = readStr(n, argN(1));
        return { t: T.int, v: a < b ? -1 : a > b ? 1 : 0 };
      }
      case "strcpy": {
        const s = readStr(n, argN(1));
        for (let i = 0; i <= s.length; i++)
          store(n, argN(0) + i, T.char, i < s.length ? s.charCodeAt(i) : 0);
        return arg(0);
      }
      case "memset":
        for (let i = 0; i < argN(2); i++)
          store(n, argN(0) + i, T.uchar, argN(1));
        return arg(0);
      case "memcpy":
        copy(n, argN(0), argN(1), argN(2));
        return arg(0);
      case "abs":
        return { t: T.int, v: Math.abs(argN(0)) };
      case "labs": {
        const v = arg(0).v;
        return { t: T.long, v: v < 0 ? neg(v) : v };
      }
      case "isdigit":
      case "isalpha":
      case "isalnum":
      case "isspace":
      case "isupper":
      case "islower": {
        const ch = String.fromCharCode(argN(0));
        const re = {
          isdigit: /\d/,
          isalpha: /[A-Za-z]/,
          isalnum: /[A-Za-z0-9]/,
          isspace: /[ \t\n\r\f\v]/,
          isupper: /[A-Z]/,
          islower: /[a-z]/,
        }[name];
        return { t: T.int, v: re.test(ch) ? 1 : 0 };
      }
      case "toupper":
      case "tolower": {
        const ch = String.fromCharCode(argN(0));
        return {
          t: T.int,
          v: (name === "toupper"
            ? ch.toUpperCase()
            : ch.toLowerCase()
          ).charCodeAt(0),
        };
      }
      case "strcat": {
        const d = argN(0);
        const at = d + readStr(n, d).length;
        const src = readStr(n, argN(1));
        for (let i = 0; i <= src.length; i++)
          store(n, at + i, T.char, i < src.length ? src.charCodeAt(i) : 0);
        return arg(0);
      }
      case "strncmp": {
        const a = readStr(n, argN(0)).slice(0, argN(2));
        const b = readStr(n, argN(1)).slice(0, argN(2));
        return { t: T.int, v: a < b ? -1 : a > b ? 1 : 0 };
      }
      case "memcmp": {
        for (let i = 0; i < argN(2); i++) {
          const d =
            num(load(n, argN(0) + i, T.uchar)) -
            num(load(n, argN(1) + i, T.uchar));
          if (d) return { t: T.int, v: d };
        }
        return { t: T.int, v: 0 };
      }
      case "assert":
        if (!argN(0))
          fail(n, `assert 가 실패했습니다: ${field(n, "arguments").text}`);
        return { t: T.void, v: 0 };
      case "abort":
        return fail(n, "abort 로 멈췄습니다");
      case "rand":
        // 같은 결과가 나오게 고정된 씨앗의 선형 합동 생성기. 0 ~ RAND_MAX(2^31-1)
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return { t: T.int, v: seed };
      case "srand":
        seed = argN(0) >>> 0;
        return { t: T.void, v: 0 };
      case "exit":
        throw new Exit(argN(0));
    }
    return fail(n, `선언하지 않은 함수 ${name}`);
  }
  // --- 표준 라이브러리(더한 것) ---
  const writeStr = (n: Node, at: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      store(n, at + i, T.char, str.charCodeAt(i));
    store(n, at + str.length, T.char, 0);
  };
  const callPtr = (n: Node, fp: Val, args: Val[]) => {
    const f = byAddr.get(num(fp.v)) ?? fail(n, "함수 포인터가 아닙니다");
    return invoke(f, args, n);
  };
  // strtol: 앞 공백, 부호, 0x·0 접두(base 0·16), 읽은 끝 위치
  const parseInt_ = (s: string, base: number) => {
    let i = 0;
    while (/\s/.test(s[i] ?? "")) i++;
    let sign = 1n;
    if (s[i] === "+" || s[i] === "-") sign = s[i++] === "-" ? -1n : 1n;
    if ((base === 0 || base === 16) && /^0[xX][0-9a-fA-F]/.test(s.slice(i))) {
      i += 2;
      base = 16;
    } else if (base === 0) base = s[i] === "0" ? 8 : 10;
    let v = 0n;
    const start = i;
    for (; i < s.length; i++) {
      const d = Number.parseInt(s[i], 36);
      if (Number.isNaN(d) || d >= base) break;
      v = v * BigInt(base) + BigInt(d);
    }
    return { v: sign * v, end: i === start ? 0 : i };
  };
  const MATH1: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    fabs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    trunc: Math.trunc,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    exp: Math.exp,
    exp2: (x) => 2 ** x,
    log: Math.log,
    log10: Math.log10,
    log2: Math.log2,
    cbrt: Math.cbrt,
  };
  const MATH2: Record<string, (x: number, y: number) => number> = {
    pow: (x, y) => x ** y,
    fmod: (x, y) => x % y,
    atan2: Math.atan2,
    hypot: Math.hypot,
    fmin: Math.min,
    fmax: Math.max,
    fdim: (x, y) => Math.max(x - y, 0),
    copysign: (x, y) => Math.abs(x) * (y < 0 || Object.is(y, -0) ? -1 : 1),
  };
  const libCall = (n: Node, name: string, args: Val[]): Val | null => {
    const a = (i: number) => args[i] ?? fail(n, `${name}에 인자가 모자랍니다`);
    const an = (i: number) => num(a(i).v);
    const f1 = MATH1[name];
    if (f1) return { t: T.double, v: f1(an(0)) };
    const f2 = MATH2[name];
    if (f2) return { t: T.double, v: f2(an(0), an(1)) };
    switch (name) {
      case "fma":
        return { t: T.double, v: an(0) * an(1) + an(2) };
      case "isnan":
        return { t: T.int, v: Number.isNaN(an(0)) ? 1 : 0 };
      case "isinf":
        return { t: T.int, v: Math.abs(an(0)) === Infinity ? 1 : 0 };
      case "isfinite":
        return { t: T.int, v: Number.isFinite(an(0)) ? 1 : 0 };
      case "signbit":
        return { t: T.int, v: an(0) < 0 || Object.is(an(0), -0) ? 1 : 0 };
      case "llabs": {
        const v = a(0).v;
        return { t: T.long, v: v < 0 ? neg(v) : v };
      }
      case "isxdigit":
      case "ispunct":
      case "isprint":
      case "isgraph":
      case "iscntrl": {
        const c = an(0);
        const ok = {
          isxdigit: /[0-9a-fA-F]/.test(String.fromCharCode(c)),
          ispunct:
            c > 32 && c < 127 && !/[0-9A-Za-z]/.test(String.fromCharCode(c)),
          isprint: c >= 32 && c < 127,
          isgraph: c > 32 && c < 127,
          iscntrl: c < 32 || c === 127,
        }[name];
        return { t: T.int, v: ok ? 1 : 0 };
      }
      case "strchr":
      case "strrchr": {
        const s = readStr(n, an(0));
        const c = String.fromCharCode(an(1) & 0xff);
        // '\0' 을 찾으면 끝 자리
        const i =
          c === "\0"
            ? s.length
            : name === "strchr"
              ? s.indexOf(c)
              : s.lastIndexOf(c);
        return { t: ptr(T.char), v: i < 0 ? 0 : an(0) + i };
      }
      case "strstr": {
        const i = readStr(n, an(0)).indexOf(readStr(n, an(1)));
        return { t: ptr(T.char), v: i < 0 ? 0 : an(0) + i };
      }
      case "strncpy": {
        const s = readStr(n, an(1));
        for (let i = 0; i < an(2); i++)
          store(n, an(0) + i, T.char, i < s.length ? s.charCodeAt(i) : 0);
        return { t: ptr(T.char), v: an(0) };
      }
      case "strncat": {
        const d = an(0);
        const s = readStr(n, an(1)).slice(0, an(2));
        writeStr(n, d + readStr(n, d).length, s);
        return { t: ptr(T.char), v: d };
      }
      case "memmove": {
        const bytes = Array.from({ length: an(2) }, (_, i) =>
          num(load(n, an(1) + i, T.uchar)),
        );
        bytes.forEach((b, i) => {
          store(n, an(0) + i, T.uchar, b);
        });
        return { t: ptr(T.void), v: an(0) };
      }
      case "atoi":
      case "atol":
      case "atoll": {
        const t = name === "atoi" ? T.int : T.long;
        return { t, v: wrap(t, parseInt_(readStr(n, an(0)), 10).v) };
      }
      case "strtol":
      case "strtoul":
      case "strtoll":
      case "strtoull": {
        const s = readStr(n, an(0));
        const r = parseInt_(s, an(2));
        if (an(1)) store(n, an(1), ptr(T.char), an(0) + r.end);
        const t = name.includes("u") ? T.ulong : T.long;
        return { t, v: wrap(t, r.v) };
      }
      case "atof":
      case "strtod": {
        const s = readStr(n, an(0));
        const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s);
        if (name === "strtod" && args.length > 1 && an(1))
          store(n, an(1), ptr(T.char), an(0) + (m ? m[0].length : 0));
        return { t: T.double, v: m ? Number(m[0]) : 0 };
      }
      case "sprintf":
      case "snprintf": {
        const sized = name === "snprintf";
        const str = format(
          n,
          readStr(n, an(sized ? 2 : 1)),
          args.slice(sized ? 3 : 2),
        );
        const room = sized ? an(1) : Number.POSITIVE_INFINITY;
        if (room > 0) writeStr(n, an(0), str.slice(0, Math.max(room - 1, 0)));
        return { t: T.int, v: str.length };
      }
      case "fputs":
        out += readStr(n, an(0));
        return { t: T.int, v: 0 };
      case "fputc":
      case "putc":
        out += String.fromCharCode(an(0) & 0xff);
        return { t: T.int, v: an(0) };
      case "fflush":
        return { t: T.int, v: 0 };
      // 입력은 없다: 늘 끝(EOF)
      case "getchar":
        return { t: T.int, v: -1 };
      case "aligned_alloc": {
        const addr = heapAlloc(an(1), n);
        for (let i = 0; i < an(1); i++) mem.setUint8(addr + i, 0xcd);
        return { t: ptr(T.void), v: addr };
      }
      case "qsort": {
        // 병합 정렬(같은 값의 순서를 지킨다). 비교 함수에는 배열 안 원소의 주소를 넘긴다
        const base = an(0);
        const count = an(1);
        const size = an(2);
        const cmp = a(3);
        const savedSp = sp;
        const tmp = alloca(n, arr(T.char, Math.max(count * size, 1)));
        const at = (i: number) => base + i * size;
        const less = (x: number, y: number) =>
          num(
            callPtr(n, cmp, [
              { t: ptr(T.void), v: x },
              { t: ptr(T.void), v: y },
            ]).v,
          ) <= 0;
        for (let w = 1; w < count; w *= 2)
          for (let lo = 0; lo < count - w; lo += 2 * w) {
            const mid = lo + w;
            const hi = Math.min(lo + 2 * w, count);
            let i = lo;
            let j = mid;
            let k = 0;
            while (i < mid || j < hi) {
              const takeLeft = j >= hi || (i < mid && less(at(i), at(j)));
              copy(n, tmp + k * size, at(takeLeft ? i++ : j++), size);
              k++;
            }
            copy(n, at(lo), tmp, (hi - lo) * size);
          }
        sp = savedSp;
        return { t: T.void, v: 0 };
      }
      case "bsearch": {
        let lo = 0;
        let hi = an(2) - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const p = an(1) + mid * an(3);
          const c = num(
            callPtr(n, a(4), [
              { t: ptr(T.void), v: an(0) },
              { t: ptr(T.void), v: p },
            ]).v,
          );
          if (c === 0) return { t: ptr(T.void), v: p };
          if (c < 0) hi = mid - 1;
          else lo = mid + 1;
        }
        return { t: ptr(T.void), v: 0 };
      }
      // time.h: 해석기가 돈 시간(마이크로초). 진짜 C 보다 훨씬 느리다
      case "clock":
        return { t: T.long, v: Math.round((performance.now() - began) * 1000) };
      case "time": {
        const v = Math.floor(Date.now() / 1000);
        if (args.length && an(0)) store(n, an(0), T.long, v);
        return { t: T.long, v };
      }
    }
    return null;
  };

  // 힙은 앞으로만 쌓는다(free 한 자리를 다시 주지 않아 free 한 뒤 건드린 것을 늘 알아챈다)
  const heapAlloc = (size: number, n: Node) => {
    heapTop = Math.ceil(heapTop / 16) * 16;
    const addr = heapTop;
    heapTop += Math.max(size, 1);
    if (heapTop > HEAP_END) fail(n, "메모리가 모자랍니다");
    heap.push({ addr, size, freed: false, ctype: null });
    return addr;
  };

  const format = (n: Node, fmt: string, args: Val[]) => {
    let i = 0;
    const next = () => args[i++] ?? fail(n, "printf 에 넘긴 값이 모자랍니다");
    return fmt.replace(
      /%([-0 +#]*)(\*|\d*)(?:\.(\*|\d*))?(hh|h|ll|l|z|j|t|L)?([diouxXcspfFeEgG%])/g,
      (
        _,
        flags: string,
        width: string,
        prec: string | undefined,
        len: string | undefined,
        c: string,
      ) => {
        if (c === "%") return "%";
        let w =
          width === "*" ? num(next().v) : Number.parseInt(width || "0", 10);
        // 폭을 음수로 넘기면 왼쪽 맞춤
        if (w < 0) {
          flags += "-";
          w = -w;
        }
        let p =
          prec === undefined
            ? null
            : prec === "*"
              ? num(next().v)
              : Number.parseInt(prec || "0", 10);
        if (p !== null && p < 0) p = null;
        const a = next();
        // 길이 수식어가 정하는 정수의 비트 수
        const bits =
          len === "hh" ? 8 : len === "h" ? 16 : len && len !== "L" ? 64 : 32;
        let s: string;
        let numeric = true;
        switch (c) {
          case "d":
          case "i": {
            const v = BigInt.asIntN(bits, big(a.v));
            s = p === 0 && v === 0n ? "" : (v < 0n ? -v : v).toString();
            if (p !== null) s = s.padStart(p, "0");
            s =
              (v < 0n
                ? "-"
                : flags.includes("+")
                  ? "+"
                  : flags.includes(" ")
                    ? " "
                    : "") + s;
            break;
          }
          case "u":
          case "o":
          case "x":
          case "X": {
            const u = BigInt.asUintN(bits, big(a.v));
            s =
              p === 0 && u === 0n
                ? ""
                : u.toString(c === "u" ? 10 : c === "o" ? 8 : 16);
            if (c === "X") s = s.toUpperCase();
            if (p !== null) s = s.padStart(p, "0");
            if (flags.includes("#") && c === "o" && !s.startsWith("0"))
              s = `0${s}`;
            if (flags.includes("#") && u !== 0n && c !== "u" && c !== "o")
              s = (c === "x" ? "0x" : "0X") + s;
            break;
          }
          case "c":
            s = String.fromCharCode(num(a.v) & 0xff);
            numeric = false;
            break;
          case "s":
            s = readStr(n, num(a.v));
            if (p !== null) s = s.slice(0, p);
            numeric = false;
            break;
          case "p":
            s = hex(num(a.v));
            numeric = false;
            break;
          default:
            s = formatFloat(num(a.v), c, p ?? 6, flags);
        }
        if (flags.includes("-")) return s.padEnd(w);
        // 정수는 정밀도를 주면 0 채우기를 하지 않는다(실수는 한다)
        if (
          flags.includes("0") &&
          numeric &&
          (p === null || /[fFeEgG]/.test(c))
        ) {
          const sign = /^[-+ ]/.test(s) ? s[0] : "";
          return sign + s.slice(sign.length).padStart(w - sign.length, "0");
        }
        return s.padStart(w);
      },
    );
  };

  function invoke(f: Func, args: Val[], at: Node): Val {
    const savedSp = sp;
    // 가변 인자: 기본 승격(float 는 double, 작은 정수는 int)을 한 값을 8바이트 칸에 차례로 놓는다
    let va: number | undefined;
    if (f.variadic) {
      const extra = args.slice(f.params.length);
      const slots = extra.map((a) => Math.ceil(Math.max(a.t.size, 8) / 8) * 8);
      va = alloca(at, arr(T.long, slots.reduce((x, y) => x + y, 0) / 8 || 1));
      let off = va;
      extra.forEach((a, i) => {
        if (a.t.k === "struct") copy(at, off, num(a.v), a.t.size);
        else if (a.t.k === "float") store(at, off, T.double, num(a.v));
        else if (a.t.k === "int") store(at, off, T.long, a.v);
        else store(at, off, ptr(T.void), num(a.v));
        off += slots[i];
      });
    }
    const fr = { name: f.name, scopes: [new Map<string, Binding>()], va };
    frames.push(fr);
    f.params.forEach((p, i) => {
      const addr = alloca(at, p.type);
      fr.scopes[0].set(p.name, { addr, type: p.type });
      assign(at, { t: p.type, addr, lv: true }, args[i]);
    });
    let ret: Val | null = null;
    try {
      exec(f.body);
    } catch (e) {
      if (!(e instanceof Return)) {
        frames.pop();
        sp = savedSp;
        if (e instanceof Goto)
          fail(at, `함수 ${f.name} 안에 레이블 ${e.label} 이 없습니다`);
        throw e;
      }
      ret = e.v;
    }
    // main 이 끝나는 순간(닫는 중괄호)을 마지막 단계로 남긴다. 변수가 사라지기 전 모습이다
    if (frames.length === 1) record(f.body.children.at(-1) ?? f.body);
    frames.pop();
    sp = savedSp;
    if (!ret) return { t: f.ret, v: 0 };
    if (f.ret.k !== "struct") return { t: f.ret, v: wrap(f.ret, ret.v) };
    // struct 를 돌려주면 부른 쪽 스택에 자리를 잡아 옮긴다. 피호출자의 자리와 겹칠 수 있어 한 번 바이트로 꺼내 둔다
    const bytes = read(num(ret.v), f.ret.size);
    const tmp = alloca(at, f.ret);
    bytes.forEach((x, i) => {
      mem.setUint8(tmp + i, x);
    });
    return { t: f.ret, v: tmp, agg: true };
  }

  // --- 기록 ---
  const show = (t: CType, addr: number, depth = 0): string => {
    try {
      if (t.k === "array") {
        if (t.of === T.char) {
          const bytes: string[] = [];
          for (let i = 0; i < t.n; i++) {
            const c = mem.getUint8(addr + i);
            if (c === 0) break;
            bytes.push(String.fromCharCode(c));
          }
          return JSON.stringify(text(bytes.join("")));
        }
        const items: string[] = [];
        for (let i = 0; i < Math.min(t.n, 20); i++)
          items.push(show(t.of, addr + i * t.of.size, depth + 1));
        return `{${items.join(", ")}${t.n > 20 ? ", …" : ""}}`;
      }
      if (t.k === "struct")
        return depth > 2
          ? "{…}"
          : `{${(t.fields ?? []).map((f) => `${f.name}: ${show(f.type, addr + f.offset, depth + 1)}`).join(", ")}}`;
      if (t.k === "ptr") {
        const v = Number(mem.getBigUint64(addr, true));
        return v === 0 ? "NULL" : hex(v);
      }
      if (t.k === "float")
        return formatFloat(num(load(null, addr, t)), "g", 6, "");
      if (t.k !== "int") return "?";
      const v = load(null, addr, t);
      if (t === T.char && v >= 32 && v < 127)
        return `${v} '${String.fromCharCode(num(v))}'`;
      return String(v);
    } catch {
      return "?";
    }
  };
  const block = (h: Block): CBlock => {
    let t = h.ctype;
    // malloc(n * sizeof(int)) 처럼 원소 여러 개면 배열로 읽는다
    if (t && t.size > 0 && h.size > t.size && h.size % t.size === 0)
      t = arr(t, h.size / t.size);
    return {
      addr: h.addr,
      size: h.size,
      freed: h.freed,
      type: t ? typeName(t) : null,
      value: t && !h.freed ? show(t, h.addr) : null,
    };
  };
  const vars = (scopes: Map<string, Binding>[]) => {
    const list: CVar[] = [];
    for (const s of scopes)
      for (const [name, { addr, type }] of s)
        list.push({
          name,
          type: typeName(type),
          addr,
          size: type.size,
          value: show(type, addr),
        });
    return list;
  };
  const record = (n: Node) => {
    if (steps.length >= limit) {
      truncated = true;
      return;
    }
    steps.push({
      line: lineOf(n),
      frames: frames.map((f) => ({ func: f.name, vars: vars(f.scopes) })),
      globals: vars([globals]),
      heap: heap.map(block),
      out: text(out),
    });
  };

  // --- 문장 ---

  const storage = (n: Node, word: string) =>
    n.namedChildren.some(
      (c) => c.type === "storage_class_specifier" && c.text === word,
    );
  const isStatic = (n: Node) => storage(n, "static");
  const staticAlloc = (n: Node | null, type: CType) => {
    globalTop = Math.ceil(globalTop / type.align) * type.align;
    const addr = globalTop;
    globalTop += type.size;
    if (globalTop > (started ? heapBase : HEAP_END - 0x100000))
      fail(n, "전역 변수가 너무 큽니다");
    return addr;
  };
  // withInit=false: goto 가 건너뛴 선언. 이름과 자리는 생기고 값은 초기화하지 않는다(static 은 원래 시작 전에 초기화된다)
  function declareLocal(n: Node, withInit = true) {
    const typeNode = field(n, "type");
    const b = typeOf(typeNode);
    for (const d of n.childrenForFieldName("declarator")) {
      if (!d) continue;
      let { name, type, fn } = declare(b, d);
      const scope = frame().scopes[frame().scopes.length - 1];
      // 블록 안의 함수 원형과 extern 선언은 바깥(전역)의 것을 이 블록에서 다시 보이게 한다
      if (fn) {
        const f = funcs.get(name);
        if (f) scope.set(name, { addr: f.addr, type: f.type });
        continue;
      }
      if (storage(n, "extern")) {
        const g =
          globals.get(name) ?? fail(d, `extern ${name} 의 정의가 없습니다`);
        scope.set(name, g);
        continue;
      }
      const init =
        d.type === "init_declarator" ? d.childForFieldName("value") : null;
      if (type.k === "array" && !type.n && init) {
        const n0 =
          init.type === "string_literal"
            ? unquote(init.text.slice(1, -1)).length + 1
            : init.namedChildren.length;
        type = arr(type.of, n0);
      }
      // static 지역 변수는 전역 자리에 한 번만 잡고 처음 한 번만 초기화한다
      if (isStatic(n)) {
        if (d.memo === undefined) {
          d.memo = staticAlloc(d, type);
          if (init) initialize(d, d.memo, type, init);
        }
        scope.set(name, { addr: d.memo, type });
        continue;
      }
      const again = scope.get(name);
      const addr =
        again?.decl === d && again.type.size === type.size
          ? again.addr
          : alloca(n, type);
      scope.set(name, { addr, type, decl: d });
      for (let i = 0; i < type.size; i++) mem.setUint8(addr + i, 0xcd); // 초기화하지 않은 값
      if (init && withInit) initialize(d, addr, type, init);
    }
  }

  // --- goto ---
  // goto 는 Goto 를 던지고, 그 레이블을 안에 품은 가장 가까운 블록이 받아 레이블이 있는 문장부터 다시 실행한다.
  // 레이블이 안쪽 블록·if·반복 안에 있으면 그 안으로 들어가며(resume) 이어 간다
  const labelMemo = new WeakMap<Node, Set<string>>();
  const labelsOf = (n: Node): Set<string> => {
    let set = labelMemo.get(n);
    if (set) return set;
    set = new Set();
    if (n.type === "labeled_statement") set.add(field(n, "label").text);
    for (const c of n.namedChildren) for (const l of labelsOf(c)) set.add(l);
    labelMemo.set(n, set);
    return set;
  };
  const labeled = (n: Node) =>
    n.namedChildren.at(-1) ?? fail(n, "레이블 뒤에 문장이 없습니다");
  const stmts = (n: Node) =>
    n.namedChildren.filter((c) => c.type !== "comment");

  function runBlock(n: Node, start: string | null) {
    frame().scopes.push(new Map());
    try {
      const kids = stmts(n);
      let target = start;
      let i = 0;
      for (;;) {
        try {
          if (target !== null) {
            const label = target;
            const at = kids.findIndex((k) => labelsOf(k).has(label));
            // 건너뛴 선언도 그 블록 안에선 이름이 있다
            for (const k of kids.slice(0, at))
              if (k.type === "declaration") declareLocal(k, false);
            target = null;
            i = at + 1;
            resume(kids[at], label);
          }
          for (; i < kids.length; i++) exec(kids[i]);
          return;
        } catch (e) {
          if (!(e instanceof Goto) || !labelsOf(n).has(e.label)) throw e;
          target = e.label;
        }
      }
    } finally {
      frame().scopes.pop();
    }
  }
  // 레이블이 n 안에 있을 때, 그 레이블부터 n 을 마저 실행한다
  function resume(n: Node, label: string) {
    switch (n.type) {
      case "labeled_statement":
        if (field(n, "label").text === label) exec(labeled(n));
        else resume(labeled(n), label);
        return;
      case "compound_statement":
        runBlock(n, label);
        return;
      case "if_statement": {
        const c = field(n, "consequence");
        if (labelsOf(c).has(label)) return resume(c, label);
        const alt = n.childForFieldName("alternative");
        if (alt)
          resume(
            alt.type === "else_clause" ? (alt.namedChildren[0] ?? alt) : alt,
            label,
          );
        return;
      }
      case "while_statement":
      case "do_statement":
        loop(n, label);
        return;
      case "for_statement":
        forLoop(n, label);
        return;
      default:
        fail(n, "이 문장 안의 레이블로는 goto 로 갈 수 없습니다");
    }
  }
  // 반복의 몸통 한 번. into 가 있으면 몸통의 그 레이블부터
  const body = (b: Node, into: string | null) => {
    try {
      if (into === null) exec(b);
      else resume(b, into);
    } catch (e) {
      if (e instanceof Break) return "break";
      if (e instanceof Continue) return "continue";
      throw e;
    }
    return null;
  };
  function loop(n: Node, into: string | null) {
    const cond = () => {
      record(n);
      return rvalue(n, evalExpr(field(n, "condition"))).v;
    };
    let first = into;
    // while 은 조건부터, do 는 몸통부터. 몸통 안으로 들어왔으면 몸통을 마저 하고 조건으로
    if (n.type === "while_statement" && first === null && !cond()) return;
    for (;;) {
      if (body(field(n, "body"), first) === "break") return;
      first = null;
      if (!cond()) return;
    }
  }
  function forLoop(n: Node, into: string | null) {
    frame().scopes.push(new Map());
    try {
      const init = n.childForFieldName("initializer");
      if (init) {
        record(n);
        if (init.type === "declaration") declareLocal(init, into === null);
        else if (into === null) evalExpr(init);
      }
      const cond = n.childForFieldName("condition");
      const upd = n.childForFieldName("update");
      let first = into;
      for (;;) {
        if (first === null) {
          record(n);
          if (cond && !rvalue(n, evalExpr(cond)).v) break;
        }
        if (body(field(n, "body"), first) === "break") break;
        first = null;
        if (upd) evalExpr(upd);
      }
    } finally {
      frame().scopes.pop();
    }
  }

  function exec(n: Node): void {
    tick(n);
    switch (n.type) {
      case "compound_statement":
        runBlock(n, null);
        return;
      case "declaration":
        record(n);
        declareLocal(n);
        return;
      case "type_definition":
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier":
        topLevel(n);
        return;
      case "expression_statement":
        record(n);
        if (n.namedChildren[0]) evalExpr(n.namedChildren[0]);
        return;
      case "return_statement": {
        record(n);
        const e = n.namedChildren[0];
        throw new Return(e ? rvalue(n, evalExpr(e)) : null);
      }
      case "if_statement": {
        record(n);
        const c = rvalue(n, evalExpr(field(n, "condition")));
        if (c.v) exec(field(n, "consequence"));
        else {
          const alt = n.childForFieldName("alternative");
          if (alt)
            exec(
              alt.type === "else_clause" ? (alt.namedChildren[0] ?? alt) : alt,
            );
        }
        return;
      }
      case "while_statement":
      case "do_statement":
        loop(n, null);
        return;
      case "for_statement":
        forLoop(n, null);
        return;
      case "switch_statement": {
        record(n);
        const v = rvalue(n, evalExpr(field(n, "condition"))).v;
        const cases = field(n, "body").namedChildren.filter(
          (c): c is Node => !!c && c.type === "case_statement",
        );
        let start = cases.findIndex((c) => {
          const val = c.childForFieldName("value");
          return val && constEval(val) === v;
        });
        if (start < 0)
          start = cases.findIndex((c) => !c.childForFieldName("value"));
        if (start < 0) return;
        try {
          for (const c of cases.slice(start))
            for (const s of c.namedChildren.slice(
              c.childForFieldName("value") ? 1 : 0,
            ))
              if (s && s.type !== "comment") exec(s);
        } catch (e) {
          if (!(e instanceof Break)) throw e;
        }
        return;
      }
      case "break_statement":
        throw new Break();
      case "continue_statement":
        throw new Continue();
      case "comment":
      case ";":
        return;
      case "labeled_statement":
        exec(labeled(n));
        return;
      case "goto_statement":
        record(n);
        throw new Goto(field(n, "label").text);
      default:
        fail(n, `지원하지 않는 문장 ${n.type}`);
    }
  }

  // --- 맨 위 선언 ---
  function topLevel(top: Node) {
    switch (top.type) {
      case "comment":
        return;
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier":
        typeOf(top);
        return;
      case "type_definition": {
        const b = typeOf(field(top, "type"));
        for (const d of top.childrenForFieldName("declarator")) {
          if (!d) continue;
          const { name, type } = declare(b, d);
          typedefs.set(name, type);
        }
        return;
      }
      case "function_definition": {
        const decl = declare(
          typeOf(field(top, "type")),
          field(top, "declarator"),
        );
        if (!decl.fn || decl.type.k !== "func")
          return fail(top, "함수 정의의 선언을 읽지 못했습니다");
        const { name } = decl;
        const ret = decl.type.ret;
        const params: { name: string; type: CType }[] = [];
        let variadic = false;
        for (const p of field(decl.fn, "parameters").namedChildren) {
          if (!p || p.type !== "parameter_declaration") {
            if (p?.type === "variadic_parameter") variadic = true;
            continue;
          }
          const pt = field(p, "type");
          const pd = p.childForFieldName("declarator");
          if (!pd) {
            if (pt.text === "void") continue;
            fail(p, "매개변수 이름이 없습니다");
          }
          const pdecl = declare(typeOf(pt), pd as Node);
          // 배열·함수 매개변수는 포인터다
          params.push({
            name: pdecl.name,
            type:
              pdecl.type.k === "array"
                ? ptr(pdecl.type.of)
                : pdecl.type.k === "func"
                  ? ptr(pdecl.type)
                  : pdecl.type,
          });
        }
        const known = funcs.get(name);
        const f = {
          name,
          addr: known?.addr ?? 0x100 + funcs.size * 16,
          type: func(ret),
          ret,
          params,
          variadic,
          body: field(top, "body"),
        };
        funcs.set(name, f);
        byAddr.set(f.addr, f);
        return;
      }
      case "declaration": {
        const typeNode = field(top, "type");
        const b = typeOf(typeNode);
        for (const d of top.childrenForFieldName("declarator")) {
          if (!d) continue;
          let { name, type, fn } = declare(b, d);
          if (fn) continue; // 함수 원형
          const init =
            d.type === "init_declarator" ? d.childForFieldName("value") : null;
          if (type.k === "array" && !type.n && init)
            type = arr(
              type.of,
              init.type === "string_literal"
                ? unquote(init.text.slice(1, -1)).length + 1
                : init.namedChildren.length,
            );
          // 같은 전역을 여러 번 선언할 수 있다(extern int a; int a = 1;). 크기가 정해지는 선언에서 자리를 잡는다
          const known = globals.get(name);
          const addr =
            known && known.type.size >= type.size
              ? known.addr
              : staticAlloc(d, type);
          if (!known || known.type.size < type.size)
            globals.set(name, { addr, type });
          if (init) initialize(d, addr, type, init);
        }
        return;
      }
      case "expression_statement":
        if (top.text.trim() === ";") return;
        return fail(top, "함수 밖에 문장을 쓸 수 없습니다");
      default:
        return fail(top, `지원하지 않는 맨 위 선언 ${top.type}`);
    }
  }

  // 문자열 상수를 실행 전에 모아 앞쪽(0x1000~)에 둔다. 전역은 그 뒤 0x2000 부터
  const collectStrings = (n: Node) => {
    if (n.type === "string_literal" || n.type === "concatenated_string")
      evalExpr(n);
    else for (const c of n.namedChildren) collectStrings(c);
  };

  let error: CError | null = null;
  let exit = 0;
  try {
    collectStrings(tree.rootNode);
    globalTop = Math.max(GLOBAL_BASE, Math.ceil(strTop / 0x1000) * 0x1000);
    for (const top of tree.rootNode.namedChildren) if (top) topLevel(top);
    // 실행 중에 생기는 static 지역 변수 자리를 조금 남기고 힙을 시작한다
    heapBase = Math.max(
      HEAP_BASE,
      Math.ceil((globalTop + 0x1000) / 0x1000) * 0x1000,
    );
    heapTop = heapBase;
    started = true;
    const main = funcs.get("main") ?? fail(null, "main 함수가 없습니다");
    // int main(int argc, char **argv) 면 프로그램 이름 하나만 넘긴다
    const argv = staticAlloc(tree.rootNode, arr(ptr(T.char), 2));
    store(null, argv, ptr(T.char), strAddr("main"));
    const mainArgs: Val[] = [
      { t: T.int, v: 1 },
      { t: ptr(ptr(T.char)), v: argv },
    ];
    exit = num(
      invoke(main, mainArgs.slice(0, main.params.length), tree.rootNode).v,
    );
  } catch (e) {
    if (e instanceof Fail) error = { line: e.line, msg: e.message };
    else if (e instanceof Exit) exit = e.code;
    // 해석기를 돌리는 JS 의 스택이 C 스택(1MB)보다 먼저 찬다
    else if (e instanceof RangeError && /call stack/i.test(e.message))
      error = {
        line: here ? lineOf(here) : null,
        msg: "재귀가 너무 깊어 멈췄습니다. 이 실행기는 함수를 약 400번까지 겹쳐 부를 수 있습니다",
      };
    else
      error = {
        line: here ? lineOf(here) : null,
        msg: `실행기 오류: ${(e as Error).message}`,
      };
  }
  const leaked = heap.filter((h) => !h.freed).length;
  return { steps, out: text(out), error, exit, leaked, truncated, read };
}
