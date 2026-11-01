// C 해석기. 직접 쓴 파서(parse.ts)의 구문 트리를 따라가며 실행하고, 문장마다 호출 스택의 변수·힙·출력을 기록한다.
// 진짜 C 처럼 메모리는 바이트 배열 하나(16MB)다: 문자열 0x1000~, 전역 0x2000~, 힙 0x4000~(위로), 스택은 맨 끝에서 아래로 1MB.
// 전역이 커서 0x4000 을 넘으면 힙 시작을 그 뒤로 민다(작은 프로그램은 늘 같은 주소).
// 크기는 64비트 clang 과 같게(char 1, short 2, int 4, long 8, 포인터 8) 맞춰 실제 컴파일러와 출력을 대조할 수 있다.
// 진짜 C 라면 조용히 망가질 일(배열 밖 인덱스, NULL 따라가기, free 한 메모리 쓰기, 두 번 free)은 그 줄에서 멈추고 알린다.
import { preprocess } from "./cpp.ts";
import { needs, visible } from "./headers.ts";
import { type Node, ParseError, parse } from "./parse.ts";

const MEM_SIZE = 0x1000000;
const STR_BASE = 0x1000;
const GLOBAL_BASE = 0x2000;
const HEAP_BASE = 0x4000;
const STACK_TOP = MEM_SIZE;
const HEAP_END = STACK_TOP - 0x100000;
// 무한 반복으로 화면이 멈추지 않게 연산 수에 한도를 둔다
const OPS_LIMIT = 20_000_000;
// 빠른 실행(JS 로 옮긴 것)의 한도는 그 몇 배. 거기선 반복 한 번·호출 한 번이 연산 하나다
const FAST_OPS = 25;

// ---------- 타입 ----------
// bits: 비트 필드의 폭. 그 필드는 offset 부터 size 바이트(선언한 타입 크기)를 읽어 shift 비트 위의 bits 개를 쓴다
type IntType = {
  k: "int";
  size: number;
  align: number;
  signed: boolean;
  name: string;
  bits?: number;
  shift?: number;
  q?: number;
};
type PtrType = { k: "ptr"; to: CType; size: 8; align: 8; q?: number };
type ArrayType = {
  k: "array";
  of: CType;
  n: number;
  size: number;
  align: number;
  q?: number;
};
// skip: { } 초기화에서 차례로 채우지 않는 필드(이름 없는 비트 필드, 이름 없는 union 의 둘째 멤버부터)
type Field = { name: string; type: CType; offset: number; skip?: boolean };
type StructType = {
  k: "struct";
  name: string;
  union: boolean;
  fields: Field[] | null;
  size: number;
  align: number;
  q?: number;
};
type VoidType = { k: "void"; size: 1; align: 1; name: "void"; q?: number };
type FloatType = {
  k: "float";
  size: 4 | 8;
  align: 4 | 8;
  name: string;
  q?: number;
};
// 함수는 메모리에 없지만 포인터로 가리킬 수 있게 0x100 부터 가짜 주소를 하나씩 준다
// params: 매개변수 타입. int f() 처럼 원형이 없으면 undefined(무엇이든 넘길 수 있다)
type FuncType = {
  k: "func";
  size: 1;
  align: 1;
  name: string;
  ret: CType;
  params?: CType[];
  variadic?: boolean;
  q?: number;
};
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
  // char 와 크기·부호가 같아도 다른 타입이다(char * 와 signed char * 는 섞을 수 없다)
  schar: int("signed char", 1, true),
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
const func = (ret: CType, params?: CType[], variadic = false): FuncType => ({
  k: "func",
  size: 1,
  align: 1,
  name: `${typeName(ret)} (${
    params === undefined
      ? ""
      : params.length
        ? [...params.map(typeName), ...(variadic ? ["..."] : [])].join(", ")
        : "void"
  })`,
  ret,
  params,
  variadic,
});
const ptr = (to: CType): PtrType => ({ k: "ptr", to, size: 8, align: 8 });
// 한정자는 타입이 q 비트로 들고 다닌다. restrict 는 따지지 않는다
const CONST = 1;
const VOLATILE = 2;
// 배열에 붙은 한정자는 원소의 것이다. 한정한 struct 는 원래 struct 를 프로토타입으로 둔다:
// 앞서 선언만 한 struct 를 한정해 두어도 나중에 정의하면 그 필드가 보인다
const qualify = (t: CType, q: number): CType => {
  const all = (t.q ?? 0) | q;
  if (!q || all === t.q || t.k === "func") return t;
  if (t.k === "array") return arr(qualify(t.of, q), t.n);
  if (t.k === "struct")
    return Object.assign(Object.create(unqualified(t)), { q: all });
  return { ...t, q: all };
};
const unqualified = (t: CType): CType =>
  !t.q
    ? t
    : t.k === "struct"
      ? (Object.getPrototypeOf(t) as CType)
      : { ...t, q: undefined };
const qualNames = (q = 0) =>
  [q & CONST && "const", q & VOLATILE && "volatile"].filter(Boolean).join(" ");
const isDouble = (t: CType) => t.k === "float" && t.size === 8;
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
// fopen 으로 연 파일(FOPEN_MAX 개까지)
const FILE_BASE = 0x40;
const FILE_END = FILE_BASE + 20 * 8;

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
  const q = qualNames(t.q);
  switch (t.k) {
    case "ptr":
      return `${typeName(t.to)} *${q && ` ${q}`}`;
    case "array":
      return `${typeName(t.of)}[${t.n}]`;
    case "struct":
      return `${q && `${q} `}${t.union ? "union" : "struct"} ${t.name}`;
    default:
      return `${q && `${q} `}${t.name}`;
  }
}

// 실수를 정수 × 2^e 로 나눈다(유한한 수만)
function decompose(x: number): [bigint, number] {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  return exp === 0
    ? [sign * frac, -1074]
    : [sign * (frac | (1n << 52n)), exp - 1075];
}
// m × 2^e 를 가장 가까운 double 로(반이면 짝수 쪽)
function toDouble(m: bigint, e: number): number {
  if (m === 0n) return 0;
  const neg = m < 0n;
  let a = neg ? -m : m;
  // 53비트 정밀도, 그리고 2^-1074 보다 작은 자리는 double 에 없다
  const drop = Math.max(a.toString(2).length - 53, -1074 - e);
  if (drop > 0) {
    const D = BigInt(drop);
    const q = a >> D;
    const r = a - (q << D);
    const half = 1n << (D - 1n);
    a = r > half || (r === half && q & 1n) ? q + 1n : q;
    e += drop;
  }
  let v = Number(a);
  for (; e > 1000; e -= 1000) v *= 2 ** 1000;
  for (; e < -1000; e += 1000) v *= 2 ** -1000;
  v *= 2 ** e;
  return neg ? -v : v;
}
// x × y + z 를 한 번만 반올림한다(C 의 fma)
function fma(x: number, y: number, z: number): number {
  const p = x * y;
  if (!Number.isFinite(p) || !Number.isFinite(z) || p === 0 || z === 0)
    return p + z;
  const [mx, ex] = decompose(x);
  const [my, ey] = decompose(y);
  const [mz, ez] = decompose(z);
  const ep = ex + ey;
  const e = Math.min(ep, ez);
  const sum = ((mx * my) << BigInt(ep - e)) + (mz << BigInt(ez - e));
  return sum === 0n ? p + z : toDouble(sum, e);
}
// %a: 0x1.8p+3 처럼 16진 가수와 2진 지수. p < 0 이면 정확히 나타내는 만큼
function hexFloatText(a: number, p: number): string {
  if (a === 0) return `0x0${p > 0 ? `.${"0".repeat(p)}` : ""}p+0`;
  let [m, e] = decompose(a);
  // 맨 앞 1 뒤에 52비트가 오게 맞춘다(아주 작은 수도 1.xxx 로)
  const len = m.toString(2).length;
  m <<= BigInt(53 - len);
  e -= 53 - len;
  let frac = m & ((1n << 52n) - 1n);
  let lead = 1n;
  if (p >= 0 && p < 13) {
    const D = BigInt(52 - p * 4);
    const q = frac >> D;
    const r = frac - (q << D);
    const half = D ? 1n << (D - 1n) : 0n;
    frac = D && (r > half || (r === half && q & 1n)) ? q + 1n : q;
    if (frac >> BigInt(p * 4)) {
      lead += 1n;
      frac = 0n;
    }
  }
  let digits =
    p === 0 ? "" : frac.toString(16).padStart(p > 0 && p < 13 ? p : 13, "0");
  if (p < 0) digits = digits.replace(/0+$/, "");
  else if (p > 13) digits = digits.padEnd(p, "0");
  const exp = e + 52;
  return `0x${lead}${digits ? `.${digits}` : ""}p${exp < 0 ? "-" : "+"}${Math.abs(exp)}`;
}

// printf 의 %f·%e·%g·%a
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
  const upper = c === "F" || c === "E" || c === "G" || c === "A";
  let s: string;
  if (!Number.isFinite(a)) s = Number.isNaN(a) ? "nan" : "inf";
  else {
    const exp = (x: number, q: number) => {
      const [m, e] = x.toExponential(q).split("e");
      const n = Number(e);
      return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
    };
    const lc = c.toLowerCase();
    // toFixed 는 10^21 부터 지수로 쓴다. 그만큼 큰 double 은 정수라 BigInt 로 그대로 쓴다
    if (lc === "f")
      s =
        a < 1e21 ? a.toFixed(p) : `${BigInt(a)}${p ? `.${"0".repeat(p)}` : ""}`;
    else if (lc === "a") s = hexFloatText(a, p);
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
// 표준 함수도 함수 포인터로 넘길 수 있게(qsort 에 strcmp 를) 0xc00 부터 가짜 주소를 하나씩 준다
const LIBRARY = Object.fromEntries(
  (
    "abort abs aligned_alloc atof atoi atol atoll bsearch calloc clock exit fflush fma fprintf fputc fputs free " +
    "getchar isalnum isalpha iscntrl isdigit isfinite isgraph isinf islower isnan isprint ispunct isspace isupper " +
    "isxdigit labs llabs malloc memcmp memcpy memmove memset printf putc putchar puts qsort rand realloc signbit " +
    "snprintf sprintf srand strcat strchr strcmp strcpy strlen strncat strncmp strncpy strrchr strstr strtod strtol " +
    "strtoll strtoul strtoull time tolower toupper sqrt fabs floor ceil round trunc sin cos tan asin acos atan sinh " +
    "cosh tanh exp exp2 log log10 log2 cbrt pow fmod atan2 hypot fmin fmax fdim ldexp copysign " +
    "fopen fclose fread fwrite fgetc getc fgets feof ferror rewind fseek ftell remove ungetc"
  )
    .split(" ")
    .map((name, i) => [0xc00 + i * 4, name]),
) as Record<number, string>;
const LIBRARY_ADDR = new Map(
  Object.entries(LIBRARY).map(([a, name]) => [name, Number(a)]),
);

const BUILTIN_RET: Record<string, CType> = {
  __va_start: ptr(T.char),
  __va_next: ptr(T.void),
  assert: T.void,
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
    `sqrt fabs floor ceil round trunc sin cos tan asin acos atan sinh cosh tanh exp exp2 log log10 log2 cbrt pow fmod atan2 hypot fmin fmax fdim copysign fma ldexp`
      .split(" ")
      .map((f) => [f, T.double]),
  ),
  fopen: ptr(FILE),
  fgets: ptr(T.char),
  fread: T.ulong,
  fwrite: T.ulong,
  ftell: T.long,
  rewind: T.void,
  srand: T.void,
  exit: T.void,
  abort: T.void,
};
const libType = (name: string) => func(BUILTIN_RET[name] ?? T.int);

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
/** 한 단계의 모습. replay(steps).at(i) 로 얻는다 */
export type CStep = {
  /** 이제 실행할 줄(0부터) */
  line: number;
  /** 바깥(main)부터 지금 함수까지의 호출 스택 */
  frames: CFrame[];
  globals: CVar[];
  heap: CBlock[];
  /** 그때까지의 출력 */
  out: string;
};
/** 한 단계에서 바뀐 것만. 첫 단계는 처음 모습 전체다 */
export type CChange = {
  line: number;
  /** 함수 칸 수가 바뀌었으면 새 수 */
  depth?: number;
  /** 내용이 바뀌거나 새로 생긴 함수 칸: [몇 번째, 그 칸] */
  frames?: [number, CFrame][];
  /** 새로 생기거나 값이 바뀐 전역 변수(이름과 주소로 가린다) */
  globals?: CVar[];
  /** 새로 생기거나 바뀐 힙 블록(주소로 가린다. 블록은 사라지지 않고 freed 만 바뀐다) */
  heap?: CBlock[];
  /** 이 단계에 새로 나온 출력 */
  out?: string;
};
export type CError = { line: number | null; msg: string };
export type CResult = {
  /** 단계마다 바뀐 것. 그 단계의 모습은 replay(steps).at(i) */
  steps: CChange[];
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
// temp: f().x 처럼 자리는 있지만 대입할 수 없는 값(함수가 돌려준 struct 의 멤버)
type Place = { t: CType; addr: number; lv: true; temp?: boolean };
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
// decl: 이 이름을 만든 선언문. goto 로 그 앞으로 돌아가면 이름을 지운다
// missing: extern 으로 선언만 하고 정의는 없는 전역. sizeof 는 되고 값을 쓰면 오류(진짜 C 의 링크 오류)
// kind: 블록 안에서 만든 typedef·struct 태그("struct s" 처럼 공백 든 이름이라 변수와 안 겹친다)·enum 상수.
// 변수와 같은 이름 범위에 두어 블록을 나가면 사라지고 안쪽 것이 바깥 것을 가린다
// linked: 블록 안의 extern·함수 선언(바깥의 같은 이름을 가리킨다). static: static 지역 변수
type Binding = {
  addr: number;
  type: CType;
  decl?: Node;
  missing?: true;
  kind?: "typedef" | "tag" | "enum";
  value?: number;
  linked?: true;
  static?: true;
};

const hex = (v: number) => `0x${v.toString(16)}`;

// 정수 값. 64비트 정수가 2^53 을 넘으면 JS 수로는 끝자리가 틀려 bigint 로 둔다. 그 안쪽이면 늘 number 라
// (norm) 두 값의 표현이 다르면 값도 다르고, === 비교가 그대로 맞는다
type Num = number | bigint;
// 초기화 한 가지(JS 로 옮길 때 모은다). off 는 객체 처음부터의 바이트
type PlanItem =
  | { k: "zero"; off: number; size: number }
  | { k: "val"; off: number; t: CType; v: Node }
  | { k: "str"; off: number; t: CType; units: number[]; len: number };
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
// C 의 참: 0 이 아니면 참(NaN 도 참이다. JS 에선 NaN 이 거짓이라 따로 본다)
const truth = (v: Num) => v !== 0 && v !== 0n;
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
const UCN = /^[uU]/;
const unquote = (s: string) =>
  s.replace(
    /\\(x[0-9a-fA-F]+|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)|[\u0080-￿]+/g,
    (m, c?: string) =>
      c === undefined
        ? bytesOf(m)
        : UCN.test(c)
          ? bytesOf(String.fromCodePoint(Number.parseInt(c.slice(1), 16)))
          : c[0] === "x"
            ? String.fromCharCode(Number.parseInt(c.slice(1), 16) & 0xff)
            : /^[0-7]/.test(c)
              ? String.fromCharCode(Number.parseInt(c, 8) & 0xff)
              : (ESC[c] ?? c),
  );
// 넓은 문자(L·u·U 접두사)의 글자 값들. \x 를 1바이트로 자르지 않고, u 는 UTF-16 으로 쪼갠다
const wideUnits = (s: string, utf16: boolean) => {
  const out: number[] = [];
  for (const m of s.matchAll(
    /\\(x[0-9a-fA-F]+|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)|[^\\]/gsu,
  )) {
    const c = m[1];
    const v =
      c === undefined
        ? (m[0].codePointAt(0) ?? 0)
        : c[0] === "x" || UCN.test(c)
          ? Number.parseInt(c.slice(1), 16)
          : /^[0-7]/.test(c)
            ? Number.parseInt(c, 8)
            : (ESC[c] ?? c).charCodeAt(0);
    if (utf16 && v > 0xffff)
      out.push(
        0xd800 + ((v - 0x10000) >> 10),
        0xdc00 + ((v - 0x10000) & 0x3ff),
      );
    else out.push(v);
  }
  return out;
};
// 문자열·문자 상수의 접두사(L"…", u'…')에 따른 글자 하나의 타입
const PREFIX_TYPE: Record<string, CType> = { L: T.int, u: T.ushort, U: T.uint };

// 실행은 두 번까지 한다. 먼저 줄마다 기록하며 limit 단계까지 돌고, 그 안에 끝나면 그 결과가 전부다.
// 기록이 한도에 닿으면 기록 없이 처음부터 빠르게(JS 로 옮겨) 다시 돌려 출력·종료 코드·오류를 얻는다.
// 같은 프로그램은 같게 돌아(입력이 없고 rand 도 씨앗이 같다) 기록은 빠른 실행의 앞부분과 같다
export function run(
  src: string,
  { limit = 3000, ops }: { limit?: number; ops?: number } = {},
): CResult {
  if (limit > 0) {
    const r = execute(src, { limit, ops, fast: false });
    // 한도 안에서 끝났으면 그대로. 시간·재귀 한도는 빠른 실행이 더 넉넉하다
    if (
      !r.truncated &&
      !/^(너무 오래|재귀가 너무 깊어)/.test(r.error?.msg ?? "")
    )
      return r;
    const f = execute(src, { limit: 0, ops, fast: true });
    return { ...f, steps: r.steps, truncated: true };
  }
  return execute(src, { limit: 0, ops, fast: true });
}

// 기록이 한도에 닿아 멈춘다
class Stop {}

function execute(
  src: string,
  {
    limit,
    ops: opsBase = OPS_LIMIT,
    fast,
  }: { limit: number; ops?: number; fast: boolean },
): CResult {
  // 빠른 실행은 기록하지 않고 끝까지 가야 해서 한도가 넉넉하다
  const opsLimit = fast ? opsBase * FAST_OPS : opsBase;
  const pre = preprocess(src);
  let root: Node | null = null;
  let syntaxErr: CError | null = null;
  if (!pre.error)
    try {
      root = parse(pre.code, pre.headers);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      syntaxErr = { line: e.line, msg: e.message };
    }
  // 표준 이름은 그 헤더를 include 했거나 직접 선언했을 때만 보인다
  const known = (name: string) =>
    visible(name, pre.headers) || protos.has(name);
  const mem = new DataView(new ArrayBuffer(MEM_SIZE));
  const structs = new Map<string, StructType>();
  const typedefs = new Map<string, CType>();
  const enums = new Map<string, number>();
  const enumTags = new Map<string, CType>();
  const funcs = new Map<string, Func>();
  const byAddr = new Map<number, Func>();
  const globals = new Map<string, Binding>();
  const heap: Block[] = [];
  // 힙은 전역을 다 잡은 뒤 그 위에서 시작한다. 그 전엔 힙이 없다
  let heapBase = HEAP_END;
  let heapTop = HEAP_BASE;
  let strTop = STR_BASE;
  // 맨 위 선언을 다 읽고 main 을 부르기 시작했는지
  let started = false;
  let globalTop = GLOBAL_BASE;
  let sp = STACK_TOP;
  // 남은 연산 수. 옮긴 JS 코드와 해석기가 같이 깎는다
  const budget = { n: opsLimit };
  // va: 가변 인자 함수면 넘겨받은 가변 인자의 첫 칸 주소
  // slots: 이 호출에서 선언마다 잡은 자리. goto 로 같은 선언을 다시 지나면 그 자리를 다시 쓴다
  const frames: {
    name: string;
    scopes: Map<string, Binding>[];
    va?: number;
    slots: Map<Node, number>;
  }[] = [];
  const steps: CChange[] = [];
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
  if (!root)
    return {
      ...base,
      out,
      error: pre.error ?? syntaxErr,
      exit: 1,
      leaked: 0,
    };

  // --- 메모리 읽기·쓰기 ---
  // 힙은 앞으로만 쌓으니(주소를 다시 쓰지 않는다) 그 주소 앞에서 시작한 마지막 블록이 그 주소의 주인이다
  const blockAt = (addr: number) => {
    let lo = 0;
    let hi = heap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (heap[mid].addr <= addr) lo = mid;
      else hi = mid - 1;
    }
    const b = heap[lo];
    return b && b.addr <= addr ? b : undefined;
  };
  // 그 주소에서 시작하는 블록(malloc 이 돌려준 주소인가)
  const blockStart = (addr: number) => {
    const b = blockAt(addr);
    return b?.addr === addr ? b : undefined;
  };
  // sizeof 처럼 타입만 알면 되는 식은 계산하지 않는다(dry). 메모리를 읽고 쓰지 않고, 함수를 부르지 않고, 오류도 내지 않는다
  let dry = 0;
  // 실행 전 검사 중(맨 위 선언을 읽고 함수 몸통을 훑는 동안). 컴파일 오류는 이때나 dry 일 때만 따진다
  let checking = false;
  const strict = () => checking || dry > 0;
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
  const unitOf = (addr: number, size: number) =>
    size === 8
      ? mem.getBigUint64(addr, true)
      : BigInt(
          size === 1
            ? mem.getUint8(addr)
            : size === 2
              ? mem.getUint16(addr, true)
              : mem.getUint32(addr, true),
        );
  const load = (n: Node | null, addr: number, t: CType): Num => {
    if (dry) return 0;
    check(n, addr, t.size);
    if (t.k === "int" && t.bits !== undefined) {
      const v = BigInt.asUintN(
        t.bits,
        unitOf(addr, t.size) >> BigInt(t.shift ?? 0),
      );
      return norm(t.signed ? BigInt.asIntN(t.bits, v) : v);
    }
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
    if (t.bits !== undefined) {
      const shift = BigInt(t.shift ?? 0);
      const mask = ((1n << BigInt(t.bits)) - 1n) << shift;
      const unit = (unitOf(addr, t.size) & ~mask) | ((big(v) << shift) & mask);
      return store(n, addr, { ...t, bits: undefined }, norm(unit));
    }
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
    // 흔한 경우를 먼저: 비트 필드가 아닌 4바이트 이하 정수에 number. | 0 등은 C 처럼 2^n 으로 나눈 나머지다
    if (t.k === "int" && t.bits === undefined && typeof v === "number")
      switch (t.size) {
        case 4:
          return t.signed ? v | 0 : v >>> 0;
        case 2:
          return t.signed ? (v << 16) >> 16 : v & 0xffff;
        case 1:
          if (t.name === T.bool.name) return truth(v) ? 1 : 0;
          return t.signed ? (v << 24) >> 24 : v & 0xff;
      }
    if (t.k === "float") return t.size === 4 ? Math.fround(num(v)) : num(v);
    if (t.k !== "int") return num(v);
    if (t.name === T.bool.name) return truth(v) ? 1 : 0;
    if (t.bits !== undefined)
      return norm(
        t.signed
          ? BigInt.asIntN(t.bits, big(v))
          : BigInt.asUintN(t.bits, big(v)),
      );
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
  const PRIMITIVES = new Map<string, CType>();
  const typeOf = (node: Node): CType => {
    switch (node.type) {
      case "primitive_type":
      case "sized_type_specifier": {
        const known = PRIMITIVES.get(node.text);
        if (known) return known;
        if (node.text === "signed char") return T.schar;
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
        const t =
          map[s] ??
          STD_TYPES[s] ??
          fail(node, `지원하지 않는 타입 ${node.text}`);
        PRIMITIVES.set(node.text, t);
        return t;
      }
      case "type_identifier": {
        const local = findScoped(node.text);
        if (local?.kind === "typedef") return local.type;
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
        const kind = union ? "union" : "struct";
        const key = `${kind} ${name}`;
        const scope = frame()?.scopes.at(-1);
        const here = (k: string) => (scope ? scope.has(k) : structs.has(k));
        // struct 와 union 태그는 이름 범위가 하나다: 같은 이름을 다른 쪽으로 쓰면 오류
        if (strict()) {
          const otherKey = `${union ? "struct" : "union"} ${name}`;
          const found = findTag(name);
          const clash = body ? here(otherKey) : found && found !== key;
          if (clash)
            fail(
              node,
              `${name} 은 ${union ? "struct" : "union"} 로 선언한 태그라 ${kind} 로 쓸 수 없습니다`,
            );
        }
        let st =
          (findScoped(key)?.type as StructType | undefined) ?? structs.get(key);
        // 처음 보는 태그거나, 바깥에 있는 태그를 이 블록에서 다시 정의하면 새 타입
        if (!st || (body && !here(key))) st = newTag(key, name, union);
        if (body) {
          if (strict() && st.fields) fail(node, `${key} 를 이미 정의했습니다`);
          defineStruct(st, body);
        }
        return st;
      }
      case "enum_specifier": {
        // 값이 모두 0 이상인 enum 은 unsigned int, 음수가 있으면 int(gcc·clang 과 같게). 상수 자체는 int
        const name = node.childForFieldName("name")?.text;
        const key = `enum ${name}`;
        const body = node.childForFieldName("body");
        if (!body)
          return (
            (name && (findScoped(key)?.type ?? enumTags.get(key))) || T.uint
          );
        const scope = frame()?.scopes.at(-1);
        let next = 0;
        let negative = false;
        for (const e of body.namedChildren) {
          if (!e || e.type !== "enumerator") continue;
          const v = e.childForFieldName("value");
          if (v) next = constEval(v);
          if (next < 0) negative = true;
          const c = field(e, "name").text;
          if (scope)
            scope.set(c, { addr: 0, type: T.int, kind: "enum", value: next });
          else enums.set(c, next);
          next++;
        }
        const t = negative ? T.int : T.uint;
        if (name) {
          if (scope) scope.set(key, { addr: 0, type: t, kind: "tag" });
          else enumTags.set(key, t);
        }
        return t;
      }
      default:
        return fail(node, `지원하지 않는 타입 ${node.type}`);
    }
  };
  const findScoped = (name: string): Binding | undefined => {
    const f = frame();
    if (f)
      for (let i = f.scopes.length - 1; i >= 0; i--) {
        const v = f.scopes[i].get(name);
        if (v) return v;
      }
  };
  // 이름이 name 인 가장 안쪽 태그의 키("struct s" 나 "union s")
  const findTag = (name: string): string | undefined => {
    const keys = [`struct ${name}`, `union ${name}`];
    const f = frame();
    if (f)
      for (let i = f.scopes.length - 1; i >= 0; i--) {
        const k = keys.find((x) => f.scopes[i].has(x));
        if (k) return k;
      }
    return keys.find((x) => structs.has(x));
  };
  // 태그를 지금 블록(함수 밖이면 전역)에 새로 만든다
  const newTag = (key: string, name: string, union: boolean) => {
    const st: StructType = {
      k: "struct",
      name,
      union,
      fields: null,
      size: 0,
      align: 1,
    };
    const scope = frame()?.scopes.at(-1);
    if (scope) scope.set(key, { addr: 0, type: st, kind: "tag" });
    else structs.set(key, st);
    return st;
  };
  // 64비트 리눅스(System V)의 배치: 비트 필드는 선언한 타입 크기의 칸 안에 들어가면 이어 붙이고,
  // 칸 경계를 넘으면 다음 칸에서 시작한다. 폭 0 은 다음 칸으로 넘기고, 이름 없는 비트 필드는 정렬에 셈하지 않는다
  const defineStruct = (st: StructType, body: Node) => {
    const fields: Field[] = [];
    let bit = 0;
    let align = 1;
    let size = 0;
    const lastField = body.namedChildren.findLast(
      (c) => c.type === "field_declaration",
    );
    for (const fd of body.namedChildren) {
      if (!fd || fd.type !== "field_declaration") continue;
      const b = specType(fd);
      const decls = [...fd.childrenForFieldName("declarator")];
      // 이름 없는 struct·union 멤버: 그 필드들이 바깥 struct 의 필드가 된다
      if (!decls.length && b.k === "struct") {
        const off = st.union ? 0 : Math.ceil(bit / 8 / b.align) * b.align;
        // { } 초기화에선 이름 없는 멤버 전체가 한 자리다. 이름 "" 로 두고 그 안의 필드는 이름으로만 찾는다
        fields.push({ name: "", type: b, offset: off });
        for (const f of b.fields ?? [])
          if (f.name) fields.push({ ...f, offset: off + f.offset, skip: true });
        if (st.union) size = Math.max(size, b.size);
        else bit = (off + b.size) * 8;
        align = Math.max(align, b.align);
        continue;
      }
      // 선언자마다 바로 뒤에 오는 : 폭. unsigned : 3 처럼 선언자가 없으면 이름 없는 필드 하나
      if (!decls.length) {
        const clause = fd.namedChildren.find(
          (c) => c.type === "bitfield_clause",
        );
        if (clause) decls.push(clause);
      }
      const widths = new Map<Node, number>();
      let last: Node | null = null;
      for (const c of fd.children) {
        if (decls.includes(c)) last = c;
        if (c.type === "bitfield_clause" && last)
          widths.set(
            last,
            constEval(c.namedChildren[0] ?? fail(c, "폭이 없습니다")),
          );
      }
      for (const d of decls) {
        if (!d) continue;
        const width = widths.get(d);
        if (width === undefined) {
          const { name, type } = declare(b, d);
          // 크기 없는 배열은 마지막 멤버로만(flexible array member)
          const flexible =
            type.k === "array" &&
            !type.n &&
            fd === lastField &&
            d === decls.at(-1) &&
            complete(type.of);
          if (strict() && !complete(type) && !flexible)
            fail(
              d,
              `멤버 ${name} 의 타입 ${typeName(type)} 은 크기를 모릅니다`,
            );
          const off = st.union
            ? 0
            : Math.ceil(bit / 8 / type.align) * type.align;
          fields.push({ name, type, offset: off });
          if (st.union) size = Math.max(size, type.size);
          else bit = (off + type.size) * 8;
          align = Math.max(align, type.align);
          continue;
        }
        if (b.k !== "int") return fail(d, "비트 필드는 정수 타입이어야 합니다");
        if (width > b.size * 8) fail(d, "비트 필드가 타입보다 넓습니다");
        const name = d.type === "bitfield_clause" ? "" : d.text;
        const unit = b.size * 8;
        if (
          width === 0 ||
          (!st.union &&
            Math.floor(bit / unit) !== Math.floor((bit + width - 1) / unit))
        )
          bit = Math.ceil(bit / unit) * unit;
        if (width === 0) continue;
        const offset = st.union ? 0 : Math.floor(bit / unit) * b.size;
        const shift = st.union ? 0 : bit - offset * 8;
        fields.push({
          name,
          type: { ...b, bits: width, shift },
          offset,
          skip: !name,
        });
        if (st.union) size = Math.max(size, Math.ceil(width / 8));
        else bit += width;
        if (name) align = Math.max(align, b.align);
      }
    }
    if (strict()) {
      const seen = new Set<string>();
      for (const f of fields)
        if (f.name) {
          if (seen.has(f.name)) fail(body, `멤버 이름 ${f.name} 이 겹칩니다`);
          seen.add(f.name);
        }
    }
    st.fields = fields;
    st.align = align;
    st.size = Math.ceil((st.union ? size : Math.ceil(bit / 8)) / align) * align;
  };
  // 선언자를 풀어 이름과 타입을 얻는다. 바깥 선언자부터 타입을 감싸며 안으로 들어간다:
  // int *a[3] 은 [3] 이 바깥이라 (int * 의 배열 3), int (*a)[3] 은 * 가 바깥이라 (int[3] 을 가리키는 포인터).
  // 이름이 함수면 fn 에 그 함수 선언자(매개변수 목록이 있는 곳)를 준다
  const quals = (n: Node) => {
    let q = 0;
    for (const c of n.namedChildren)
      if (c.type === "type_qualifier")
        q |= c.text === "const" ? CONST : c.text === "volatile" ? VOLATILE : 0;
    return q;
  };
  // 선언의 기본 타입: 타입 지정자에 한정자(const int 의 const)를 붙인 것
  const specType = (n: Node) => qualify(typeOf(field(n, "type")), quals(n));
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
        return declare(qualify(ptr(b), quals(d)), field(d, "declarator"));
      case "array_declarator": {
        const sizeNode = d.childForFieldName("size");
        return declare(
          arr(element(d, b), sizeNode ? arraySize(sizeNode) : 0),
          field(d, "declarator"),
        );
      }
      case "init_declarator":
        return declare(b, field(d, "declarator"));
      case "function_declarator": {
        // int f(int) 는 함수 원형, int (*f)(int) 는 함수를 가리키는 포인터
        const ft = prototype(d, b);
        let inner = field(d, "declarator");
        // int (f)(void) 처럼 이름에 괄호를 쳐도 함수 이름이다
        while (
          inner.type === "parenthesized_declarator" &&
          inner.namedChildren[0]?.type === "parenthesized_declarator"
        )
          inner = inner.namedChildren[0];
        const bare =
          inner.type === "parenthesized_declarator" &&
          inner.namedChildren[0]?.type === "identifier"
            ? inner.namedChildren[0]
            : inner;
        if (bare.type === "identifier")
          return { name: bare.text, type: ft, fn: d };
        return declare(ft, inner);
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
        return abstract(
          qualify(ptr(b), quals(d)),
          d.childForFieldName("declarator"),
        );
      case "abstract_array_declarator": {
        const s = d.childForFieldName("size");
        return abstract(
          arr(element(d, b), s ? arraySize(s) : 0),
          d.childForFieldName("declarator"),
        );
      }
      case "abstract_function_declarator":
        return abstract(prototype(d, b), d.childForFieldName("declarator"));
      case "abstract_parenthesized_declarator":
        return abstract(
          b,
          d.namedChildren.find((c) => c.type.startsWith("abstract_")) ?? null,
        );
      default:
        return b;
    }
  };

  // 함수 선언자의 타입. (void) 는 매개변수 없음, () 는 원형 없음
  const prototype = (d: Node, ret: CType): FuncType => {
    if (strict() && (ret.k === "func" || ret.k === "array"))
      fail(
        d,
        `함수는 ${ret.k === "func" ? "함수" : "배열"}를 돌려줄 수 없습니다`,
      );
    // 함수 타입에서 돌려주는 타입과 매개변수의 맨 바깥 한정자는 빠진다
    const r = unqualified(ret);
    const list = field(d, "parameters").namedChildren;
    if (!list.length) return func(r);
    const params: CType[] = [];
    const names = new Set<string>();
    let variadic = false;
    for (const p of list) {
      if (p.type === "variadic_parameter") {
        variadic = true;
        continue;
      }
      const base = specType(p);
      const pd = p.childForFieldName("declarator");
      let t = base;
      if (pd?.type.startsWith("abstract")) t = abstract(base, pd);
      else if (pd) {
        const x = declare(base, pd);
        t = x.type;
        if (strict() && names.has(x.name))
          fail(p, `매개변수 이름 ${x.name} 이 겹칩니다`);
        names.add(x.name);
      }
      if (t.k === "void") {
        if (list.length === 1 && !pd) return func(r, []);
        fail(p, "매개변수의 타입이 void 일 수 없습니다");
      }
      params.push(unqualified(paramType(t)));
    }
    return func(r, params, variadic);
  };
  // 배열 원소는 크기를 아는 타입이어야 한다
  const element = (d: Node, t: CType) => {
    if (strict() && !complete(t))
      fail(d, `${typeName(t)} 의 배열은 만들 수 없습니다(크기를 모르는 타입)`);
    return t;
  };

  const constEval = (n: Node): number => num(rvalue(n, evalExpr(n)).v);
  // 정수 상수식(C17 6.6): 수·문자·enum 상수·sizeof 와 그것들의 연산. 변수는 값이 있어도 아니다
  const isConst = (n: Node): boolean => {
    switch (n.type) {
      case "number_literal":
      case "char_literal":
      case "sizeof_expression":
      case "alignof_expression":
      case "offsetof_expression":
        return true;
      case "identifier": {
        const local = findScoped(n.text);
        return local ? local.kind === "enum" : enums.has(n.text);
      }
      case "parenthesized_expression":
      case "unary_expression":
      case "binary_expression":
      case "conditional_expression":
        return n.namedChildren.every(isConst);
      case "cast_expression":
        return isConst(field(n, "value"));
      default:
        return false;
    }
  };
  // 배열 크기는 상수여야 한다. 실행 중에 크기가 정해지는 가변 길이 배열(int a[n])은 없다(__STDC_NO_VLA__)
  const arraySize = (n: Node): number => {
    if (n.type === "*" || !isConst(n))
      fail(
        n,
        "배열 크기는 상수여야 합니다. 가변 길이 배열(int a[n])은 지원하지 않으니 malloc 을 씁시다",
      );
    if (strict() && typeOnly(n).k !== "int")
      fail(n, "배열 크기는 정수여야 합니다");
    const size = constEval(n);
    if (size < 0) fail(n, "배열 크기가 음수입니다");
    return size;
  };

  // --- 변수 ---
  const frame = () => frames[frames.length - 1];
  const missingCheck = (n: Node, name: string, b: Binding) =>
    b.missing && !dry ? fail(n, `extern ${name} 의 정의가 없습니다`) : b;
  const lookup = (n: Node, name: string): Binding => {
    const f = frame();
    if (f)
      for (let i = f.scopes.length - 1; i >= 0; i--) {
        const v = f.scopes[i].get(name);
        if (v) return missingCheck(n, name, v);
      }
    return missingCheck(
      n,
      name,
      globals.get(name) ?? fail(n, `선언하지 않은 이름 ${name}${needs(name)}`),
    );
  };
  // 16바이트 이상인 배열은 16바이트 경계에 둔다(64비트 ABI 와 같게)
  const alignOf = (t: CType) =>
    t.k === "array" && t.size >= 16 ? Math.max(t.align, 16) : t.align;
  const alloca = (n: Node, type: CType) => {
    sp -= type.size;
    sp -= sp % Math.max(alignOf(type), 1);
    if (sp < HEAP_END) fail(n, "스택이 넘쳤습니다(재귀가 너무 깊습니다)");
    return sp;
  };

  // --- 값 ---
  // 자리에서 읽은 값의 타입. 비트 필드는 int 로 읽는다(폭이 int 보다 넓으면 선언한 타입)
  const valueType = (t: CType): CType => {
    if (t.k !== "int" || t.bits === undefined) return t;
    const { bits, signed, size } = t;
    if (bits < 32 || (bits === 32 && signed)) return T.int;
    if (bits === 32) return T.uint;
    return size === 8 ? (signed ? T.long : T.ulong) : T.int;
  };
  const rvalue = (n: Node, x: X): Val => {
    if (!x.lv) return x;
    if (x.t.k === "array") return { t: ptr(x.t.of), v: x.addr };
    if (x.t.k === "struct")
      return { t: unqualified(x.t), v: x.addr, agg: true };
    if (x.t.k === "func") return { t: x.t, v: x.addr };
    return { t: unqualified(valueType(x.t)), v: load(n, x.addr, x.t) };
  };

  // 문자열 상수의 글자 값들(끝의 0 은 빼고). 이어 붙인 것 중 하나라도 넓은 문자열이면 모두 그 타입
  const literal = (n: Node): { t: CType; units: number[] } => {
    const parts =
      n.type === "string_literal"
        ? [n]
        : n.namedChildren.filter((c) => c.type === "string_literal");
    const prefix =
      parts
        .map((p) => p.text.slice(0, p.text.indexOf('"')))
        .find((x) => x in PREFIX_TYPE) ?? "";
    const body = (p: Node) => p.text.slice(p.text.indexOf('"') + 1, -1);
    return prefix
      ? {
          t: PREFIX_TYPE[prefix],
          units: parts.flatMap((p) => wideUnits(body(p), prefix === "u")),
        }
      : {
          t: T.char,
          units: Array.from(parts.map((p) => unquote(body(p))).join(""), (c) =>
            c.charCodeAt(0),
          ),
        };
  };
  const evalString = (str: string): Place => ({
    t: arr(T.char, str.length + 1),
    addr: strAddr(str),
    lv: true,
  });
  const evalLiteral = (n: Node): Place => {
    const { t, units } = literal(n);
    if (t === T.char) return evalString(String.fromCharCode(...units));
    const key = `${typeName(t)}:${units.join(",")}`;
    let addr = strings.get(key);
    if (addr === undefined) {
      const at = arr(t, units.length + 1);
      if (started) addr = staticAlloc(null, at);
      else {
        strTop = Math.ceil(strTop / t.size) * t.size;
        addr = strTop;
        strTop += at.size;
      }
      for (let i = 0; i <= units.length; i++)
        store(null, addr + i * t.size, t, units[i] ?? 0);
      strings.set(key, addr);
    }
    return { t: arr(t, units.length + 1), addr, lv: true };
  };
  const strings = new Map<string, number>();
  const strAddr = (s: string) => {
    const known = strings.get(s);
    if (known !== undefined) return known;
    if (dry) return 0;
    // 문자열은 실행 전에 다 모아 둔다(collectStrings). 그 뒤에 처음 보는 것(__func__ 등)은 전역 자리에
    const a = started ? staticAlloc(null, arr(T.char, s.length + 1)) : strTop;
    for (let i = 0; i < s.length; i++) mem.setUint8(a + i, s.charCodeAt(i));
    mem.setUint8(a + s.length, 0);
    if (!started) strTop += s.length + 1;
    strings.set(s, a);
    return a;
  };
  // max: 그만큼만 읽는다(printf 의 %.3s 는 끝에 0 이 없는 배열도 받는다)
  const readStr = (n: Node, a: number, max = 100000) => {
    let s = "";
    for (let i = 0; i < max; i++) {
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

  const arith = (
    n: Node,
    op: string,
    a: Val,
    b: Val,
    an?: Node | null,
    bn?: Node | null,
  ): Val => {
    if (strict()) operands(n, op, a.t, b.t, an, bn);
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
    const t = isDouble(a.t) || isDouble(b.t) ? T.double : T.float;
    // 두 값을 먼저 t 로 바꾼다(16777217L 과 float 를 견주면 정수도 float 로 반올림된다)
    const x = num(wrap(t, a.v));
    const y = num(wrap(t, b.v));
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
  // const 인 자리와 const 멤버가 든 struct 는 대입·++·-- 로 바꿀 수 없다(초기화는 된다)
  const hasConst = (t: CType): boolean =>
    !!((t.q ?? 0) & CONST) ||
    (t.k === "struct" && !!t.fields?.some((f) => hasConst(f.type))) ||
    (t.k === "array" && hasConst(t.of));
  const modifiable = (n: Node, target: Node, t: CType) => {
    if ((t.q ?? 0) & CONST)
      fail(n, `${target.text} 는 const 라 바꿀 수 없습니다`);
    if (t.k === "struct" && hasConst(t))
      fail(n, `${target.text} 에는 const 멤버가 있어 통째로 바꿀 수 없습니다`);
  };
  const assign = (
    n: Node,
    place: X,
    val: Val,
    src?: Node | null,
    what = "대입",
  ) => {
    if (!place.lv || place.temp) return fail(n, "대입할 수 없는 자리입니다");
    if (place.t.k === "func") return fail(n, "함수에는 대입할 수 없습니다");
    if (place.t.k !== "array") convert(n, place.t, val, src, what);
    // malloc 이 준 블록은 타입이 없다. 처음 담긴 포인터의 타입으로 블록을 읽어 보인다
    if (
      place.t.k === "ptr" &&
      place.t.to.k !== "void" &&
      num(val.v) >= heapBase
    ) {
      const b = blockStart(num(val.v));
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

  // int a[] = … 의 크기: 문자열이면 글자 수 + 1, { } 면 채운 원소 수(중괄호를 생략한 값, [5] = 1 처럼 정한 자리까지 셈한다)
  const initCount = (init: Node, of: CType) => {
    if (init.type === "string_literal" || init.type === "concatenated_string")
      return literal(init).units.length + 1;
    dry++;
    try {
      return fillList(init, 0, arr(of, 0), stmts(init), { i: 0 }, true);
    } finally {
      dry--;
    }
  };

  const isString = (v: Node) =>
    v.type === "string_literal" || v.type === "concatenated_string";
  // struct 에서 { } 의 값을 차례로 받는 필드. union 은 첫 필드만
  const inOrder = (t: StructType) => {
    const fs = (t.fields ?? []).filter((f) => !f.skip);
    return t.union ? fs.slice(0, 1) : fs;
  };
  // .a.b 나 [1].x 처럼 이어진 지정자를 따라 들어간 자리
  const designate = (ds: Node[], addr: number, t: CType) => {
    for (const d of ds) {
      if (d.type === "subscript_designator" && t.k === "array") {
        addr +=
          constEval(d.namedChildren[0] ?? fail(d, "자리가 없습니다")) *
          t.of.size;
        t = t.of;
      } else if (d.type === "field_designator" && t.k === "struct") {
        const name = d.text.replace(/^\./, "");
        const f =
          t.fields?.find((x) => x.name === name) ??
          fail(d, `${name} 필드가 없습니다`);
        addr += f.offset;
        t = f.type;
      } else fail(d, "초기화 자리를 읽지 못했습니다");
    }
    return { addr, t };
  };

  // 초기화: 배열·struct 는 { … } 로, 나머지는 식으로
  // JS 로 옮길 때 초기화를 실행하지 않고 할 일(0 채우기·값 넣기·문자열 넣기)만 모은다
  let planning: { base: number; items: PlanItem[] } | null = null;
  const initialize = (n: Node, addr: number, type: CType, v: Node) => {
    if (type.k === "array" && isString(v)) {
      const { t, units } = literal(v);
      if (strict() && (type.of.k !== "int" || type.of.size !== t.size))
        fail(n, `문자열로는 ${typeName(type)} 를 초기화할 수 없습니다`);
      if (units.length > type.n) fail(n, "문자열이 배열보다 깁니다");
      if (planning) {
        planning.items.push({
          k: "str",
          off: addr - planning.base,
          t: type.of,
          units,
          len: type.n,
        });
        return;
      }
      for (let i = 0; i < type.n; i++)
        store(n, addr + i * type.of.size, type.of, units[i] ?? 0);
      return;
    }
    if (v.type === "initializer_list") {
      if (planning)
        planning.items.push({
          k: "zero",
          off: addr - planning.base,
          size: type.size,
        });
      else if (!dry)
        for (let i = 0; i < type.size; i++) mem.setUint8(addr + i, 0);
      fillList(n, addr, type, stmts(v), { i: 0 }, true);
      return;
    }
    if (planning) {
      planning.items.push({ k: "val", off: addr - planning.base, t: type, v });
      return;
    }
    assign(n, { t: type, addr, lv: true }, rvalue(n, evalExpr(v)), v, "초기화");
  };
  // { } 안의 값을 items[cur.i] 부터 차례로 type 에 채운다. braced 가 아니면 중괄호를 생략한 안쪽 집합체라
  // 자리가 다 차면 남은 값은 바깥에 돌려준다. 배열이면 채운 원소 수를 돌려준다
  function fillList(
    n: Node,
    addr: number,
    type: CType,
    items: Node[],
    cur: { i: number },
    braced: boolean,
  ): number {
    // 하나를 채운다. 안쪽이 집합체인데 { } 없이 값이 오면 그 값부터 안쪽을 채운다
    const one = (at: number, t: CType) => {
      const it = items[cur.i];
      const elided =
        it.type !== "initializer_list" &&
        ((t.k === "array" && !isString(it)) ||
          (t.k === "struct" && typeOnly(it).k !== "struct"));
      if (elided) fillList(n, at, t, items, cur, false);
      else {
        initialize(n, at, t, it);
        cur.i++;
      }
    };
    if (type.k === "array") {
      let i = 0;
      let most = 0;
      while (cur.i < items.length) {
        const it = items[cur.i];
        if (it.type === "initializer_pair") {
          if (!braced) break;
          const [d, ...rest] = it.childrenForFieldName("designator");
          if (d?.type !== "subscript_designator")
            fail(it, "배열 초기화의 자리는 [n] 으로 씁니다");
          i = constEval(d.namedChildren[0] ?? fail(d, "자리가 없습니다"));
          if (type.n && i >= type.n) fail(it, "초기화 값이 배열보다 많습니다");
          const at = designate(rest, addr + i * type.of.size, type.of);
          initialize(n, at.addr, at.t, field(it, "value"));
          cur.i++;
        } else {
          if (type.n && i >= type.n) {
            if (braced) fail(it, "초기화 값이 배열보다 많습니다");
            break;
          }
          one(addr + i * type.of.size, type.of);
        }
        most = Math.max(most, ++i);
        if (!braced && type.n && i >= type.n) break;
      }
      return most;
    }
    if (type.k === "struct" && type.fields) {
      const order = inOrder(type);
      let fi = 0;
      while (cur.i < items.length) {
        const it = items[cur.i];
        if (it.type === "initializer_pair") {
          if (!braced) break;
          const [d, ...rest] = it.childrenForFieldName("designator");
          const name = d?.text.replace(/^\./, "") ?? "";
          const f =
            type.fields.find((x) => x.name === name) ??
            fail(it, `${name} 필드가 없습니다`);
          fi = order.indexOf(f) + 1 || order.length;
          const at = designate(rest, addr + f.offset, f.type);
          initialize(n, at.addr, at.t, field(it, "value"));
          cur.i++;
          continue;
        }
        const f = order[fi++];
        if (!f) {
          if (braced) fail(it, "초기화 값이 필드보다 많습니다");
          break;
        }
        one(addr + f.offset, f.type);
        if (!braced && fi >= order.length) break;
      }
      return 0;
    }
    // { 5 } 처럼 중괄호 안의 값 하나
    const first = items[cur.i];
    if (strict() && braced && items.length - cur.i > 1)
      fail(items[cur.i + 1], "값 하나인 자리에 값을 여럿 주었습니다");
    if (first) {
      initialize(n, addr, type, first);
      cur.i++;
    }
    return 0;
  }

  // & 바로 안의 a[i] (그 식을 계산하는 동안만 뜻이 있다)
  let pastEnd: Node | null = null;
  // & 안에서 주소만 셈하는 식들(p->a.b 의 p->a 까지)
  const addressOnly = new WeakSet<Node>();
  // 지금 실행 중인 곳(해석기 자체가 멈출 때 그 줄을 알리려고)
  let here: Node | null = null;
  // 빠른 실행에서 해석기로 도는 함수는 한 걸음을 FAST_OPS 로 센다(해석기 속도로는 원래 한도만큼만)
  const cost = fast ? FAST_OPS : 1;
  const tick = (n: Node) => {
    here = n;
    budget.n -= cost;
    if (budget.n < 0)
      fail(n, "너무 오래 걸려 멈췄습니다. 끝나지 않는 반복이 있는지 봅시다");
  };

  function evalExpr(n: Node): X {
    if (dry || checking) return evalSlow(n);
    return codeOf(n)();
  }
  function evalSlow(n: Node): X {
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
        const text = n.text.slice(0, n.text.length - suffix.length);
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
        return { t, v: norm(v) };
      }
      case "char_literal": {
        const q = n.text.indexOf("'");
        const prefix = n.text.slice(0, q);
        const body = n.text.slice(q + 1, -1);
        if (prefix in PREFIX_TYPE)
          return {
            t: PREFIX_TYPE[prefix],
            v: wideUnits(body, prefix === "u")[0] ?? 0,
          };
        // char 는 부호가 있어 '\xff' 는 -1
        const c = unquote(body).charCodeAt(0);
        return { t: T.int, v: (c << 24) >> 24 };
      }
      // 문자열 상수는 char 배열이다(sizeof "ab" 는 3, 쓰면 첫 글자 주소로 바뀐다)
      case "string_literal":
      case "concatenated_string":
        return evalLiteral(n);
      case "null":
        return { t: ptr(T.void), v: 0 };
      case "identifier": {
        const name = n.text;
        const local = findScoped(name);
        if (local?.kind === "enum") return { t: T.int, v: local.value ?? 0 };
        if (local?.kind === "typedef") return { t: local.type, v: 0 };
        const e = local ? undefined : enums.get(name);
        if (e !== undefined) return { t: T.int, v: e };
        const fn = funcs.get(name);
        if (fn && !lookupMaybe(name)) return { t: fn.type, v: fn.addr };
        const proto = protos.get(name);
        const libAddr = known(name) ? LIBRARY_ADDR.get(name) : undefined;
        if (libAddr !== undefined && !lookupMaybe(name))
          return { t: proto ?? libType(name), v: libAddr };
        // 원형만 있고 정의는 아직(검사 중) 또는 끝내 없다
        if (proto && !lookupMaybe(name)) return { t: proto, v: 0 };
        const stream = known(name) ? STREAMS[name] : undefined;
        if (stream && !lookupMaybe(name)) return { t: ptr(FILE), v: stream };
        if (name === "__func__" && !lookupMaybe(name))
          return evalString(frame()?.name ?? "");
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
        const left = field(n, "left");
        const right = field(n, "right");
        const place = evalExpr(left);
        if (strict()) modifiable(n, left, place.t);
        let val = rvalue(n, evalExpr(right));
        if (op !== "=")
          val = arith(n, op.slice(0, -1), rvalue(n, place), val, left, right);
        assign(n, place, val, op === "=" ? right : null);
        return { t: valueType(place.t), v: wrap(place.t, val.v) };
      }
      case "binary_expression": {
        const op = field(n, "operator").text;
        const left = field(n, "left");
        const right = field(n, "right");
        const a = rvalue(n, evalExpr(left));
        // && 와 || 는 오른쪽을 계산하지 않을 때도 있으니 검사할 땐 타입을 따로 본다
        if ((op === "&&" || op === "||") && strict())
          for (const t of [a.t, typeOnly(right)])
            if (!isScalar(t))
              fail(n, `${typeName(t)} 에는 ${op} 를 쓸 수 없습니다`);
        if (op === "&&")
          return {
            t: T.int,
            v:
              truth(a.v) && truth(rvalue(n, evalExpr(field(n, "right"))).v)
                ? 1
                : 0,
          };
        if (op === "||")
          return {
            t: T.int,
            v:
              truth(a.v) || truth(rvalue(n, evalExpr(field(n, "right"))).v)
                ? 1
                : 0,
          };
        return arith(n, op, a, rvalue(n, evalExpr(right)), left, right);
      }
      case "unary_expression": {
        const op = field(n, "operator").text;
        const a = rvalue(n, evalExpr(field(n, "argument")));
        if (
          strict() &&
          (op === "!"
            ? !isScalar(a.t)
            : op === "~"
              ? a.t.k !== "int"
              : !isArith(a.t))
        )
          fail(n, `${typeName(decay(a.t))} 에는 ${op} 를 쓸 수 없습니다`);
        const t = a.t.k === "int" && a.t.size < 4 ? T.int : a.t;
        if (op === "-") return { t, v: wrap(t, neg(a.v)) };
        if (op === "+") return { t, v: a.v };
        if (op === "!") return { t: T.int, v: truth(a.v) ? 0 : 1 };
        if (op === "~")
          return { t, v: wrap(t, t.size === 8 ? ~big(a.v) : ~num(a.v)) };
        return fail(n, `지원하지 않는 연산자 ${op}`);
      }
      case "pointer_expression": {
        const op = field(n, "operator").text;
        const argNode = field(n, "argument");
        if (op === "&") {
          // &*p 는 p 다(따라가지 않으니 NULL 이어도 된다)
          if (
            argNode.type === "pointer_expression" &&
            argNode.childForFieldName("operator")?.text === "*"
          ) {
            const p = rvalue(n, evalExpr(field(argNode, "argument")));
            if (p.t.k === "ptr") return p;
          }
          // &a[n] 은 끝 바로 다음 주소라 써도 된다(따라가지만 않으면).
          // &p->m 도 따라가지 않고 주소만 더하니 p 가 NULL 이어도 된다(&((T *)0)->m 으로 offsetof 를 셈한다)
          pastEnd = argNode;
          for (let a: Node | undefined = argNode; a; ) {
            addressOnly.add(a);
            a =
              a.type === "field_expression" || a.type === "subscript_expression"
                ? (a.childForFieldName("argument") ?? undefined)
                : a.type === "parenthesized_expression"
                  ? a.namedChildren[0]
                  : undefined;
          }
          const x = evalExpr(argNode);
          if (x.t.k === "func")
            return { t: ptr(x.t), v: x.lv ? x.addr : num(x.v) };
          if (!x.lv || x.temp) return fail(n, "주소를 얻을 수 없는 식입니다");
          return { t: ptr(x.t), v: x.addr };
        }
        const p = rvalue(n, evalExpr(argNode));
        if (p.t.k !== "ptr") return fail(n, "포인터가 아닌 것을 따라갔습니다");
        if (strict() && p.t.to.k === "void")
          fail(
            n,
            "void * 는 따라갈 수 없습니다. 먼저 다른 포인터 타입으로 바꿉니다",
          );
        if (p.v === 0 && !dry) fail(n, "NULL 포인터를 따라갔습니다");
        return { t: p.t.to, addr: num(p.v), lv: true };
      }
      case "update_expression": {
        const op = field(n, "operator").text;
        const place = evalExpr(field(n, "argument"));
        if (strict()) modifiable(n, field(n, "argument"), place.t);
        const old = rvalue(n, place);
        const nv = arith(n, op === "++" ? "+" : "-", old, { t: T.int, v: 1 });
        assign(n, place, nv);
        const prefix = n.firstChild?.type === op;
        return prefix ? { t: old.t, v: wrap(place.t, nv.v) } : old;
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
          if (addr === 0 && !dry && !addressOnly.has(n))
            fail(n, "NULL 포인터를 따라갔습니다");
        } else {
          if (b.t.k !== "struct") return fail(n, ". 앞은 struct 여야 합니다");
          st = b.t;
          addr = b.lv ? b.addr : num(b.v);
        }
        const f = st.fields?.find((x) => x.name === fname);
        if (!f) return fail(n, `${typeName(st)}에 ${fname} 필드가 없습니다`);
        const temp = op === "." && (!b.lv || !!b.temp);
        return {
          t: qualify(f.type, st.q ?? 0),
          addr: addr + f.offset,
          lv: true,
          temp,
        };
      }
      case "subscript_expression": {
        const arrayNode = field(n, "argument");
        const allowEnd = pastEnd === n;
        let base0 = evalExpr(arrayNode);
        let i = rvalue(n, evalExpr(field(n, "index")));
        // a[i] 는 *(a + i) 라 i[a] 도 같다
        if (base0.t.k === "int" && (i.t.k === "ptr" || i.t.k === "array")) {
          const swap = rvalue(n, base0);
          base0 = i;
          i = swap;
        }
        const a = rvalue(n, base0);
        if (a.t.k !== "ptr")
          return fail(n, "[] 앞은 배열이나 포인터여야 합니다");
        if (strict()) {
          if (i.t.k !== "int") fail(n, "[] 안에는 정수가 와야 합니다");
          if (!complete(a.t.to))
            fail(
              n,
              `${typeName(a.t.to)} 를 가리키는 포인터에는 [] 를 쓸 수 없습니다`,
            );
        }
        const iv = num(i.v);
        const end = allowEnd ? 1 : 0;
        if (
          !dry &&
          base0.lv &&
          base0.t.k === "array" &&
          // 크기 없는 마지막 멤버(int data[])는 malloc 으로 받은 만큼 쓴다. 그 범위는 힙이 잡는다
          base0.t.n > 0 &&
          (iv < 0 || iv >= base0.t.n + end)
        )
          fail(
            n,
            `배열 ${arrayNode.text}[${base0.t.n}]의 범위 밖 인덱스 ${iv}입니다`,
          );
        return { t: a.t.to, addr: num(a.v) + iv * a.t.to.size, lv: true };
      }
      case "alignof_expression": {
        const tn = n.childForFieldName("type");
        const t = tn ? typeOfDescriptor(tn) : typeOnly(field(n, "value"));
        if (strict() && !complete(t))
          fail(
            n,
            `${typeName(t)} 의 정렬은 알 수 없습니다(크기를 모르는 타입)`,
          );
        return { t: T.ulong, v: (t.k === "array" ? elemOf(t) : t).align };
      }
      case "offsetof_expression": {
        const t = typeOfDescriptor(field(n, "type"));
        const m = field(n, "member").text;
        const f =
          (t.k === "struct" && t.fields?.find((x) => x.name === m)) ||
          fail(n, `${typeName(t)}에 ${m} 필드가 없습니다`);
        return { t: T.ulong, v: f.offset };
      }
      case "generic_expression": {
        // _Generic(x, int: …, char *: …, default: …): x 의 타입(배열·함수는 포인터로)과 같은 타입의 식 하나만 계산한다
        const [ctrl, ...rest] = stmts(n);
        let t = unqualified(typeOnly(ctrl));
        if (t.k === "array") t = ptr(t.of);
        else if (t.k === "func") t = ptr(t);
        let fallback: Node | null = null;
        for (let i = 0; i + 1 < rest.length; i += 2) {
          const td = rest[i];
          if (td.text === "default") fallback = rest[i + 1];
          else if (sameType(typeOfDescriptor(td), t))
            return evalExpr(rest[i + 1]);
        }
        return evalExpr(
          fallback ??
            fail(n, `_Generic 에 ${typeName(t)} 에 맞는 것이 없습니다`),
        );
      }
      case "sizeof_expression": {
        const tn = n.childForFieldName("type");
        const t = tn ? typeOfDescriptor(tn) : typeOnly(field(n, "value"));
        if (strict() && !complete(t))
          fail(n, `${typeName(t)} 의 크기는 알 수 없습니다`);
        return { t: T.ulong, v: t.size };
      }
      case "cast_expression": {
        const t = unqualified(typeOfDescriptor(field(n, "type")));
        const x = rvalue(n, evalExpr(field(n, "value")));
        if (t.k === "void") return { t, v: 0 };
        if (strict()) {
          const from = decay(x.t);
          if (!isArith(t) && t.k !== "ptr")
            fail(
              n,
              `${typeName(t)} 로는 형 변환할 수 없습니다. 수·포인터·void 로만 바꿉니다`,
            );
          if (!isScalar(from))
            fail(n, `${typeName(from)} 값은 형 변환할 수 없습니다`);
          if (
            (t.k === "ptr" && from.k === "float") ||
            (t.k === "float" && from.k === "ptr")
          )
            fail(n, "포인터와 실수 사이는 형 변환할 수 없습니다");
        }
        return { t, v: wrap(t, x.v) };
      }
      case "conditional_expression": {
        const c = rvalue(n, evalExpr(field(n, "condition")));
        if (strict() && !isScalar(c.t))
          fail(
            n,
            `조건에는 수나 포인터가 와야 하는데 ${typeName(c.t)} 가 왔습니다`,
          );
        const yes = truth(c.v);
        const pick = field(n, yes ? "consequence" : "alternative");
        const otherNode = field(n, yes ? "alternative" : "consequence");
        const v = rvalue(n, evalExpr(pick));
        return choose(n, v, decay(typeOnly(otherNode)), pick, otherNode);
      }
      case "call_expression":
        return call(n);
      case "compound_literal_expression": {
        // (Point){1, 2}: 이름 없는 변수를 지금 함수의 스택에 잡아 초기화한다
        let t = typeOfDescriptor(field(n, "type"));
        const init = field(n, "value");
        if (t.k === "array" && !t.n) t = arr(t.of, initCount(init, t.of));
        if (dry) {
          initialize(n, 0, t, init);
          return { t, addr: 0, lv: true };
        }
        // 같은 식을 다시 지나면(반복·goto) 같은 자리를 다시 쓴다. 표준에서도 같은 객체다
        const f = frames.length ? frame() : null;
        const addr = f?.slots.get(n) ?? (f ? alloca(n, t) : staticAlloc(n, t));
        f?.slots.set(n, addr);
        initialize(n, addr, t, init);
        return { t, addr, lv: true };
      }
      default:
        return fail(n, `지원하지 않는 식 ${n.type}`);
    }
  }
  // ?: 의 값: 고른 갈래의 값 v 를 다른 갈래의 타입 o 와 맞춘다
  const choose = (
    n: Node,
    v: Val,
    o: CType,
    pick: Node,
    otherNode: Node,
  ): X => {
    // 두 갈래가 다 수면 둘의 공통 타입으로(고르지 않은 쪽은 타입만 본다)
    const vt = decay(v.t);
    if (isArith(vt) && isArith(o)) {
      const t =
        isDouble(v.t) || isDouble(o)
          ? T.double
          : v.t.k === "float" || o.k === "float"
            ? T.float
            : promote(v.t, o);
      return { t, v: wrap(t, v.v) };
    }
    // 포인터와 포인터(한쪽이 void * 면 void *), 포인터와 널 포인터 상수면 포인터 타입
    if (vt.k === "ptr" || o.k === "ptr") {
      const mismatch = () =>
        fail(
          n,
          `?: 의 두 갈래 타입(${typeName(vt)}, ${typeName(o)})이 맞지 않습니다`,
        );
      if (vt.k === "ptr" && o.k === "ptr") {
        if (strict() && !ptrCompat(vt, o)) mismatch();
        // 결과는 두 쪽 한정자를 다 가진 것을 가리킨다
        const to = (o.to.k === "void" ? o : vt).to;
        return {
          t: ptr(qualify(to, (vt.to.q ?? 0) | (o.to.q ?? 0))),
          v: v.v,
        };
      }
      if (strict() && !isNullConst(vt.k === "ptr" ? otherNode : pick))
        mismatch();
      return { t: vt.k === "ptr" ? vt : o, v: v.v };
    }
    if (
      strict() &&
      !(vt.k === "void" && o.k === "void") &&
      !(
        vt.k === "struct" &&
        o.k === "struct" &&
        unqualified(vt) === unqualified(o)
      )
    )
      fail(
        n,
        `?: 의 두 갈래 타입(${typeName(vt)}, ${typeName(o)})이 맞지 않습니다`,
      );
    return v;
  };

  // --- 빠른 실행 ---
  // 실행 중에 처음 계산하는 식을 함수로 바꿔 노드에 달아 둔다. 노드 종류·연산자·타입은 그 자리에서 늘
  // 같으니 한 번만 보고, 다음부턴 값만 셈한다. 검사(dry)와 드문 식은 evalSlow 가 한다
  type Code = () => X;
  const codeOf = (n: Node): Code => {
    let c = n.code as Code | undefined;
    if (!c) {
      c = compile(n);
      n.code = c;
    }
    return c;
  };
  // 식을 값으로 쓸 때의 타입(rvalue 와 같은 규칙)
  const rtype = (t: CType): CType =>
    t.k === "array"
      ? ptr(t.of)
      : t.k === "func"
        ? t
        : unqualified(valueType(t));
  // int 이하 정수 둘의 연산(가장 흔한 것)을 승격·자르기까지 한 번에. 결과 타입이 4바이트가 아니면 null
  // int 이하 정수 둘의 연산(가장 흔한 것)을 승격·자르기까지 한 번에. 결과 타입이 4바이트가 아니면 null
  type Op2 = (n: Node, x: number, y: number) => number;
  const int32 = (
    op: string,
    a: CType,
    b: CType,
  ): { t: IntType; f: Op2 } | null => {
    if (a.k !== "int" || b.k !== "int") return null;
    const shift = op === "<<" || op === ">>";
    const t = shift ? promote(a, a) : promote(a, b);
    if (t.size !== 4) return null;
    const f = t.signed ? signed32(op) : unsigned32(op);
    if (!f) return null;
    return { t: CMP.has(op) ? T.int : t, f };
  };
  const CMP = new Set(["<", ">", "<=", ">=", "==", "!="]);
  const zero = (n: Node) => fail(n, "0으로 나눴습니다");
  const signed32 = (op: string): Op2 | null => {
    switch (op) {
      case "+":
        return (_, x, y) => (x + y) | 0;
      case "-":
        return (_, x, y) => (x - y) | 0;
      case "*":
        return (_, x, y) => Math.imul(x, y);
      case "/":
        return (n, x, y) => (y === 0 ? zero(n) : (x / y) | 0);
      case "%":
        return (n, x, y) => (y === 0 ? zero(n) : (x % y) | 0);
      case "&":
        return (_, x, y) => x & y;
      case "|":
        return (_, x, y) => x | y;
      case "^":
        return (_, x, y) => x ^ y;
      case "<<":
        return (_, x, y) => x << y;
      case ">>":
        return (_, x, y) => x >> y;
    }
    return compare(op);
  };
  // unsigned int: 값을 먼저 0 ~ 2^32-1 로
  const u = (x: number) => x >>> 0;
  const unsigned32 = (op: string): Op2 | null => {
    switch (op) {
      case "+":
        return (_, x, y) => (x + y) >>> 0;
      case "-":
        return (_, x, y) => (x - y) >>> 0;
      case "*":
        return (_, x, y) => Math.imul(x, y) >>> 0;
      case "/":
        return (n, x, y) => (u(y) === 0 ? zero(n) : (u(x) / u(y)) >>> 0);
      case "%":
        return (n, x, y) => (u(y) === 0 ? zero(n) : (u(x) % u(y)) >>> 0);
      case "&":
        return (_, x, y) => (x & y) >>> 0;
      case "|":
        return (_, x, y) => (x | y) >>> 0;
      case "^":
        return (_, x, y) => (x ^ y) >>> 0;
      case "<<":
        return (_, x, y) => (x << y) >>> 0;
      case ">>":
        return (_, x, y) => u(x) >>> y;
    }
    const c = compare(op);
    return c && ((n, x, y) => c(n, u(x), u(y)));
  };
  const compare = (op: string): Op2 | null => {
    switch (op) {
      case "<":
        return (_, x, y) => (x < y ? 1 : 0);
      case ">":
        return (_, x, y) => (x > y ? 1 : 0);
      case "<=":
        return (_, x, y) => (x <= y ? 1 : 0);
      case ">=":
        return (_, x, y) => (x >= y ? 1 : 0);
      case "==":
        return (_, x, y) => (x === y ? 1 : 0);
      case "!=":
        return (_, x, y) => (x !== y ? 1 : 0);
    }
    return null;
  };
  // 숫자 하나로 읽고 쓰는 값(4바이트 이하 정수, 실수, 포인터. 비트 필드는 빼고)
  type NumCode = () => number;
  const numeric = (t: CType) =>
    (t.k === "int" && t.size <= 4 && t.bits === undefined) ||
    t.k === "float" ||
    t.k === "ptr";
  const loader = (t: CType): ((n: Node, a: number) => number) => {
    if (t.k === "float")
      return t.size === 4
        ? (n, a) => {
            check(n, a, 4);
            return mem.getFloat32(a, true);
          }
        : (n, a) => {
            check(n, a, 8);
            return mem.getFloat64(a, true);
          };
    if (t.k === "ptr")
      return (n, a) => {
        check(n, a, 8);
        return mem.getUint32(a, true) + mem.getUint32(a + 4, true) * 2 ** 32;
      };
    const signed = t.k === "int" && t.signed;
    if (t.size === 1)
      return signed
        ? (n, a) => {
            check(n, a, 1);
            return mem.getInt8(a);
          }
        : (n, a) => {
            check(n, a, 1);
            return mem.getUint8(a);
          };
    if (t.size === 2)
      return signed
        ? (n, a) => {
            check(n, a, 2);
            return mem.getInt16(a, true);
          }
        : (n, a) => {
            check(n, a, 2);
            return mem.getUint16(a, true);
          };
    return signed
      ? (n, a) => {
          check(n, a, 4);
          return mem.getInt32(a, true);
        }
      : (n, a) => {
          check(n, a, 4);
          return mem.getUint32(a, true);
        };
  };
  // 이미 그 타입으로 자른 값을 쓴다
  const storer = (t: CType): ((n: Node, a: number, v: number) => void) => {
    if (t.k === "float") return (n, a, v) => store(n, a, t, v);
    if (t.k === "ptr")
      return (n, a, v) => {
        if (v >= 0 && v < 2 ** 32) {
          check(n, a, 8);
          mem.setUint32(a, v, true);
          mem.setUint32(a + 4, 0, true);
        } else store(n, a, t, v);
      };
    if (t.size === 1)
      return (n, a, v) => {
        check(n, a, 1);
        mem.setUint8(a, v & 0xff);
      };
    if (t.size === 2)
      return (n, a, v) => {
        check(n, a, 2);
        mem.setUint16(a, v & 0xffff, true);
      };
    return (n, a, v) => {
      check(n, a, 4);
      mem.setUint32(a, v >>> 0, true);
    };
  };
  // 두 숫자 값의 연산. 결과 타입과 함께. 실수가 끼거나 8바이트 정수면 null(일반 길로)
  const numBinop = (
    op: string,
    a: CType,
    b: CType,
  ): { t: CType; f: Op2 } | null => {
    const i = int32(op, a, b);
    if (i) return i;
    // 포인터 ± 정수, 포인터끼리 견주기
    if (a.k === "ptr" && b.k === "int" && b.size <= 4) {
      const size = Math.max(a.to.size, 1);
      if (op === "+") return { t: a, f: (_, x, y) => x + y * size };
      if (op === "-") return { t: a, f: (_, x, y) => x - y * size };
    }
    if (a.k === "int" && a.size <= 4 && b.k === "ptr" && op === "+") {
      const size = Math.max(b.to.size, 1);
      return { t: b, f: (_, x, y) => y + x * size };
    }
    const c = compare(op);
    if (
      c &&
      (a.k === "ptr" || b.k === "ptr") &&
      a.k !== "float" &&
      b.k !== "float"
    )
      return { t: T.int, f: c };
    return null;
  };

  const numMemo = new Map<Node, NumCode | null>();
  const addrMemo = new Map<Node, NumCode | null>();
  const numCode = (n: Node): NumCode | null => {
    let c = numMemo.get(n);
    if (c === undefined) {
      c = buildNum(n);
      numMemo.set(n, c);
    }
    return c;
  };
  const addrCode = (n: Node): NumCode | null => {
    let c = addrMemo.get(n);
    if (c === undefined) {
      c = buildAddr(n);
      addrMemo.set(n, c);
    }
    return c;
  };
  // 이름이 변수면 그 자리. 선언은 글자 자리로 정해지고 지역 변수의 자리는 호출마다 하나라
  // 호출(frame)이 같으면 찾은 자리를 그대로 쓴다. 전역은 늘 같다
  const varAddr = (n: Node): NumCode | null => {
    const name = n.text;
    const local = findScoped(name);
    const variable = local
      ? !local.kind
      : !enums.has(name) && globals.has(name);
    if (!variable) return null;
    if (!local) {
      let g: Binding | undefined;
      return () => {
        tick(n);
        g ??= lookup(n, name);
        return g.addr;
      };
    }
    let seen: unknown = null;
    let addr = 0;
    return () => {
      tick(n);
      const f = frames[frames.length - 1];
      if (f !== seen) {
        addr = lookup(n, name).addr;
        seen = f;
      }
      return addr;
    };
  };
  const PLACES = new Set([
    "identifier",
    "subscript_expression",
    "field_expression",
    "pointer_expression",
  ]);
  // 자리(lvalue)의 주소를 셈하는 함수
  const buildAddr = (n: Node): NumCode | null => {
    switch (n.type) {
      case "identifier":
        return varAddr(n);
      case "parenthesized_expression": {
        const inner = n.namedChildren[0];
        return inner ? addrCode(inner) : null;
      }
      case "subscript_expression": {
        const arrayNode = field(n, "argument");
        const bt = typeOnly(arrayNode);
        const I = numCode(field(n, "index"));
        const it = rtype(typeOnly(field(n, "index")));
        if (!I || it.k !== "int") return null;
        if (bt.k === "array") {
          const A = addrCode(arrayNode);
          if (!A) return null;
          const size = bt.of.size;
          const len = bt.n;
          return () => {
            tick(n);
            const end = pastEnd === n ? 1 : 0;
            const a = A();
            const i = I();
            if (len > 0 && (i < 0 || i >= len + end))
              fail(
                n,
                `배열 ${arrayNode.text}[${len}]의 범위 밖 인덱스 ${i}입니다`,
              );
            return a + i * size;
          };
        }
        if (bt.k !== "ptr") return null;
        const P = numCode(arrayNode);
        if (!P) return null;
        const size = bt.to.size;
        return () => {
          tick(n);
          const p = P();
          return p + I() * size;
        };
      }
      case "pointer_expression": {
        if (field(n, "operator").text !== "*") return null;
        const arg = field(n, "argument");
        const pt = rtype(typeOnly(arg));
        const P = numCode(arg);
        if (!P || pt.k !== "ptr") return null;
        return () => {
          tick(n);
          const p = P();
          if (p === 0) fail(n, "NULL 포인터를 따라갔습니다");
          return p;
        };
      }
      case "field_expression": {
        const arrow = field(n, "operator").text === "->";
        const argNode = field(n, "argument");
        const at = arrow ? rtype(typeOnly(argNode)) : typeOnly(argNode);
        const st = arrow ? (at.k === "ptr" ? at.to : null) : at;
        if (st?.k !== "struct") return null;
        const fname = field(n, "field").text;
        const f = st.fields?.find((x) => x.name === fname);
        if (!f) return null;
        const off = f.offset;
        if (arrow) {
          const P = numCode(argNode);
          if (!P) return null;
          return () => {
            tick(n);
            const p = P();
            if (p === 0 && !addressOnly.has(n))
              fail(n, "NULL 포인터를 따라갔습니다");
            return p + off;
          };
        }
        const B = addrCode(argNode);
        if (!B) return null;
        return () => {
          tick(n);
          return B() + off;
        };
      }
      default:
        return null;
    }
  };
  // 숫자 값으로 셈하는 함수. 값을 { t, v } 로 싸지 않아 빠르다
  const buildNum = (n: Node): NumCode | null => {
    const t = rtype(typeOnly(n));
    if (!numeric(t)) return null;
    switch (n.type) {
      case "number_literal":
      case "char_literal":
      case "alignof_expression":
      case "offsetof_expression":
      case "sizeof_expression": {
        const v = num((evalSlow(n) as Val).v);
        return () => {
          tick(n);
          return v;
        };
      }
      case "parenthesized_expression": {
        const inner = n.namedChildren[0];
        return inner ? numCode(inner) : null;
      }
      case "comma_expression": {
        const L = codeOf(field(n, "left"));
        const R = numCode(field(n, "right"));
        if (!R) return null;
        return () => {
          tick(n);
          L();
          return R();
        };
      }
      case "identifier":
      case "subscript_expression":
      case "field_expression":
      case "pointer_expression": {
        const pt = typeOnly(n);
        if (pt.k !== "array" && !numeric(pt)) return null;
        const A = addrCode(n);
        if (!A) return null;
        if (pt.k === "array") return A;
        const ld = loader(pt);
        return () => ld(n, A());
      }
      case "binary_expression": {
        const op = field(n, "operator").text;
        const left = field(n, "left");
        const right = field(n, "right");
        const A = numCode(left);
        const B = numCode(right);
        if (!A || !B) return null;
        if (op === "&&")
          return () => {
            tick(n);
            return A() !== 0 && B() !== 0 ? 1 : 0;
          };
        if (op === "||")
          return () => {
            tick(n);
            return A() !== 0 || B() !== 0 ? 1 : 0;
          };
        const bin = numBinop(op, rtype(typeOnly(left)), rtype(typeOnly(right)));
        if (!bin) return null;
        const f = bin.f;
        return () => {
          tick(n);
          const x = A();
          return f(n, x, B());
        };
      }
      case "unary_expression": {
        const op = field(n, "operator").text;
        const A = numCode(field(n, "argument"));
        if (!A) return null;
        if (op === "!")
          return () => {
            tick(n);
            return A() !== 0 ? 0 : 1;
          };
        if (op === "+") return A;
        if (op === "-")
          return () => {
            tick(n);
            return wrap(t, -A()) as number;
          };
        if (op === "~" && t.k === "int" && t.size === 4)
          return () => {
            tick(n);
            return wrap(t, ~A()) as number;
          };
        return null;
      }
      case "cast_expression": {
        const A = numCode(field(n, "value"));
        if (!A) return null;
        return () => {
          tick(n);
          return wrap(t, A()) as number;
        };
      }
      case "conditional_expression": {
        const C = numCode(field(n, "condition"));
        const Y = numCode(field(n, "consequence"));
        const N = numCode(field(n, "alternative"));
        if (!C || !Y || !N) return null;
        return () => {
          tick(n);
          return wrap(t, C() !== 0 ? Y() : N()) as number;
        };
      }
      case "assignment_expression": {
        const op = field(n, "operator").text;
        const left = field(n, "left");
        const pt = typeOnly(left);
        if (!numeric(pt)) return null;
        const A = addrCode(left);
        const R = numCode(field(n, "right"));
        if (!A || !R) return null;
        const ld = loader(pt);
        const st = storer(pt);
        const rt = rtype(typeOnly(field(n, "right")));
        const heapPtr = pt.k === "ptr" && pt.to.k !== "void" ? pt.to : null;
        const bin =
          op === "=" ? null : numBinop(op.slice(0, -1), unqualified(pt), rt);
        if (op !== "=" && !bin) return null;
        const f = bin?.f;
        return () => {
          tick(n);
          const a = A();
          let v = f ? f(n, ld(n, a), R()) : R();
          v = wrap(pt, v) as number;
          // malloc 이 준 블록은 처음 담긴 포인터의 타입으로 보인다
          if (heapPtr && v >= heapBase) {
            const b = blockStart(v);
            if (b && !b.ctype) b.ctype = heapPtr;
          }
          st(n, a, v);
          return v;
        };
      }
      case "update_expression": {
        const op = field(n, "operator").text;
        const arg = field(n, "argument");
        const pt = typeOnly(arg);
        if (!numeric(pt)) return null;
        const prefix = n.firstChild?.type === op;
        const A = addrCode(arg);
        if (!A) return null;
        const ld = loader(pt);
        const st = storer(pt);
        const d =
          (op === "++" ? 1 : -1) *
          (pt.k === "ptr" ? Math.max(pt.to.size, 1) : 1);
        return () => {
          tick(n);
          const a = A();
          const old = ld(n, a);
          const v = wrap(pt, old + d) as number;
          st(n, a, v);
          return prefix ? v : old;
        };
      }
      default:
        return null;
    }
  };
  const compile = (n: Node): Code => {
    // 숫자 하나로 셈할 수 있으면 그 함수를 감싼다. 괄호는 안이 자리일 수도 있어 아래에서
    if (n.type !== "parenthesized_expression") {
      const t = typeOnly(n);
      if (PLACES.has(n.type)) {
        const A = addrCode(n);
        if (A) return () => ({ t, addr: A(), lv: true });
      } else {
        const N = numCode(n);
        const rt = rtype(t);
        if (N) return () => ({ t: rt, v: N() });
      }
    }
    const slow: Code = () => evalSlow(n);
    switch (n.type) {
      // 값이 늘 같은 식
      case "number_literal":
      case "char_literal":
      case "sizeof_expression":
      case "alignof_expression":
      case "offsetof_expression": {
        const { t, v } = evalSlow(n) as Val;
        return () => {
          tick(n);
          return { t, v };
        };
      }
      case "identifier": {
        const name = n.text;
        const local = findScoped(name);
        const variable = local
          ? !local.kind
          : !enums.has(name) && globals.has(name);
        if (!variable) return slow;
        // 이름이 가리키는 선언은 글자 자리로 정해지고, 지역 변수의 자리는 호출마다 하나라
        // 호출(frame)이 같으면 찾은 자리를 그대로 쓴다. 전역은 늘 같다
        if (!local) {
          let g: Binding | undefined;
          return () => {
            tick(n);
            g ??= lookup(n, name);
            return { t: g.type, addr: g.addr, lv: true };
          };
        }
        let seen: unknown = null;
        let b: Binding | undefined;
        return () => {
          tick(n);
          const f = frames[frames.length - 1];
          if (f !== seen || !b) {
            b = lookup(n, name);
            seen = f;
          }
          return { t: b.type, addr: b.addr, lv: true };
        };
      }
      case "parenthesized_expression": {
        const inner = n.namedChildren[0];
        return inner ? codeOf(inner) : slow;
      }
      case "comma_expression": {
        const L = codeOf(field(n, "left"));
        const R = codeOf(field(n, "right"));
        return () => {
          tick(n);
          L();
          return R();
        };
      }
      case "binary_expression": {
        const op = field(n, "operator").text;
        const left = field(n, "left");
        const right = field(n, "right");
        const A = codeOf(left);
        const B = codeOf(right);
        if (op === "&&")
          return () => {
            tick(n);
            return {
              t: T.int,
              v: truth(rvalue(n, A()).v) && truth(rvalue(n, B()).v) ? 1 : 0,
            };
          };
        if (op === "||")
          return () => {
            tick(n);
            return {
              t: T.int,
              v: truth(rvalue(n, A()).v) || truth(rvalue(n, B()).v) ? 1 : 0,
            };
          };
        return () => {
          tick(n);
          const a = rvalue(n, A());
          return arith(n, op, a, rvalue(n, B()));
        };
      }
      case "unary_expression": {
        const op = field(n, "operator").text;
        const A = codeOf(field(n, "argument"));
        return () => {
          tick(n);
          const a = rvalue(n, A());
          const t = a.t.k === "int" && a.t.size < 4 ? T.int : a.t;
          if (op === "-") return { t, v: wrap(t, neg(a.v)) };
          if (op === "+") return { t, v: a.v };
          if (op === "!") return { t: T.int, v: truth(a.v) ? 0 : 1 };
          return { t, v: wrap(t, t.size === 8 ? ~big(a.v) : ~num(a.v)) };
        };
      }
      case "assignment_expression": {
        const op = field(n, "operator").text;
        const bop = op.slice(0, -1);
        const left = field(n, "left");
        const L = codeOf(left);
        const R = codeOf(field(n, "right"));
        const pt = typeOnly(left);
        // 비트 필드가 아닌 정수·실수 자리에 = 이면 자르고 저장하면 끝
        if (
          op === "=" &&
          ((pt.k === "int" && pt.bits === undefined) || pt.k === "float")
        ) {
          const rt = unqualified(pt);
          return () => {
            tick(n);
            const place = L() as Place;
            const v = wrap(pt, rvalue(n, R()).v);
            store(n, place.addr, pt, v);
            return { t: rt, v };
          };
        }
        return () => {
          tick(n);
          const place = L();
          let val = rvalue(n, R());
          if (op !== "=") val = arith(n, bop, rvalue(n, place), val);
          assign(n, place, val);
          return { t: valueType(place.t), v: wrap(place.t, val.v) };
        };
      }
      case "update_expression": {
        const op = field(n, "operator").text;
        const bop = op === "++" ? "+" : "-";
        const prefix = n.firstChild?.type === op;
        const arg = field(n, "argument");
        const A = codeOf(arg);
        const one: Val = { t: T.int, v: 1 };
        const pt = typeOnly(arg);
        if (pt.k === "int" && pt.bits === undefined && pt.size === 4) {
          const rt = unqualified(pt);
          const d = op === "++" ? 1 : -1;
          return () => {
            tick(n);
            const { addr } = A() as Place;
            const old = load(n, addr, pt) as number;
            const v = pt.signed ? (old + d) | 0 : (old + d) >>> 0;
            store(n, addr, pt, v);
            return { t: rt, v: prefix ? v : old };
          };
        }
        return () => {
          tick(n);
          const place = A();
          const old = rvalue(n, place);
          const nv = arith(n, bop, old, one);
          assign(n, place, nv);
          return prefix ? { t: old.t, v: wrap(place.t, nv.v) } : old;
        };
      }
      case "pointer_expression": {
        if (field(n, "operator").text !== "*") return slow;
        const P = codeOf(field(n, "argument"));
        return () => {
          tick(n);
          const p = rvalue(n, P());
          if (p.t.k !== "ptr")
            return fail(n, "포인터가 아닌 것을 따라갔습니다");
          if (p.v === 0) fail(n, "NULL 포인터를 따라갔습니다");
          return { t: p.t.to, addr: num(p.v), lv: true };
        };
      }
      case "subscript_expression": {
        const arrayNode = field(n, "argument");
        const indexNode = field(n, "index");
        const A = codeOf(arrayNode);
        const I = codeOf(indexNode);
        // i[a] 는 a[i] 와 같다
        const swapped =
          rtype(typeOnly(arrayNode)).k === "int" &&
          rtype(typeOnly(indexNode)).k === "ptr";
        return () => {
          tick(n);
          const end = pastEnd === n ? 1 : 0;
          let base0: X;
          let i: Val;
          if (swapped) {
            i = rvalue(n, A());
            base0 = rvalue(n, I());
          } else {
            base0 = A();
            i = rvalue(n, I());
          }
          const a = rvalue(n, base0);
          if (a.t.k !== "ptr")
            return fail(n, "[] 앞은 배열이나 포인터여야 합니다");
          const iv = num(i.v);
          if (
            base0.lv &&
            base0.t.k === "array" &&
            base0.t.n > 0 &&
            (iv < 0 || iv >= base0.t.n + end)
          )
            fail(
              n,
              `배열 ${arrayNode.text}[${base0.t.n}]의 범위 밖 인덱스 ${iv}입니다`,
            );
          return { t: a.t.to, addr: num(a.v) + iv * a.t.to.size, lv: true };
        };
      }
      case "field_expression": {
        const arrow = field(n, "operator").text === "->";
        const argNode = field(n, "argument");
        const at = rtype(typeOnly(argNode));
        const st = arrow ? (at.k === "ptr" ? at.to : null) : typeOnly(argNode);
        if (st?.k !== "struct") return slow;
        const fname = field(n, "field").text;
        const f = st.fields?.find((x) => x.name === fname);
        if (!f) return slow;
        const t = qualify(f.type, st.q ?? 0);
        const B = codeOf(argNode);
        return () => {
          tick(n);
          const b = B();
          if (arrow) {
            const addr = num(rvalue(n, b).v);
            if (addr === 0 && !addressOnly.has(n))
              fail(n, "NULL 포인터를 따라갔습니다");
            return { t, addr: addr + f.offset, lv: true };
          }
          const addr = b.lv ? b.addr : num(b.v);
          return {
            t,
            addr: addr + f.offset,
            lv: true,
            temp: !b.lv || !!b.temp,
          };
        };
      }
      case "cast_expression": {
        const t = unqualified(typeOfDescriptor(field(n, "type")));
        const A = codeOf(field(n, "value"));
        return () => {
          tick(n);
          const x = rvalue(n, A());
          return t.k === "void" ? { t, v: 0 } : { t, v: wrap(t, x.v) };
        };
      }
      case "conditional_expression": {
        const cons = field(n, "consequence");
        const alt = field(n, "alternative");
        const C = codeOf(field(n, "condition"));
        const Y = codeOf(cons);
        const N = codeOf(alt);
        const oYes = decay(typeOnly(alt));
        const oNo = decay(typeOnly(cons));
        return () => {
          tick(n);
          if (truth(rvalue(n, C()).v))
            return choose(n, rvalue(n, Y()), oYes, cons, alt);
          return choose(n, rvalue(n, N()), oNo, alt, cons);
        };
      }
      default:
        return slow;
    }
  };
  const lookupMaybe = (name: string) => {
    const f = frame();
    if (f) for (const s of f.scopes) if (s.has(name)) return true;
    return globals.has(name);
  };

  const typeOfDescriptor = (td: Node): CType =>
    abstract(specType(td), td.childForFieldName("declarator"));

  const elemOf = (t: CType): CType => (t.k === "array" ? elemOf(t.of) : t);
  const sameType = (a: CType, b: CType): boolean => {
    if (a === b) return true;
    if ((a.q ?? 0) !== (b.q ?? 0)) return false;
    if (a.k === "struct" && b.k === "struct")
      return unqualified(a) === unqualified(b);
    if (a.k === "int" && b.k === "int")
      return a.size === b.size && a.signed === b.signed && a.name === b.name;
    if (a.k === "float" && b.k === "float") return a.size === b.size;
    if (a.k === "ptr" && b.k === "ptr") return sameType(a.to, b.to);
    if (a.k === "array" && b.k === "array")
      return (!a.n || !b.n || a.n === b.n) && sameType(a.of, b.of);
    if (a.k === "func" && b.k === "func")
      return (
        sameType(a.ret, b.ret) &&
        (!a.params ||
          !b.params ||
          (a.params.length === b.params.length &&
            !a.variadic === !b.variadic &&
            a.params.every((p, i) => b.params && sameType(p, b.params[i]))))
      );
    return a.k === "void" && b.k === "void";
  };
  const isArith = (t: CType) => t.k === "int" || t.k === "float";
  // 값으로 쓸 때의 타입: 배열은 첫 원소 포인터, 함수는 함수 포인터
  const decay = (t: CType): CType =>
    t.k === "array" ? ptr(t.of) : t.k === "func" ? ptr(t) : t;
  const isScalar = (t: CType) => {
    const d = decay(t);
    return isArith(d) || d.k === "ptr";
  };
  // 크기를 아는 객체 타입(변수·sizeof·포인터 산술에 필요하다)
  const complete = (t: CType): boolean =>
    t.k === "void" || t.k === "func"
      ? false
      : t.k === "struct"
        ? t.fields !== null
        : t.k === "array"
          ? t.n > 0 && complete(t.of)
          : true;
  // 두 포인터를 섞어 쓸 수 있는가: 같은 타입을 가리키거나 한쪽이 void *(함수 포인터는 빼고)
  const ptrCompat = (a: PtrType, b: PtrType) =>
    sameType(unqualified(a.to), unqualified(b.to)) ||
    (a.to.k === "void" && b.to.k !== "func") ||
    (b.to.k === "void" && a.to.k !== "func");
  // 널 포인터 상수: 값이 0 인 정수 상수식, 또는 그것을 (void *) 로 바꾼 것
  const isNullConst = (n: Node | null | undefined): boolean => {
    if (!n) return false;
    if (n.type === "parenthesized_expression")
      return isNullConst(n.namedChildren[0]);
    if (n.type === "cast_expression") {
      const t = typeOfDescriptor(field(n, "type"));
      if (t.k === "ptr" && t.to.k === "void")
        return isNullConst(field(n, "value"));
    }
    return isConst(n) && typeOnly(n).k === "int" && constEval(n) === 0;
  };
  // 대입·초기화·인자·return 에서 값을 그 타입으로 바꿀 수 있는가(C17 6.5.16.1)
  const convert = (
    n: Node,
    to: CType,
    v: Val,
    src: Node | null | undefined,
    what: string,
  ) => {
    if (!strict()) return;
    const from = decay(v.t);
    const bad = (why = ""): never =>
      fail(
        n,
        `${what}: ${typeName(from)} 값을 ${typeName(to)} 에 넣을 수 없습니다${why}`,
      );
    if (from.k === "void") fail(n, `${what}: void 값은 쓸 수 없습니다`);
    if (isArith(to) && isArith(from)) return;
    if (to.k === "int" && to.name === T.bool.name && from.k === "ptr") return;
    if (to.k === "struct") {
      if (from.k !== "struct" || unqualified(from) !== unqualified(to)) bad();
      return;
    }
    if (to.k === "ptr") {
      if (from.k === "ptr") {
        if (!ptrCompat(to, from)) bad("(가리키는 타입이 다릅니다)");
        const lost = (from.to.q ?? 0) & ~(to.to.q ?? 0);
        if (lost) bad(`(가리키는 쪽의 ${qualNames(lost)} 가 사라집니다)`);
        return;
      }
      if (isNullConst(src)) return;
    }
    bad();
  };
  // 연산자마다 받을 수 있는 피연산자(C17 6.5.5~6.5.9)
  const operands = (
    n: Node,
    op: string,
    a: CType,
    b: CType,
    an?: Node | null,
    bn?: Node | null,
  ) => {
    const A = decay(a);
    const B = decay(b);
    const bad = (): never =>
      fail(n, `${typeName(A)} 와 ${typeName(B)} 에는 ${op} 를 쓸 수 없습니다`);
    const obj = (t: CType): t is PtrType => t.k === "ptr" && complete(t.to);
    switch (op) {
      case "*":
      case "/":
        if (!isArith(A) || !isArith(B)) bad();
        return;
      case "%":
      case "<<":
      case ">>":
      case "&":
      case "|":
      case "^":
        if (A.k !== "int" || B.k !== "int") bad();
        return;
      case "+":
        if (
          (isArith(A) && isArith(B)) ||
          (obj(A) && B.k === "int") ||
          (A.k === "int" && obj(B))
        )
          return;
        return bad();
      case "-":
        if (
          (isArith(A) && isArith(B)) ||
          (obj(A) && B.k === "int") ||
          (obj(A) && obj(B) && sameType(unqualified(A.to), unqualified(B.to)))
        )
          return;
        return bad();
      case "<":
      case ">":
      case "<=":
      case ">=":
        if (
          (isArith(A) && isArith(B)) ||
          (A.k === "ptr" &&
            B.k === "ptr" &&
            A.to.k !== "func" &&
            sameType(unqualified(A.to), unqualified(B.to)))
        )
          return;
        return bad();
      case "==":
      case "!=":
        if (
          (isArith(A) && isArith(B)) ||
          (A.k === "ptr" && B.k === "ptr" && ptrCompat(A, B)) ||
          (A.k === "ptr" && isNullConst(bn)) ||
          (B.k === "ptr" && isNullConst(an))
        )
          return;
        return bad();
    }
  };
  const isStaticAssert = (n: Node) =>
    ((name) =>
      name === "_Static_assert" || (name === "static_assert" && known(name)))(
      n.childForFieldName("function")?.text ?? "",
    );
  // 컴파일할 때 따지는 조건. 거짓이면 실행하지 않고 멈춘다
  const staticAssert = (n: Node) => {
    const [cond, msg] = stmts(field(n, "arguments"));
    if (!constEval(cond ?? fail(n, "조건이 없습니다")))
      fail(
        n,
        `static_assert 실패${msg ? `: ${String.fromCharCode(...literal(msg).units)}` : ""}`,
      );
  };

  // --- 함수 부르기 ---
  function call(n: Node): Val {
    if (isStaticAssert(n)) {
      staticAssert(n);
      return { t: T.void, v: 0 };
    }
    const fnNode = field(n, "function");
    const name = fnNode.text;
    const argNodes = field(n, "arguments").namedChildren;
    const args = argNodes.map((a) => rvalue(n, evalExpr(a)));
    // 이름으로 부르면 표준 함수일 수 있다. 같은 이름의 변수나 직접 만든 함수가 있으면 그쪽
    const builtin =
      fnNode.type === "identifier" &&
      !lookupMaybe(name) &&
      !funcs.has(name) &&
      !protos.has(name);
    if (dry) {
      if (
        builtin &&
        ((!(name in BUILTIN_RET) && !LIBRARY_ADDR.has(name)) || !known(name))
      )
        fail(n, `선언하지 않은 함수 ${name}${needs(name)}`);
      const t = builtin ? libType(name) : rvalue(n, evalExpr(fnNode)).t;
      const ft = t.k === "ptr" ? t.to : t;
      if (ft.k !== "func") return fail(n, `함수가 아닌 ${name}을 불렀습니다`);
      if (ft.params) {
        const want = ft.params.length;
        if (ft.variadic ? args.length < want : args.length !== want)
          fail(
            n,
            `${name}에 인자를 ${want}개${ft.variadic ? " 이상" : ""} 넘겨야 하는데 ${args.length}개를 넘겼습니다`,
          );
        ft.params.forEach((p, i) => {
          convert(argNodes[i], p, args[i], argNodes[i], `${i + 1}번째 인자`);
        });
      }
      for (const [i, a] of args.entries())
        if (a.t.k === "void")
          fail(argNodes[i], "void 값은 인자로 넘길 수 없습니다");
      return { t: ft.ret, v: 0 };
    }
    if (!builtin) {
      const fv = rvalue(n, evalExpr(fnNode));
      const isFn =
        fv.t.k === "func" || (fv.t.k === "ptr" && fv.t.to.k === "func");
      const lib = isFn ? LIBRARY[num(fv.v)] : undefined;
      if (lib) return callLibrary(n, lib, args);
      const f = isFn ? byAddr.get(num(fv.v)) : undefined;
      if (!f)
        return fail(
          n,
          fv.v === 0 && isFn
            ? protos.has(name) && !lookupMaybe(name)
              ? `함수 ${name} 의 정의가 없습니다`
              : "NULL 함수 포인터를 불렀습니다"
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
    return callLibrary(n, name, args);
  }
  function callLibrary(n: Node, name: string, args: Val[]): Val {
    const arg = (i: number) =>
      args[i] ?? fail(n, `${name}에 인자가 모자랍니다`);
    const argN = (i: number) => num(arg(i).v);
    const lib = libCall(n, name, args);
    if (lib) return lib;
    switch (name) {
      case "_Static_assert":
      case "static_assert":
        return { t: T.void, v: 0 };
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
          const b = [blockStart(old)].find((h) => h && !h.freed);
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
        const b = blockStart(a);
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
        put(n, argN(0), s);
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
  // 파일은 메모리 안에만 있다(실행마다 비어서 시작한다). fopen 이 주는 FILE * 는 stdin 등처럼 가짜 주소
  const files = new Map<string, string>();
  type Open = {
    name: string;
    pos: number;
    read: boolean;
    write: boolean;
    append: boolean;
    eof: boolean;
    // ungetc 로 되돌린 글자
    back: number[];
  };
  const opened = new Map<number, Open>();
  const handle = (n: Node, f: number) =>
    opened.get(f) ??
    fail(
      n,
      f === 0
        ? "NULL 인 FILE * 를 썼습니다. fopen 이 실패했는지 봅니다"
        : "열려 있지 않은 FILE * 입니다",
    );
  const put = (n: Node, f: number, s: string) => {
    if (f === STREAMS.stdout || f === STREAMS.stderr) {
      out += s;
      return;
    }
    const o = handle(n, f);
    if (!o.write) fail(n, "읽기로 연 파일에 썼습니다");
    const text = files.get(o.name) ?? "";
    if (o.append) o.pos = text.length;
    files.set(
      o.name,
      text.slice(0, o.pos).padEnd(o.pos, "\0") +
        s +
        text.slice(o.pos + s.length),
    );
    o.pos += s.length;
  };
  const getc = (n: Node, f: number) => {
    if (f === STREAMS.stdin) return -1;
    const o = handle(n, f);
    if (!o.read) fail(n, "쓰기로 연 파일에서 읽었습니다");
    const b = o.back.pop();
    if (b !== undefined) return b;
    const text = files.get(o.name) ?? "";
    if (o.pos >= text.length) {
      o.eof = true;
      return -1;
    }
    return text.charCodeAt(o.pos++);
  };
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
    ldexp: (x, y) => x * 2 ** y,
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
        return { t: T.double, v: fma(an(0), an(1), an(2)) };
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
        put(n, an(1), readStr(n, an(0)));
        return { t: T.int, v: 0 };
      case "fputc":
      case "putc":
        put(n, an(1), String.fromCharCode(an(0) & 0xff));
        return { t: T.int, v: an(0) & 0xff };
      case "fopen": {
        const name = readStr(n, an(0));
        const mode = readStr(n, an(1));
        if (!/^[rwa]b?\+?b?$/.test(mode))
          fail(
            n,
            `fopen 의 모드 "${mode}" 는 r·w·a 에 + 나 b 를 붙인 것만 됩니다`,
          );
        if (mode[0] === "r" && !files.has(name)) return { t: ptr(FILE), v: 0 };
        if (mode[0] === "w" || !files.has(name)) files.set(name, "");
        let addr = FILE_BASE;
        while (opened.has(addr)) addr += 8;
        if (addr >= FILE_END) return { t: ptr(FILE), v: 0 };
        opened.set(addr, {
          name,
          pos: 0,
          read: mode[0] === "r" || mode.includes("+"),
          write: mode[0] !== "r" || mode.includes("+"),
          append: mode[0] === "a",
          eof: false,
          back: [],
        });
        return { t: ptr(FILE), v: addr };
      }
      case "fclose":
        handle(n, an(0));
        opened.delete(an(0));
        return { t: T.int, v: 0 };
      case "fgetc":
      case "getc":
        return { t: T.int, v: getc(n, an(0)) };
      case "ungetc": {
        if (an(0) === -1) return { t: T.int, v: -1 };
        if (an(1) !== STREAMS.stdin) {
          const f = handle(n, an(1));
          f.back.push(an(0) & 0xff);
          f.eof = false;
        }
        return { t: T.int, v: an(0) & 0xff };
      }
      case "fgets": {
        let s = "";
        while (s.length < an(1) - 1) {
          const c = getc(n, an(2));
          if (c < 0) break;
          s += String.fromCharCode(c);
          if (c === 10) break;
        }
        if (!s) return { t: ptr(T.char), v: 0 };
        writeStr(n, an(0), s);
        return { t: ptr(T.char), v: an(0) };
      }
      case "fread": {
        const want = an(1) * an(2);
        let got = 0;
        for (; got < want; got++) {
          const c = getc(n, an(3));
          if (c < 0) break;
          store(n, an(0) + got, T.uchar, c);
        }
        return { t: T.ulong, v: an(1) ? Math.floor(got / an(1)) : 0 };
      }
      case "fwrite": {
        let s = "";
        for (let i = 0; i < an(1) * an(2); i++)
          s += String.fromCharCode(num(load(n, an(0) + i, T.uchar)));
        put(n, an(3), s);
        return { t: T.ulong, v: an(2) };
      }
      case "feof":
        return {
          t: T.int,
          v: an(0) === STREAMS.stdin || handle(n, an(0)).eof ? 1 : 0,
        };
      case "ferror":
        return { t: T.int, v: 0 };
      case "rewind":
      case "fseek": {
        const f = handle(n, an(0));
        const size = (files.get(f.name) ?? "").length;
        const to = name === "rewind" ? 0 : an(1) + [0, f.pos, size][an(2)];
        if (name === "fseek" && (an(2) < 0 || an(2) > 2 || to < 0))
          return { t: T.int, v: -1 };
        f.pos = to;
        f.eof = false;
        f.back = [];
        return { t: T.int, v: 0 };
      }
      case "ftell":
        return { t: T.long, v: handle(n, an(0)).pos };
      case "remove":
        return { t: T.int, v: files.delete(readStr(n, an(0))) ? 0 : -1 };
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
      /%([-0 +#]*)(\*|\d*)(?:\.(\*|\d*))?(hh|h|ll|l|z|j|t|L)?([diouxXcspfFeEgGaA%])/g,
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
            s = readStr(n, num(a.v), p ?? undefined);
            numeric = false;
            break;
          case "p":
            s = hex(num(a.v));
            numeric = false;
            break;
          default:
            s = formatFloat(
              num(a.v),
              c,
              p ?? (c === "a" || c === "A" ? -1 : 6),
              flags,
            );
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

  // 배열·함수 매개변수는 포인터다
  const paramType = (t: CType) =>
    t.k === "array" ? ptr(t.of) : t.k === "func" ? ptr(t) : t;
  function invoke(f: Func, args: Val[], at: Node): Val {
    if (fast && jitSig(f)) {
      const fn = jitFns[jitOf(f)];
      const xs = args.map((a, i) => wrap(f.params[i].type, a.v));
      return { t: f.ret, v: fn(...xs) };
    }
    return invokeSlow(f, args, at);
  }
  function invokeSlow(f: Func, args: Val[], at: Node): Val {
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
    const fr = {
      name: f.name,
      scopes: [new Map<string, Binding>()],
      va,
      slots: new Map<Node, number>(),
    };
    frames.push(fr);
    f.params.forEach((p, i) => {
      const type = p.type;
      const addr = alloca(at, type);
      fr.scopes[0].set(p.name, { addr, type });
      assign(at, { t: type, addr, lv: true }, args[i]);
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
        if (t.of.k === "int" && t.of.name === T.char.name) {
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
          : `{${(t.fields ?? [])
              .filter((f) => f.name)
              .map(
                (f) => `${f.name}: ${show(f.type, addr + f.offset, depth + 1)}`,
              )
              .join(", ")}}`;
      if (t.k === "ptr") {
        const v = Number(mem.getBigUint64(addr, true));
        return v === 0 ? "NULL" : hex(v);
      }
      if (t.k === "float")
        return formatFloat(num(load(null, addr, t)), "g", 6, "");
      if (t.k !== "int") return "?";
      const v = load(null, addr, t);
      if (t.name === T.char.name && v >= 32 && v < 127)
        return `${v} '${String.fromCharCode(num(v))}'`;
      return String(v);
    } catch {
      return "?";
    }
  };
  // 값 글은 그 자리의 바이트가 그대로면 지난번 것을 다시 쓴다(단계마다 모든 변수·블록을 다시 읽지 않게).
  // show 가 읽는 바이트: 배열은 앞 20개(char 배열은 전부), 나머지는 크기만큼
  const shown = new Map<number, { name: string; bytes: Uint8Array; value: string }>();
  const span = (t: CType) =>
    t.k === "array" && !(t.of.k === "int" && t.of.name === T.char.name)
      ? Math.min(t.size, 20 * t.of.size)
      : t.size;
  const showAt = (t: CType, addr: number, name: string) => {
    const n = span(t);
    if (addr <= 0 || addr + n > MEM_SIZE) return show(t, addr);
    const now = new Uint8Array(mem.buffer, addr, n);
    const c = shown.get(addr);
    if (c && c.name === name && c.bytes.length === n) {
      let same = true;
      for (let i = 0; i < n; i++)
        if (c.bytes[i] !== now[i]) {
          same = false;
          break;
        }
      if (same) return c.value;
    }
    const value = show(t, addr);
    shown.set(addr, { name, bytes: now.slice(), value });
    return value;
  };
  const block = (h: Block): CBlock => {
    let t = h.ctype;
    // malloc(n * sizeof(int)) 처럼 원소 여러 개면 배열로 읽는다
    if (t && t.size > 0 && h.size > t.size && h.size % t.size === 0)
      t = arr(t, h.size / t.size);
    const type = t ? typeName(t) : null;
    return {
      addr: h.addr,
      size: h.size,
      freed: h.freed,
      type,
      value: t && type && !h.freed ? showAt(t, h.addr, type) : null,
    };
  };
  const vars = (scopes: Map<string, Binding>[]) => {
    const list: CVar[] = [];
    for (const s of scopes)
      for (const [name, { addr, type, kind }] of s)
        if (!kind) {
          const t = typeName(type);
          list.push({
            name,
            type: t,
            addr,
            size: type.size,
            value: showAt(type, addr, t),
          });
        }
    return list;
  };
  const sameVar = (a: CVar, b: CVar) =>
    a.name === b.name &&
    a.addr === b.addr &&
    a.value === b.value &&
    a.type === b.type;
  const sameFrame = (a: CFrame, b: CFrame | undefined) =>
    !!b &&
    a.func === b.func &&
    a.vars.length === b.vars.length &&
    a.vars.every((v, i) => sameVar(v, b.vars[i]));
  const sameBlock = (a: CBlock, b: CBlock | undefined) =>
    !!b &&
    a.freed === b.freed &&
    a.type === b.type &&
    a.value === b.value;
  // 지난 단계의 모습. 바뀐 것만 담으려고 견준다
  let last: Omit<CStep, "line" | "out"> = { frames: [], globals: [], heap: [] };
  let outSent = 0;
  const outText = new TextDecoder();
  const record = (n: Node) => {
    if (steps.length >= limit) {
      truncated = true;
      if (limit > 0) throw new Stop();
      return;
    }
    const now = {
      frames: frames.map((f) => ({ func: f.name, vars: vars(f.scopes) })),
      globals: vars([globals]),
      heap: heap.map(block),
    };
    const c: CChange = { line: lineOf(n) };
    if (now.frames.length !== last.frames.length || !steps.length)
      c.depth = now.frames.length;
    const fs = now.frames.flatMap((f, i): [number, CFrame][] =>
      sameFrame(f, last.frames[i]) ? [] : [[i, f]],
    );
    if (fs.length) c.frames = fs;
    const old = new Map(last.globals.map((v) => [`${v.name}@${v.addr}`, v]));
    const gs = now.globals.filter(
      (v) => !((o) => o && sameVar(v, o))(old.get(`${v.name}@${v.addr}`)),
    );
    if (gs.length) c.globals = gs;
    const hs = now.heap.filter((b, i) => !sameBlock(b, last.heap[i]));
    if (hs.length) c.heap = hs;
    if (out.length > outSent) {
      const bytes = Uint8Array.from(out.slice(outSent), (x) => x.charCodeAt(0));
      // 글자 하나의 UTF-8 바이트가 두 단계에 걸치면 다 모인 단계에 낸다
      const t = outText.decode(bytes, { stream: true });
      if (t) c.out = t;
      outSent = out.length;
    }
    steps.push(c);
    last = now;
  };

  // --- 문장 ---

  const storage = (n: Node, word: string) =>
    n.namedChildren.some(
      (c) => c.type === "storage_class_specifier" && c.text === word,
    );
  const isStatic = (n: Node) => storage(n, "static");
  const staticAlloc = (n: Node | null, type: CType) => {
    globalTop = Math.ceil(globalTop / alignOf(type)) * alignOf(type);
    const addr = globalTop;
    globalTop += type.size;
    if (globalTop > (started ? heapBase : HEAP_END - 0x100000))
      fail(n, "전역 변수가 너무 큽니다");
    return addr;
  };
  // withInit=false: goto 가 건너뛴 선언. 이름과 자리는 생기고 값은 초기화하지 않는다(static 은 원래 시작 전에 초기화된다)
  // 실행 중 선언자마다 읽은 이름과 타입(크기를 초깃값으로 정한 배열이면 그 크기까지). 다시 지날 때 그대로 쓴다
  const declared = new Map<Node, { name: string; type: CType; fn?: Node }>();
  function declareLocal(n: Node, withInit = true) {
    const b = specType(n);
    for (const d of n.childrenForFieldName("declarator")) {
      if (!d) continue;
      const memo = strict() ? undefined : declared.get(d);
      let { name, type, fn } = memo ?? declare(b, d);
      const scope = frame().scopes[frame().scopes.length - 1];
      const init =
        d.type === "init_declarator" ? d.childForFieldName("value") : null;
      const linked = !!fn || storage(n, "extern");
      if (strict()) {
        const prev = scope.get(name);
        if (prev && !(prev.linked && linked && sameType(prev.type, type)))
          fail(d, `${name} 을 이 블록에서 이미 선언했습니다`);
        if (fn && isStatic(n))
          fail(d, "블록 안의 함수 선언에는 static 을 붙일 수 없습니다");
        if (linked && init)
          fail(
            d,
            `${fn ? "함수" : "블록 안의 extern 선언"}에는 = 로 값을 줄 수 없습니다`,
          );
        if (linked) link(d, name, type, "extern", !!fn);
      }
      // 블록 안의 함수 원형과 extern 선언은 바깥(전역)의 것을 이 블록에서 다시 보이게 한다
      if (fn) {
        const addr = funcs.get(name)?.addr ?? LIBRARY_ADDR.get(name) ?? 0;
        scope.set(name, { addr, type, linked: true });
        continue;
      }
      if (linked) {
        const g = globals.get(name);
        // 검사 중엔 아직 읽지 않은 아래쪽 정의일 수 있다
        if (!g && !strict()) fail(d, `extern ${name} 의 정의가 없습니다`);
        scope.set(name, { ...(g ?? { addr: 0, type }), linked: true });
        continue;
      }
      if (!memo && type.k === "array" && !type.n && init)
        type = arr(type.of, initCount(init, type.of));
      if (!memo && !strict()) declared.set(d, { name, type });
      if (strict()) {
        if (type.k === "void") fail(d, "void 변수는 만들 수 없습니다");
        if (!complete(type))
          fail(d, `크기를 모르는 타입 ${typeName(type)} 의 변수입니다`);
      }
      // static 지역 변수는 전역 자리에 한 번만 잡고 처음 한 번만 초기화한다
      if (isStatic(n)) {
        if (strict() && init && !isConstInit(init))
          fail(init, "static 변수는 상수로만 초기화할 수 있습니다");
        if (dry) {
          if (init) initialize(d, 0, type, init);
          scope.set(name, { addr: 0, type, static: true });
          continue;
        }
        if (d.memo === undefined) {
          d.memo = staticAlloc(d, type);
          if (init) initialize(d, d.memo, type, init);
        }
        scope.set(name, { addr: d.memo, type, static: true });
        continue;
      }
      if (dry) {
        scope.set(name, { addr: 0, type, decl: n });
        if (init) initialize(d, 0, type, init);
        continue;
      }
      // 반복이나 goto 로 같은 선언을 다시 지나면 그 자리를 다시 쓴다
      const slot = frame().slots.get(d);
      const reuse = slot !== undefined;
      const addr = slot ?? alloca(n, type);
      frame().slots.set(d, addr);
      scope.set(name, { addr, type, decl: n });
      // 처음 잡은 자리는 초기화하지 않은 값으로 채운다
      if (!reuse)
        for (let i = 0; i < type.size; i++) mem.setUint8(addr + i, 0xcd);
      if (init && withInit) initialize(d, addr, type, init);
    }
  }

  // --- 링키지 ---
  // 여러 곳에서 선언한 같은 전역 이름(함수 원형과 정의, extern 과 정의)은 타입이 같아야 하고,
  // static(이 파일 안) 과 아닌 것(바깥과 공유)을 섞을 수 없다
  const linkage = new Map<
    string,
    { t: CType; internal: boolean; func: boolean }
  >();
  const link = (
    n: Node,
    name: string,
    t: CType,
    how: "static" | "extern" | "none",
    isFunc: boolean,
  ) => {
    const prev = linkage.get(name);
    if (prev) {
      if (prev.func !== isFunc)
        fail(
          n,
          `${name} 은 앞에서 ${prev.func ? "함수" : "변수"}로 선언했습니다`,
        );
      if (!sameType(prev.t, t))
        fail(
          n,
          `${name} 의 타입 ${typeName(t)} 이 앞의 선언(${typeName(prev.t)})과 다릅니다`,
        );
    }
    if (how === "static" && prev && !prev.internal)
      fail(n, `${name} 을 static 없이 선언한 뒤 static 으로 다시 선언했습니다`);
    if (how === "none" && !isFunc && prev?.internal)
      fail(n, `${name} 을 static 으로 선언한 뒤 static 없이 다시 선언했습니다`);
    const internal =
      how === "static" || (how !== "none" || isFunc ? !!prev?.internal : false);
    // 크기를 모르는 배열·원형 없는 함수보다 더 자세한 쪽을 남긴다
    const vague = (x: CType) =>
      (x.k === "array" && !x.n) || (x.k === "func" && !x.params);
    linkage.set(name, {
      t: prev && vague(t) ? prev.t : t,
      internal,
      func: isFunc,
    });
  };
  const protos = new Map<string, FuncType>();

  // static 저장 기간 변수의 초깃값은 상수여야 한다: 상수식, 또는 전역·static 의 주소(± 상수)
  const staticObject = (n: Node): boolean => {
    switch (n.type) {
      case "parenthesized_expression":
        return staticObject(n.namedChildren[0]);
      case "identifier": {
        const b = findScoped(n.text);
        if (b) return !!b.static || !!b.linked;
        return (
          globals.has(n.text) ||
          funcs.has(n.text) ||
          protos.has(n.text) ||
          LIBRARY_ADDR.has(n.text)
        );
      }
      case "string_literal":
      case "concatenated_string":
      case "compound_literal_expression":
        return true;
      case "field_expression":
        return field(n, "operator").text === "."
          ? staticObject(field(n, "argument"))
          : isAddress(field(n, "argument"));
      case "subscript_expression":
        return isAddress(field(n, "argument")) && isConst(field(n, "index"));
      case "pointer_expression":
        return (
          field(n, "operator").text === "*" && isAddress(field(n, "argument"))
        );
      default:
        return false;
    }
  };
  const isAddress = (n: Node): boolean => {
    switch (n.type) {
      case "parenthesized_expression":
        return isAddress(n.namedChildren[0]);
      case "string_literal":
      case "concatenated_string":
      case "compound_literal_expression":
        return true;
      case "identifier": {
        const t = typeOnly(n);
        return (t.k === "array" || t.k === "func") && staticObject(n);
      }
      case "pointer_expression":
        return (
          field(n, "operator").text === "&" &&
          staticObject(field(n, "argument"))
        );
      case "cast_expression": {
        const v = field(n, "value");
        return isAddress(v) || isConst(v);
      }
      case "binary_expression": {
        const op = field(n, "operator").text;
        const l = field(n, "left");
        const r = field(n, "right");
        return (
          (op === "+" || op === "-") &&
          ((isAddress(l) && isConst(r)) ||
            (op === "+" && isConst(l) && isAddress(r)))
        );
      }
      default:
        return false;
    }
  };
  const isConstInit = (v: Node): boolean =>
    v.type === "initializer_list"
      ? v.namedChildren.every((c) =>
          isConstInit(c.type === "initializer_pair" ? field(c, "value") : c),
        )
      : isConst(v) || isAddress(v);

  // --- goto ---
  // goto 는 Goto 를 던지고, 그 레이블을 안에 품은 가장 가까운 블록이 받아 레이블이 있는 문장부터 다시 실행한다.
  // 레이블이 안쪽 블록·if·반복 안에 있으면 그 안으로 들어가며(resume) 이어 간다
  const labelMemo = new WeakMap<Node, Set<string>>();
  // case 의 레이블 이름. 사람이 쓰는 레이블과 겹치지 않게 공백을 넣는다
  const caseKeys = new WeakMap<Node, string>();
  let caseCount = 0;
  const caseKey = (n: Node) => {
    let k = caseKeys.get(n);
    if (!k) {
      k = `case ${caseCount++}`;
      caseKeys.set(n, k);
    }
    return k;
  };
  // 이 switch 의 case 들(안쪽 switch 의 것은 빼고)
  const casesOf = (n: Node): Node[] =>
    n.type === "case_statement"
      ? [n, ...caseBody(n).flatMap(casesOf)]
      : n.type === "switch_statement"
        ? []
        : n.namedChildren.flatMap(casesOf);
  const caseBody = (n: Node) =>
    stmts(n).slice(n.childForFieldName("value") ? 1 : 0);
  const labelsOf = (n: Node): Set<string> => {
    let set = labelMemo.get(n);
    if (set) return set;
    set = new Set();
    if (n.type === "labeled_statement") set.add(field(n, "label").text);
    if (n.type === "case_statement") set.add(caseKey(n));
    for (const c of n.namedChildren) for (const l of labelsOf(c)) set.add(l);
    labelMemo.set(n, set);
    return set;
  };
  const labeled = (n: Node) =>
    n.namedChildren.at(-1) ?? fail(n, "레이블 뒤에 문장이 없습니다");
  const stmts = (n: Node) => n.namedChildren;

  // 건너뛴 문장 안에서 이 블록에 이름을 만드는 선언(case·레이블은 블록이 아니라 그 안의 선언도 이 블록 것)
  const TYPE_DECLS = new Set([
    "type_definition",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
  ]);
  const skipped = (k: Node): Node[] =>
    k.type === "declaration" || TYPE_DECLS.has(k.type)
      ? [k]
      : k.type === "case_statement"
        ? caseBody(k).flatMap(skipped)
        : k.type === "labeled_statement"
          ? skipped(labeled(k))
          : [];
  // 건너뛴 선언: 변수는 이름과 자리만, 타입 선언은 그대로
  const skipDecl = (k: Node) =>
    k.type === "declaration" ? declareLocal(k, false) : exec(k);
  const declaredHere = (scope: Map<string, Binding>, k: Node) =>
    [...scope.values()].some((b) => b.decl === k);
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
            // 레이블 뒤에서 선언한 이름은 레이블 자리에선 아직 없다(바깥 이름이 보인다)
            const scope = frame().scopes[frame().scopes.length - 1];
            for (const [name, b] of scope)
              if (b.decl && kids.indexOf(b.decl) >= at) scope.delete(name);
            // 건너뛴 선언도 그 블록 안에선 이름이 있다
            for (const k of kids.slice(0, at).flatMap(skipped))
              if (!declaredHere(scope, k)) skipDecl(k);
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
      case "case_statement": {
        // case 는 블록이 아니라 이어지는 문장들이다(이름 범위가 새로 생기지 않는다)
        const kids = caseBody(n);
        if (caseKey(n) === label) {
          for (const k of kids) exec(k);
          return;
        }
        const at = kids.findIndex((k) => labelsOf(k).has(label));
        for (const k of kids.slice(0, at).flatMap(skipped)) skipDecl(k);
        resume(kids[at], label);
        for (const k of kids.slice(at + 1)) exec(k);
        return;
      }
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
      // goto 로 switch 안에 들어가면 조건식은 계산하지 않는다
      case "switch_statement":
        try {
          resume(field(n, "body"), label);
        } catch (e) {
          if (!(e instanceof Break)) throw e;
        }
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
      return truth(rvalue(n, evalExpr(field(n, "condition"))).v);
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
          if (cond && !truth(rvalue(n, evalExpr(cond)).v)) break;
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
    if (dry || checking) {
      execSlow(n);
      return;
    }
    let c = n.code as Stmt | undefined;
    if (!c) {
      c = compileStmt(n);
      n.code = c;
    }
    c();
  }
  // 문장도 처음 실행할 때 함수로 바꿔 둔다. goto 레이블이 든 블록처럼 드문 것은 execSlow 가 한다
  type Stmt = () => void;
  const BREAK = new Break();
  const CONTINUE = new Continue();
  // 조건식: 참이면 true
  const condCode = (n: Node): (() => boolean) => {
    const N = numCode(n);
    if (N) return () => N() !== 0;
    const C = codeOf(n);
    return () => truth(rvalue(n, C()).v);
  };
  const hasLabel = (n: Node): boolean =>
    n.type === "labeled_statement" || n.namedChildren.some(hasLabel);
  // 선언의 초깃값을 그 자리에 넣는 함수
  const initCode = (
    d: Node,
    type: CType,
    init: Node,
  ): ((addr: number) => void) => {
    const N =
      numeric(type) && init.type !== "initializer_list" ? numCode(init) : null;
    if (!N) return (addr) => initialize(d, addr, type, init);
    const st = storer(type);
    const heapPtr = type.k === "ptr" && type.to.k !== "void" ? type.to : null;
    return (addr) => {
      const v = wrap(type, N()) as number;
      if (heapPtr && v >= heapBase) {
        const b = blockStart(v);
        if (b && !b.ctype) b.ctype = heapPtr;
      }
      st(d, addr, v);
    };
  };
  const compileStmt = (n: Node): Stmt => {
    const slow: Stmt = () => execSlow(n);
    switch (n.type) {
      case "expression_statement": {
        const e = n.namedChildren[0];
        if (!e)
          return () => {
            tick(n);
            record(n);
          };
        const E = numCode(e) ?? codeOf(e);
        return () => {
          tick(n);
          record(n);
          E();
        };
      }
      case "compound_statement": {
        if (hasLabel(n)) return slow;
        const kids = stmts(n);
        // 이 블록에 이름을 만드는 것이 없으면 이름 범위도 만들 필요가 없다
        const scoped = kids.some((k) => skipped(k).length > 0);
        if (!scoped)
          return () => {
            tick(n);
            for (const k of kids) exec(k);
          };
        return () => {
          tick(n);
          const scopes = frame().scopes;
          scopes.push(new Map());
          try {
            for (const k of kids) exec(k);
          } finally {
            scopes.pop();
          }
        };
      }
      case "declaration": {
        if (isStatic(n) || storage(n, "extern")) return slow;
        const b = specType(n);
        const items: {
          d: Node;
          name: string;
          type: CType;
          init: Node | null;
          code?: (addr: number) => void;
        }[] = [];
        for (const d of n.childrenForFieldName("declarator")) {
          if (!d) continue;
          const x = declare(b, d);
          if (x.fn) return slow;
          const init =
            d.type === "init_declarator" ? d.childForFieldName("value") : null;
          const type =
            x.type.k === "array" && !x.type.n && init
              ? arr(x.type.of, initCount(init, x.type.of))
              : x.type;
          items.push({ d, name: x.name, type, init });
        }
        return () => {
          tick(n);
          record(n);
          const f = frame();
          const scope = f.scopes[f.scopes.length - 1];
          for (const it of items) {
            let addr = f.slots.get(it.d);
            // 반복이나 goto 로 같은 선언을 다시 지나면 그 자리를 다시 쓴다. 처음 잡은 자리는 초기화하지 않은 값으로
            if (addr === undefined) {
              addr = alloca(n, it.type);
              f.slots.set(it.d, addr);
              for (let i = 0; i < it.type.size; i++)
                mem.setUint8(addr + i, 0xcd);
            }
            scope.set(it.name, { addr, type: it.type, decl: n });
            if (it.init) {
              it.code ??= initCode(it.d, it.type, it.init);
              it.code(addr);
            }
          }
        };
      }
      case "return_statement": {
        const e = n.namedChildren[0];
        const E = e ? codeOf(e) : null;
        return () => {
          tick(n);
          record(n);
          throw new Return(E ? rvalue(n, E()) : null);
        };
      }
      case "if_statement": {
        const C = condCode(field(n, "condition"));
        const yes = field(n, "consequence");
        const alt = n.childForFieldName("alternative");
        const no = alt
          ? alt.type === "else_clause"
            ? (alt.namedChildren[0] ?? alt)
            : alt
          : null;
        return () => {
          tick(n);
          record(n);
          if (C()) exec(yes);
          else if (no) exec(no);
        };
      }
      case "while_statement": {
        const C = condCode(field(n, "condition"));
        const b = field(n, "body");
        return () => {
          tick(n);
          for (;;) {
            record(n);
            if (!C()) return;
            try {
              exec(b);
            } catch (e) {
              if (e instanceof Break) return;
              if (!(e instanceof Continue)) throw e;
            }
          }
        };
      }
      case "do_statement": {
        const cn = field(n, "condition");
        let C: (() => boolean) | undefined;
        const b = field(n, "body");
        return () => {
          tick(n);
          for (;;) {
            try {
              exec(b);
            } catch (e) {
              if (e instanceof Break) return;
              if (!(e instanceof Continue)) throw e;
            }
            record(n);
            C ??= condCode(cn);
            if (!C()) return;
          }
        };
      }
      case "for_statement": {
        const init = n.childForFieldName("initializer");
        const cn = n.childForFieldName("condition");
        const un = n.childForFieldName("update");
        const b = field(n, "body");
        // 조건과 갱신식은 첫 칸의 선언을 지난 뒤에 함수로 바꾼다
        let C: (() => boolean) | undefined;
        let U: (() => unknown) | undefined;
        return () => {
          tick(n);
          const scopes = frame().scopes;
          scopes.push(new Map());
          try {
            if (init) {
              record(n);
              if (init.type === "declaration") declareLocal(init);
              else evalExpr(init);
            }
            if (cn) C ??= condCode(cn);
            if (un) U ??= numCode(un) ?? codeOf(un);
            for (;;) {
              record(n);
              if (C && !C()) break;
              try {
                exec(b);
              } catch (e) {
                if (e instanceof Break) break;
                if (!(e instanceof Continue)) throw e;
              }
              if (U) U();
            }
          } finally {
            scopes.pop();
          }
        };
      }
      case "break_statement":
        return () => {
          tick(n);
          throw BREAK;
        };
      case "continue_statement":
        return () => {
          tick(n);
          throw CONTINUE;
        };
      default:
        return slow;
    }
  };

  function execSlow(n: Node): void {
    tick(n);
    switch (n.type) {
      case "compound_statement":
        runBlock(n, null);
        return;
      case "declaration":
        record(n);
        declareLocal(n);
        return;
      case "struct_specifier":
      case "union_specifier": {
        // struct s; 만 쓰면 바깥의 같은 태그를 가리고 이 블록에 새 태그를 만든다
        const name = n.childForFieldName("name")?.text;
        const union = n.type === "union_specifier";
        const key = `${union ? "union" : "struct"} ${name}`;
        if (
          name &&
          !n.childForFieldName("body") &&
          !frame().scopes.at(-1)?.has(key)
        ) {
          const other = `${union ? "struct" : "union"} ${name}`;
          if (strict() && frame().scopes.at(-1)?.has(other))
            fail(
              n,
              `${name} 은 ${union ? "struct" : "union"} 로 선언한 태그입니다`,
            );
          newTag(key, name, union);
        } else typeOf(n);
        return;
      }
      case "type_definition":
      case "enum_specifier":
        topLevel(n);
        return;
      case "expression_statement": {
        record(n);
        if (n.namedChildren[0]) evalExpr(n.namedChildren[0]);
        return;
      }
      case "return_statement": {
        record(n);
        const e = n.namedChildren[0];
        throw new Return(e ? rvalue(n, evalExpr(e)) : null);
      }
      case "if_statement": {
        record(n);
        const c = rvalue(n, evalExpr(field(n, "condition")));
        if (truth(c.v)) exec(field(n, "consequence"));
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
      // case 는 이 switch 의 레이블이다. 맞는 case(없으면 default)로 goto 하듯 몸통 안으로 들어간다.
      // case 값은 조건식의 (승격한) 타입으로 바꿔 비교한다
      case "switch_statement": {
        record(n);
        const c = rvalue(n, evalExpr(field(n, "condition")));
        const t = c.t.k === "int" ? promote(c.t, c.t) : c.t;
        const body = field(n, "body");
        const cases = casesOf(body);
        const hit =
          cases.find((k) => {
            const val = k.childForFieldName("value");
            return val && wrap(t, rvalue(val, evalExpr(val)).v) === c.v;
          }) ?? cases.find((k) => !k.childForFieldName("value"));
        if (!hit) return;
        try {
          resume(body, caseKey(hit));
        } catch (e) {
          if (!(e instanceof Break)) throw e;
        }
        return;
      }
      case "case_statement":
        for (const k of caseBody(n)) exec(k);
        return;
      case "break_statement":
        throw new Break();
      case "continue_statement":
        throw new Continue();
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
      case "struct_specifier":
      case "union_specifier":
      case "enum_specifier":
        typeOf(top);
        return;
      case "type_definition": {
        const b = specType(top);
        for (const d of top.childrenForFieldName("declarator")) {
          if (!d) continue;
          const { name, type } = declare(b, d);
          const scope = frame()?.scopes.at(-1);
          if (strict()) {
            // 같은 타입으로 다시 typedef 하는 것은 된다(C11)
            const prev = scope ? scope.get(name) : undefined;
            const prevType = scope ? prev?.type : typedefs.get(name);
            if (
              (prev && prev.kind !== "typedef") ||
              (!scope && (globals.has(name) || linkage.has(name)))
            )
              fail(d, `${name} 을 이미 다른 것으로 선언했습니다`);
            if (prevType && !sameType(prevType, type))
              fail(d, `typedef ${name} 을 다른 타입으로 다시 정의했습니다`);
          }
          if (scope) scope.set(name, { addr: 0, type, kind: "typedef" });
          else typedefs.set(name, type);
        }
        return;
      }
      case "function_definition": {
        const decl = declare(specType(top), field(top, "declarator"));
        if (!decl.fn || decl.type.k !== "func")
          return fail(top, "함수 정의의 선언을 읽지 못했습니다");
        const { name } = decl;
        const ret = decl.type.ret;
        if (strict()) {
          if (funcs.has(name)) fail(top, `함수 ${name} 을 두 번 정의했습니다`);
          if (ret.k !== "void" && !complete(ret))
            fail(top, `돌려줄 타입 ${typeName(ret)} 의 크기를 모릅니다`);
          link(top, name, decl.type, isStatic(top) ? "static" : "none", true);
        }
        const params: Func["params"] = [];
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
            return fail(p, "매개변수 이름이 없습니다");
          }
          const pdecl = declare(specType(p), pd);
          const type = paramType(pdecl.type);
          if (strict() && !complete(type))
            fail(
              p,
              `매개변수 ${pdecl.name} 의 타입 ${typeName(type)} 은 크기를 모릅니다`,
            );
          params.push({ name: pdecl.name, type });
        }
        const known = funcs.get(name);
        const f = {
          name,
          addr: known?.addr ?? 0x100 + funcs.size * 16,
          type: decl.type,
          ret,
          params,
          variadic,
          body: field(top, "body"),
        };
        funcs.set(name, f);
        byAddr.set(f.addr, f);
        if (checking) checkFunction(f);
        return;
      }
      case "declaration": {
        const b = specType(top);
        const how = isStatic(top)
          ? "static"
          : storage(top, "extern")
            ? "extern"
            : "none";
        for (const d of top.childrenForFieldName("declarator")) {
          if (!d) continue;
          let { name, type, fn } = declare(b, d);
          const init =
            d.type === "init_declarator" ? d.childForFieldName("value") : null;
          if (fn) {
            // 함수 원형
            if (strict()) {
              if (init) fail(d, "함수에는 = 로 값을 줄 수 없습니다");
              if (enums.has(name))
                fail(d, `${name} 을 이미 enum 상수로 선언했습니다`);
              link(d, name, type, how, true);
              const t = linkage.get(name)?.t;
              if (t?.k === "func") protos.set(name, t);
            }
            continue;
          }
          if (type.k === "array" && !type.n && init)
            type = arr(type.of, initCount(init, type.of));
          if (strict()) {
            if (enums.has(name) || typedefs.has(name))
              fail(d, `${name} 을 이미 다른 것으로 선언했습니다`);
            if (type.k === "void") fail(d, "void 변수는 만들 수 없습니다");
            link(d, name, type, how, false);
            if (init) {
              if (initialized.has(name))
                fail(d, `${name} 을 두 번 정의했습니다`);
              initialized.add(name);
              if (!complete(type))
                fail(d, `크기를 모르는 타입 ${typeName(type)} 의 변수입니다`);
              if (!isConstInit(init))
                fail(init, "전역 변수는 상수로만 초기화할 수 있습니다");
            } else if (how !== "extern") tentative.push(d);
          }
          // 같은 전역을 여러 번 선언할 수 있다(extern int a; int a = 1;). 크기가 정해지는 선언에서 자리를 잡는다
          // 정의가 없거나, 아직 크기를 모르는 struct 의 extern 선언은 자리를 정의에서 잡는다
          if (
            !defined.has(name) ||
            (storage(top, "extern") && !init && !type.size)
          ) {
            if (!globals.has(name))
              globals.set(name, { addr: 0, type, missing: true });
            continue;
          }
          const seen = globals.get(name);
          const known = seen?.missing ? undefined : seen;
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
      case "expression_statement": {
        if (top.text.trim() === ";") return;
        const e = top.namedChildren[0];
        if (e?.type === "call_expression" && isStaticAssert(e)) {
          staticAssert(e);
          return;
        }
        return fail(top, "함수 밖에 문장을 쓸 수 없습니다");
      }
      default:
        return fail(top, `지원하지 않는 맨 위 선언 ${top.type}`);
    }
  }

  // 초기화한 전역(두 번 정의하면 오류), 값 없이 정의한 전역(파일 끝에서 크기를 알아야 한다)
  const initialized = new Set<string>();
  const tentative: Node[] = [];

  // --- 실행 전 검사 ---
  // 함수 몸통을 실행하지 않고 모든 갈래를 한 번씩 훑으며 타입만 계산한다(dry). 함수 정의를 읽은 바로 그 자리에서
  // 훑으니 아래쪽에서 선언한 이름은 아직 보이지 않는다(C 처럼)
  type Ctx = {
    name: string;
    ret: CType;
    loops: number;
    breaks: number;
    switches: { values: Set<string>; dflt: boolean; t: CType }[];
    labels: Set<string>;
    gotos: Node[];
  };
  const scalarCond = (e: Node) => {
    const t = rvalue(e, evalExpr(e)).t;
    if (!isScalar(t))
      fail(e, `조건에는 수나 포인터가 와야 하는데 ${typeName(t)} 가 왔습니다`);
  };
  function checkStmt(n: Node, c: Ctx): void {
    tick(n);
    switch (n.type) {
      case "compound_statement":
        frame().scopes.push(new Map());
        try {
          for (const k of stmts(n)) checkStmt(k, c);
        } finally {
          frame().scopes.pop();
        }
        return;
      case "declaration":
        declareLocal(n);
        return;
      case "struct_specifier":
      case "union_specifier":
      case "type_definition":
      case "enum_specifier":
        exec(n);
        return;
      case "expression_statement":
        if (n.namedChildren[0]) evalExpr(n.namedChildren[0]);
        return;
      case "return_statement": {
        const e = n.namedChildren[0];
        if (c.ret.k === "void") {
          if (e) fail(n, `void 함수 ${c.name} 는 값을 돌려줄 수 없습니다`);
          return;
        }
        if (!e) {
          fail(n, `${c.name} 는 ${typeName(c.ret)} 값을 돌려줘야 합니다`);
          return;
        }
        convert(n, c.ret, rvalue(n, evalExpr(e)), e, "return");
        return;
      }
      case "if_statement": {
        scalarCond(field(n, "condition"));
        checkStmt(field(n, "consequence"), c);
        const alt = n.childForFieldName("alternative");
        if (alt) checkStmt(alt.namedChildren[0] ?? alt, c);
        return;
      }
      case "while_statement":
      case "do_statement":
        scalarCond(field(n, "condition"));
        loopBody(field(n, "body"), c);
        return;
      case "for_statement": {
        frame().scopes.push(new Map());
        try {
          const init = n.childForFieldName("initializer");
          if (init?.type === "declaration") {
            const bad = init.namedChildren.find(
              (k) =>
                k.type === "storage_class_specifier" &&
                k.text !== "auto" &&
                k.text !== "register",
            );
            if (bad)
              fail(init, `for 의 첫 칸에는 ${bad.text} 변수를 둘 수 없습니다`);
            if (
              init
                .childrenForFieldName("declarator")
                .some((d) => declare(specType(init), d).fn)
            )
              fail(init, "for 의 첫 칸에는 함수를 선언할 수 없습니다");
            declareLocal(init);
          } else if (init?.type === "type_definition")
            fail(init, "for 의 첫 칸에는 typedef 를 둘 수 없습니다");
          else if (init) evalExpr(init);
          const cond = n.childForFieldName("condition");
          if (cond) scalarCond(cond);
          const upd = n.childForFieldName("update");
          if (upd) evalExpr(upd);
          loopBody(field(n, "body"), c);
        } finally {
          frame().scopes.pop();
        }
        return;
      }
      case "switch_statement": {
        const cond = field(n, "condition");
        const t = rvalue(cond, evalExpr(cond)).t;
        if (t.k !== "int")
          fail(
            cond,
            `switch 에는 정수가 와야 하는데 ${typeName(decay(t))} 가 왔습니다`,
          );
        c.switches.push({ values: new Set(), dflt: false, t: promote(t, t) });
        c.breaks++;
        try {
          checkStmt(field(n, "body"), c);
        } finally {
          c.switches.pop();
          c.breaks--;
        }
        return;
      }
      case "case_statement": {
        const sw = c.switches.at(-1);
        const v = n.childForFieldName("value");
        if (!sw) {
          fail(n, `${v ? "case" : "default"} 는 switch 안에서만 씁니다`);
          return;
        }
        if (v) {
          if (!isConst(v) || typeOnly(v).k !== "int")
            fail(v, "case 에는 정수 상수가 와야 합니다");
          const key = String(wrap(sw.t, rvalue(v, evalExpr(v)).v));
          if (sw.values.has(key)) fail(v, `case ${key} 가 겹칩니다`);
          sw.values.add(key);
        } else {
          if (sw.dflt) fail(n, "default 가 둘입니다");
          sw.dflt = true;
        }
        for (const k of caseBody(n)) checkStmt(k, c);
        return;
      }
      case "break_statement":
        if (!c.breaks) fail(n, "break 는 반복이나 switch 안에서만 씁니다");
        return;
      case "continue_statement":
        if (!c.loops) fail(n, "continue 는 반복 안에서만 씁니다");
        return;
      case "labeled_statement": {
        const l = field(n, "label").text;
        if (c.labels.has(l)) fail(n, `레이블 ${l} 이 겹칩니다`);
        c.labels.add(l);
        checkStmt(labeled(n), c);
        return;
      }
      case "goto_statement":
        c.gotos.push(n);
        return;
      case ";":
        return;
      default:
        fail(n, `지원하지 않는 문장 ${n.type}`);
    }
  }
  const loopBody = (b: Node, c: Ctx) => {
    c.loops++;
    c.breaks++;
    try {
      checkStmt(b, c);
    } finally {
      c.loops--;
      c.breaks--;
    }
  };
  // --- JS 로 옮겨 실행 ---
  // 빠른 실행(fast)에선 함수를 처음 부를 때 JS 소스로 옮겨 new Function 으로 만든다. 주소를 얻지 않는
  // 스칼라 지역 변수는 JS 변수에 두고, 나머지는 메모리에 둔다. 범위 밖·NULL·0으로 나누기·힙 검사는
  // 해석기와 같은 함수를 불러 같은 오류를 낸다. 옮길 수 없는 것(goto, 가변 인자 등)이 든 함수는 해석기로 돈다
  class NoJit {}
  const noJit = (): never => {
    throw new NoJit();
  };
  type JitFn = (...xs: Num[]) => Num;
  // 수 하나로 주고받는 타입(비트 필드가 아닌 정수, 실수, 포인터)
  const scalar = (t: CType) =>
    (t.k === "int" && t.bits === undefined) || t.k === "float" || t.k === "ptr";
  // 매개변수와 돌려주는 값이 다 수인 함수만 JS 함수끼리 바로 부른다
  const jitSig = (f: Func) =>
    !f.variadic &&
    f.params.every((p) => scalar(p.type)) &&
    (f.ret.k === "void" || scalar(f.ret));
  const jitFns: JitFn[] = [];
  const jitIndex = new Map<Func, number>();
  const jitOf = (f: Func): number => {
    let i = jitIndex.get(f);
    if (i === undefined) {
      const k = jitFns.length;
      i = k;
      jitIndex.set(f, k);
      // 처음 부를 때 옮긴다. 못 옮기면 해석기로
      jitFns.push((...xs) => {
        const fn: JitFn =
          compileJit(f) ??
          ((...ys) =>
            invokeSlow(
              f,
              ys.map((v, j) => ({ t: f.params[j].type, v })),
              f.body,
            ).v);
        jitFns[k] = fn;
        return fn(...xs);
      });
    }
    return i;
  };
  // 0xcd 로 채운 8바이트: 초기화하지 않은 지역 변수의 값
  const cd = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) cd.setUint8(i, 0xcd);
  const uninit = (t: CType): Num => {
    if (t.k === "float")
      return t.size === 4 ? cd.getFloat32(0, true) : cd.getFloat64(0, true);
    if (t.k === "ptr") return Number(cd.getBigUint64(0, true));
    const signed = t.k === "int" && t.signed;
    switch (t.size) {
      case 1:
        return signed ? cd.getInt8(0) : cd.getUint8(0);
      case 2:
        return signed ? cd.getInt16(0, true) : cd.getUint16(0, true);
      case 4:
        return signed ? cd.getInt32(0, true) : cd.getUint32(0, true);
      default:
        return norm(
          signed ? cd.getBigInt64(0, true) : cd.getBigUint64(0, true),
        );
    }
  };
  const lit = (v: Num): string =>
    typeof v === "bigint"
      ? `${v}n`
      : Object.is(v, -0)
        ? "-0"
        : Number.isNaN(v)
          ? "NaN"
          : v === Number.POSITIVE_INFINITY
            ? "Infinity"
            : v === Number.NEGATIVE_INFINITY
              ? "-Infinity"
              : String(v);
  const isBool = (t: CType) => t.k === "int" && t.name === T.bool.name;
  // 수(number)로만 나오는 타입. 8바이트 정수는 2^53 을 넘으면 bigint 라 아니다
  const plain = (t: CType) =>
    (t.k === "int" && t.size <= 4) ||
    t.k === "float" ||
    t.k === "ptr" ||
    t.k === "func";
  // from 의 모든 값이 to 에 그대로 들어가는가(정수끼리)
  const fits = (from: IntType, to: IntType) =>
    isBool(from) ||
    (to.signed
      ? from.signed
        ? to.size >= from.size
        : to.size > from.size
      : !from.signed && to.size >= from.size);
  const ld64 = (n: Node, a: number, signed: boolean): Num => {
    check(n, a, 8);
    const lo = mem.getUint32(a, true);
    const hi = signed ? mem.getInt32(a + 4, true) : mem.getUint32(a + 4, true);
    if (hi >= -0x200000 && hi < 0x200000) return hi * 2 ** 32 + lo;
    return norm(signed ? mem.getBigInt64(a, true) : mem.getBigUint64(a, true));
  };
  // 옮긴 코드가 부르는 것들. 이름이 짧은 건 코드가 짧으라고
  const helpers = {
    budget,
    mem,
    F: jitFns,
    num,
    W: wrap,
    to: (n: Node) =>
      fail(n, "너무 오래 걸려 멈췄습니다. 끝나지 않는 반복이 있는지 봅시다"),
    at: (n: Node) => {
      here = n;
    },
    sp: () => sp,
    ssp: (v: number) => {
      sp = v;
    },
    alloca: (n: Node, t: CType) => alloca(n, t),
    fresh: (n: Node, t: CType) => {
      const a = alloca(n, t);
      for (let i = 0; i < t.size; i++) mem.setUint8(a + i, 0xcd);
      return a;
    },
    l1s: (n: Node, a: number) => {
      check(n, a, 1);
      return mem.getInt8(a);
    },
    l1u: (n: Node, a: number) => {
      check(n, a, 1);
      return mem.getUint8(a);
    },
    l2s: (n: Node, a: number) => {
      check(n, a, 2);
      return mem.getInt16(a, true);
    },
    l2u: (n: Node, a: number) => {
      check(n, a, 2);
      return mem.getUint16(a, true);
    },
    l4s: (n: Node, a: number) => {
      check(n, a, 4);
      return mem.getInt32(a, true);
    },
    l4u: (n: Node, a: number) => {
      check(n, a, 4);
      return mem.getUint32(a, true);
    },
    l8s: (n: Node, a: number) => ld64(n, a, true),
    l8u: (n: Node, a: number) => ld64(n, a, false),
    lf: (n: Node, a: number) => {
      check(n, a, 4);
      return mem.getFloat32(a, true);
    },
    ld: (n: Node, a: number) => {
      check(n, a, 8);
      return mem.getFloat64(a, true);
    },
    lp: (n: Node, a: number) => {
      check(n, a, 8);
      return mem.getUint32(a, true) + mem.getUint32(a + 4, true) * 2 ** 32;
    },
    lv: (n: Node, a: number, t: CType) => load(n, a, t),
    s1: (n: Node, a: number, v: number) => {
      check(n, a, 1);
      mem.setUint8(a, v & 0xff);
      return v;
    },
    s2: (n: Node, a: number, v: number) => {
      check(n, a, 2);
      mem.setUint16(a, v & 0xffff, true);
      return v;
    },
    s4: (n: Node, a: number, v: number) => {
      check(n, a, 4);
      mem.setUint32(a, v >>> 0, true);
      return v;
    },
    sf: (n: Node, a: number, v: number) => {
      check(n, a, 4);
      mem.setFloat32(a, v, true);
      return v;
    },
    sd: (n: Node, a: number, v: number) => {
      check(n, a, 8);
      mem.setFloat64(a, v, true);
      return v;
    },
    s8: (n: Node, a: number, v: Num) => {
      check(n, a, 8);
      if (typeof v === "number" && Number.isSafeInteger(v)) {
        mem.setUint32(a, v >>> 0, true);
        mem.setUint32(a + 4, Math.floor(v / 2 ** 32) >>> 0, true);
      } else mem.setBigUint64(a, BigInt.asUintN(64, big(v)), true);
      return v;
    },
    sv: (n: Node, a: number, t: CType, v: Num) => {
      store(n, a, t, v);
      return v;
    },
    cp: (n: Node, to: number, from: number, size: number) => {
      copy(n, to, from, size);
      return to;
    },
    zero: (n: Node, a: number, size: number) => {
      check(n, a, size);
      for (let i = 0; i < size; i++) mem.setUint8(a + i, 0);
    },
    str: (n: Node, a: number, t: CType, units: number[], len: number) => {
      for (let i = 0; i < len; i++) store(n, a + i * t.size, t, units[i] ?? 0);
    },
    ix: (
      n: Node,
      an: Node,
      a: number,
      i: number,
      len: number,
      end: number,
      size: number,
    ) => {
      if (i < 0 || i >= len + end)
        fail(n, `배열 ${an.text}[${len}]의 범위 밖 인덱스 ${i}입니다`);
      return a + i * size;
    },
    nn: (n: Node, p: number) => {
      if (p === 0) fail(n, "NULL 포인터를 따라갔습니다");
      return p;
    },
    dv: (n: Node, x: number, y: number) => (y === 0 ? zero(n) : (x / y) | 0),
    md: (n: Node, x: number, y: number) => (y === 0 ? zero(n) : (x % y) | 0),
    udv: (n: Node, x: number, y: number) => (y === 0 ? zero(n) : (x / y) >>> 0),
    umd: (n: Node, x: number, y: number) => (y === 0 ? zero(n) : (x % y) >>> 0),
    a64: (n: Node, op: string, t: IntType, x: Num, y: Num) => {
      if ((op === "/" || op === "%") && y === 0) zero(n);
      return arith64(n, op, t, x, y);
    },
    // 그 밖의 연산은 해석기와 같은 함수로
    ar: (n: Node, op: string, ta: CType, x: Num, tb: CType, y: Num) =>
      arith(n, op, { t: ta, v: x }, { t: tb, v: y }).v,
    neg,
    bnot: (v: Num) => ~big(v),
    lib: (n: Node, name: string, args: Val[]) => callLibrary(n, name, args),
    inv: (f: Func, n: Node, args: Val[]) => invoke(f, args, n),
    // 함수 포인터로 부르기(해석기의 call 과 같은 오류)
    cpt: (n: Node, name: string, args: Val[], addr: number) => {
      const lib = LIBRARY[addr];
      if (lib) return callLibrary(n, lib, args);
      const f = byAddr.get(addr);
      if (!f)
        return fail(
          n,
          addr === 0
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
    },
  };
  const HELPERS = Object.keys(helpers).join(", ");

  const compileJit = (f: Func): JitFn | null => {
    const nodes: Node[] = [];
    const nodeIdx = new Map<Node, number>();
    const consts: unknown[] = [];
    const lets: string[] = [];
    let count = 0;
    const N = (n: Node) => {
      let i = nodeIdx.get(n);
      if (i === undefined) {
        i = nodes.length;
        nodes.push(n);
        nodeIdx.set(n, i);
      }
      return `N[${i}]`;
    };
    const K = (v: unknown) => {
      consts.push(v);
      return `K[${consts.length - 1}]`;
    };
    const tmp = () => {
      const name = `$${count++}`;
      lets.push(name);
      return name;
    };
    type R = { c: string; t: CType };
    type L = { a?: string; v?: string; t: CType };
    type Var = { mem: boolean; js: string; slot: string; t: CType };
    const vars = new Map<Binding, Var>();

    // 주소를 얻는 이름은 메모리에 둔다
    const escaped = new Set<string>();
    const scan = (n: Node) => {
      if (
        n.type === "pointer_expression" &&
        n.childForFieldName("operator")?.text === "&"
      ) {
        let a = n.childForFieldName("argument");
        while (a?.type === "parenthesized_expression") a = a.namedChildren[0];
        if (a?.type === "identifier") escaped.add(a.text);
      }
      for (const c of n.namedChildren) scan(c);
    };
    scan(f.body);

    const conv = (c: string, from: CType, to: CType): string => {
      if (
        to.k === "void" ||
        to.k === "struct" ||
        to.k === "array" ||
        to.k === "func"
      )
        return c;
      if (to.k === "int" && to.bits !== undefined) return `W(${K(to)}, ${c})`;
      const p = plain(from);
      if (to.k === "int") {
        if (isBool(to)) return isBool(from) ? c : `(${c} !== 0 ? 1 : 0)`;
        if (from.k === "int" && from.bits === undefined && fits(from, to))
          return c;
        if (to.size === 8 || !p) return `W(${K(to)}, ${c})`;
        if (to.size === 4) return to.signed ? `(${c} | 0)` : `(${c} >>> 0)`;
        if (to.size === 2)
          return to.signed ? `((${c} << 16) >> 16)` : `(${c} & 65535)`;
        return to.signed ? `((${c} << 24) >> 24)` : `(${c} & 255)`;
      }
      if (to.k === "float") {
        if (to.size === 4)
          return from.k === "float" && from.size === 4
            ? c
            : p
              ? `Math.fround(${c})`
              : `Math.fround(num(${c}))`;
        return p ? c : `num(${c})`;
      }
      if (to.k === "ptr") return p ? c : `num(${c})`;
      return `W(${K(to)}, ${c})`;
    };
    const truthy = (r: R) => `(${r.c} !== 0)`;
    const index = (r: R) => (plain(r.t) ? r.c : `num(${r.c})`);
    const val = (r: R) => `{ t: ${K(r.t)}, v: ${r.c} }`;

    const loadCode = (n: Node, a: string, t: CType): string => {
      if (t.k === "int" && t.bits !== undefined)
        return `lv(${N(n)}, ${a}, ${K(t)})`;
      if (t.k === "float")
        return `${t.size === 4 ? "lf" : "ld"}(${N(n)}, ${a})`;
      if (t.k === "ptr") return `lp(${N(n)}, ${a})`;
      if (t.k !== "int") return noJit();
      const s = t.signed ? "s" : "u";
      return `l${t.size}${s}(${N(n)}, ${a})`;
    };
    // 값 v 는 이미 그 자리 타입으로 바꾼 것. 식의 값은 넣은 값
    const storeCode = (n: Node, l: L, v: string): string => {
      const t = l.t;
      if (l.v) return `(${l.v} = ${v})`;
      const a = l.a ?? noJit();
      if (t.k === "struct") return `cp(${N(n)}, ${a}, ${v}, ${t.size})`;
      if (t.k === "int" && t.bits !== undefined)
        return `sv(${N(n)}, ${a}, ${K(t)}, ${v})`;
      if (t.k === "float")
        return `${t.size === 4 ? "sf" : "sd"}(${N(n)}, ${a}, ${v})`;
      if (t.k === "ptr") return `s8(${N(n)}, ${a}, ${v})`;
      if (t.k !== "int") return noJit();
      return `s${t.size}(${N(n)}, ${a}, ${v})`;
    };

    // 초기화: 할 일을 모아 식들로
    const planOf = (n: Node, type: CType, init: Node) => {
      const saved = planning;
      const plan = { base: 0x100000, items: [] as PlanItem[] };
      planning = plan;
      try {
        initialize(n, plan.base, type, init);
      } finally {
        planning = saved;
      }
      return plan.items;
    };
    const planCode = (n: Node, a: string, type: CType, init: Node) =>
      planOf(n, type, init).map((it) => {
        const at = `${a} + ${it.off}`;
        if (it.k === "zero") return `zero(${N(n)}, ${at}, ${it.size})`;
        if (it.k === "str")
          return `str(${N(n)}, ${at}, ${K(it.t)}, ${K(it.units)}, ${it.len})`;
        const r = rv(it.v);
        if (it.t.k === "array") return noJit();
        return storeCode(n, { a: at, t: it.t }, conv(r.c, r.t, it.t));
      });

    // 이름: 변수 자리 또는 값이 정해진 것(enum 상수, 함수)
    const name = (n: Node): { l?: L; r?: R } => {
      const id = n.text;
      const b = findScoped(id);
      if (b) {
        if (b.kind === "enum") return { r: { c: lit(b.value ?? 0), t: T.int } };
        if (b.kind) return noJit();
        const v = vars.get(b);
        if (v)
          return { l: v.mem ? { a: v.slot, t: v.t } : { v: v.js, t: v.t } };
        if (!b.linked) return noJit();
        if (b.type.k === "func") {
          if (!b.addr) return noJit();
          return { l: { a: lit(b.addr), t: b.type } };
        }
      }
      const e = b ? undefined : enums.get(id);
      if (e !== undefined) return { r: { c: lit(e), t: T.int } };
      const g = globals.get(id);
      if (g) {
        if (g.missing) return noJit();
        return { l: { a: lit(g.addr), t: g.type } };
      }
      const fn = funcs.get(id);
      if (fn) return { l: { a: lit(fn.addr), t: fn.type } };
      const libAddr = known(id) ? LIBRARY_ADDR.get(id) : undefined;
      if (libAddr !== undefined && !protos.has(id))
        return { l: { a: lit(libAddr), t: libType(id) } };
      if (libAddr !== undefined)
        return { l: { a: lit(libAddr), t: protos.get(id) ?? libType(id) } };
      const stream = known(id) ? STREAMS[id] : undefined;
      if (stream) return { r: { c: lit(stream), t: ptr(FILE) } };
      return noJit();
    };
    const PLACE = new Set([
      "identifier",
      "subscript_expression",
      "field_expression",
      "pointer_expression",
      "compound_literal_expression",
      "parenthesized_expression",
    ]);
    // 자리. end: &a[n] 처럼 끝 바로 다음을 가리켜도 되는 a[n], only: & 안이라 주소만 셈하는 식
    const lv = (n: Node, end?: Node, only = false): L => {
      switch (n.type) {
        case "parenthesized_expression":
          return lv(n.namedChildren[0] ?? noJit(), undefined, only);
        case "identifier":
          return name(n).l ?? noJit();
        case "subscript_expression": {
          const arrayNode = field(n, "argument");
          const indexNode = field(n, "index");
          const at = rtype(typeOnly(arrayNode));
          const it = rtype(typeOnly(indexNode));
          if (at.k === "int" && it.k === "ptr") {
            const x = rv(arrayNode);
            const p = rv(indexNode);
            const i = tmp();
            return {
              a: `(${i} = ${index(x)}, ${p.c} + ${i} * ${it.to.size})`,
              t: it.to,
            };
          }
          const bt = typeOnly(arrayNode);
          if (bt.k === "array") {
            const base = lv(arrayNode, undefined, only).a ?? noJit();
            const i = index(rv(indexNode));
            if (bt.n > 0)
              return {
                a: `ix(${N(n)}, ${N(arrayNode)}, ${base}, ${i}, ${bt.n}, ${end === n ? 1 : 0}, ${bt.of.size})`,
                t: bt.of,
              };
            return { a: `(${base} + ${i} * ${bt.of.size})`, t: bt.of };
          }
          if (at.k !== "ptr") return noJit();
          const p = rv(arrayNode);
          const i = index(rv(indexNode));
          return { a: `(${p.c} + ${i} * ${at.to.size})`, t: at.to };
        }
        case "pointer_expression": {
          if (field(n, "operator").text !== "*") return noJit();
          const p = rv(field(n, "argument"));
          if (p.t.k !== "ptr") return noJit();
          return { a: `nn(${N(n)}, ${p.c})`, t: p.t.to };
        }
        case "field_expression": {
          const arrow = field(n, "operator").text === "->";
          const argNode = field(n, "argument");
          let base: string;
          let st: CType;
          if (arrow) {
            const p = rv(argNode);
            if (p.t.k !== "ptr") return noJit();
            st = p.t.to;
            base = only ? p.c : `nn(${N(n)}, ${p.c})`;
          } else if (PLACE.has(argNode.type)) {
            const b = lv(argNode, undefined, only);
            st = b.t;
            base = b.a ?? noJit();
          } else {
            const r = rv(argNode);
            st = r.t;
            base = r.c;
          }
          if (st.k !== "struct") return noJit();
          const fname = field(n, "field").text;
          const fd = st.fields?.find((x) => x.name === fname) ?? noJit();
          return {
            a: `(${base} + ${fd.offset})`,
            t: qualify(fd.type, st.q ?? 0),
          };
        }
        case "compound_literal_expression": {
          let t = typeOfDescriptor(field(n, "type"));
          const init = field(n, "value");
          if (t.k === "array" && !t.n) t = arr(t.of, initCount(init, t.of));
          const slot = `c${count++}`;
          lets.push(slot);
          const fill = planCode(n, slot, t, init);
          return {
            a: `(${slot} ??= alloca(${N(n)}, ${K(t)}), ${[...fill, slot].join(", ")})`,
            t,
          };
        }
        default:
          return noJit();
      }
    };
    // 자리의 값
    const read = (n: Node): R => {
      const l = lv(n);
      const t = l.t;
      if (t.k === "array") return { c: l.a ?? noJit(), t: ptr(t.of) };
      if (t.k === "struct") return { c: l.a ?? noJit(), t: unqualified(t) };
      if (t.k === "func") return { c: l.a ?? noJit(), t };
      if (l.v) return { c: l.v, t: unqualified(t) };
      return { c: loadCode(n, l.a ?? noJit(), t), t: rtype(t) };
    };

    const ARITH = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"]);
    const binop = (n: Node, op: string, a: R, b: R): R => {
      if (op === "&&" || op === "||")
        return {
          c: `(${truthy(a)} ${op} ${truthy(b)} ? 1 : 0)`,
          t: T.int,
        };
      const cmp = CMP.has(op);
      const ta = a.t;
      const tb = b.t;
      if (ta.k === "ptr" || tb.k === "ptr") {
        if (cmp) return { c: `(${a.c} ${jsOp(op)} ${b.c} ? 1 : 0)`, t: T.int };
        if (ta.k === "ptr" && tb.k === "ptr" && op === "-")
          return {
            c: `Math.trunc((${a.c} - ${b.c}) / ${Math.max(ta.to.size, 1)})`,
            t: T.long,
          };
        if (ta.k === "ptr" && tb.k === "int" && (op === "+" || op === "-"))
          return {
            c: `(${a.c} ${op} ${index(b)} * ${Math.max(ta.to.size, 1)})`,
            t: ta,
          };
        if (ta.k === "int" && tb.k === "ptr" && op === "+") {
          const x = tmp();
          return {
            c: `(${x} = ${index(a)}, ${b.c} + ${x} * ${Math.max(tb.to.size, 1)})`,
            t: tb,
          };
        }
        return noJit();
      }
      if (ta.k === "float" || tb.k === "float") {
        const t = isDouble(ta) || isDouble(tb) ? T.double : T.float;
        const x = conv(a.c, ta, t);
        const y = conv(b.c, tb, t);
        if (cmp) return { c: `(${x} ${jsOp(op)} ${y} ? 1 : 0)`, t: T.int };
        if (!"+-*/".includes(op) || op.length !== 1) return noJit();
        return {
          c:
            t.size === 4 ? `Math.fround(${x} ${op} ${y})` : `(${x} ${op} ${y})`,
          t,
        };
      }
      if (ta.k !== "int" || tb.k !== "int") return noJit();
      const shift = op === "<<" || op === ">>";
      const t = shift ? promote(ta, ta) : promote(ta, tb);
      const x = conv(a.c, ta, t);
      const y = shift ? index(b) : conv(b.c, tb, t);
      if (cmp) return { c: `(${x} ${jsOp(op)} ${y} ? 1 : 0)`, t: T.int };
      if (!ARITH.has(op)) return noJit();
      if (t.size === 8)
        return { c: `a64(${N(n)}, "${op}", ${K(t)}, ${x}, ${y})`, t };
      if (t.signed)
        switch (op) {
          case "*":
            return { c: `Math.imul(${x}, ${y})`, t };
          case "/":
            return { c: `dv(${N(n)}, ${x}, ${y})`, t };
          case "%":
            return { c: `md(${N(n)}, ${x}, ${y})`, t };
          case "&":
          case "|":
          case "^":
          case "<<":
          case ">>":
            return { c: `(${x} ${op} ${y})`, t };
          default:
            return { c: `((${x} ${op} ${y}) | 0)`, t };
        }
      switch (op) {
        case "*":
          return { c: `(Math.imul(${x}, ${y}) >>> 0)`, t };
        case "/":
          return { c: `udv(${N(n)}, ${x}, ${y})`, t };
        case "%":
          return { c: `umd(${N(n)}, ${x}, ${y})`, t };
        case ">>":
          return { c: `(${x} >>> ${y})`, t };
        default:
          return { c: `((${x} ${op} ${y}) >>> 0)`, t };
      }
    };
    const jsOp = (op: string) =>
      op === "==" ? "===" : op === "!=" ? "!==" : op;

    // 값으로 쓰는 식. 결과 c 는 JS 식, t 는 값의 타입(struct 는 주소, 배열은 첫 원소 주소)
    const rv = (n: Node): R => {
      switch (n.type) {
        case "number_literal":
        case "char_literal":
        case "sizeof_expression":
        case "alignof_expression":
        case "offsetof_expression":
        case "null": {
          const v = evalSlow(n) as Val;
          // 2^53 을 넘는 정수는 bigint 로 둔다(옮긴 코드의 ===  비교가 맞게)
          const x =
            v.t.k === "int" &&
            typeof v.v === "number" &&
            !Number.isSafeInteger(v.v)
              ? norm(BigInt(v.v))
              : v.v;
          return { c: lit(x), t: rtype(v.t) };
        }
        case "string_literal":
        case "concatenated_string": {
          const p = evalSlow(n) as Place;
          if (!p.addr || p.t.k !== "array") return noJit();
          return { c: lit(p.addr), t: ptr(p.t.of) };
        }
        case "parenthesized_expression":
          return rv(n.namedChildren[0] ?? noJit());
        case "comma_expression": {
          const a = rv(field(n, "left"));
          const b = rv(field(n, "right"));
          return { c: `(${a.c}, ${b.c})`, t: b.t };
        }
        case "identifier": {
          const x = name(n);
          if (x.r) return x.r;
          return read(n);
        }
        case "subscript_expression":
        case "field_expression":
        case "compound_literal_expression":
          return read(n);
        case "pointer_expression": {
          if (field(n, "operator").text !== "&") return read(n);
          const arg = field(n, "argument");
          let inner = arg;
          while (inner.type === "parenthesized_expression")
            inner = inner.namedChildren[0] ?? noJit();
          if (
            inner.type === "pointer_expression" &&
            field(inner, "operator").text === "*"
          ) {
            const p = rv(field(inner, "argument"));
            if (p.t.k === "ptr") return p;
          }
          const l = lv(arg, arg, true);
          if (l.t.k === "func") return { c: l.a ?? noJit(), t: ptr(l.t) };
          return { c: l.a ?? noJit(), t: ptr(l.t) };
        }
        case "binary_expression":
          return binop(
            n,
            field(n, "operator").text,
            rv(field(n, "left")),
            rv(field(n, "right")),
          );
        case "unary_expression": {
          const op = field(n, "operator").text;
          const a = rv(field(n, "argument"));
          if (op === "!") return { c: `(${a.c} !== 0 ? 0 : 1)`, t: T.int };
          const t = a.t.k === "int" && a.t.size < 4 ? T.int : a.t;
          if (op === "+") return { c: a.c, t };
          if (t.k === "float") {
            if (op !== "-") return noJit();
            return { c: `(-${a.c})`, t };
          }
          if (t.k !== "int") return noJit();
          if (t.size === 8)
            return {
              c:
                op === "-"
                  ? `W(${K(t)}, neg(${a.c}))`
                  : `W(${K(t)}, bnot(${a.c}))`,
              t,
            };
          const e = op === "-" ? `(-${a.c})` : `(~${a.c})`;
          return { c: t.signed ? `(${e} | 0)` : `(${e} >>> 0)`, t };
        }
        case "assignment_expression": {
          const op = field(n, "operator").text;
          const l = lv(field(n, "left"));
          const pt = l.t;
          const right = field(n, "right");
          if (op === "=") {
            const r = rv(right);
            if (pt.k === "struct")
              return { c: storeCode(n, l, r.c), t: unqualified(pt) };
            return { c: storeCode(n, l, conv(r.c, r.t, pt)), t: rtype(pt) };
          }
          // 오른쪽을 먼저 계산하고 자리의 값을 읽는다(해석기와 같은 차례)
          const rt = rtype(pt);
          const r = rv(right);
          const y = tmp();
          if (l.v) {
            const res = binop(
              n,
              op.slice(0, -1),
              { c: l.v, t: rt },
              {
                c: y,
                t: r.t,
              },
            );
            return {
              c: `(${y} = ${r.c}, ${l.v} = ${conv(res.c, res.t, pt)})`,
              t: rt,
            };
          }
          const a = tmp();
          const res = binop(
            n,
            op.slice(0, -1),
            { c: loadCode(n, a, pt), t: rt },
            { c: y, t: r.t },
          );
          return {
            c: `(${a} = ${l.a ?? noJit()}, ${y} = ${r.c}, ${storeCode(n, { a, t: pt }, conv(res.c, res.t, pt))})`,
            t: rt,
          };
        }
        case "update_expression": {
          const op = field(n, "operator").text;
          const prefix = n.firstChild?.type === op;
          const l = lv(field(n, "argument"));
          const pt = l.t;
          const rt = rtype(pt);
          const old = tmp();
          const res = binop(
            n,
            op === "++" ? "+" : "-",
            { c: old, t: rt },
            {
              c: "1",
              t: T.int,
            },
          );
          const nv = conv(res.c, res.t, pt);
          if (l.v)
            return {
              c: prefix
                ? `(${old} = ${l.v}, ${l.v} = ${nv})`
                : `(${old} = ${l.v}, ${l.v} = ${nv}, ${old})`,
              t: rt,
            };
          const a = tmp();
          const set = storeCode(n, { a, t: pt }, nv);
          return {
            c: prefix
              ? `(${a} = ${l.a ?? noJit()}, ${old} = ${loadCode(n, a, pt)}, ${set})`
              : `(${a} = ${l.a ?? noJit()}, ${old} = ${loadCode(n, a, pt)}, ${set}, ${old})`,
            t: rt,
          };
        }
        case "cast_expression": {
          const t = unqualified(typeOfDescriptor(field(n, "type")));
          const a = rv(field(n, "value"));
          if (t.k === "void") return { c: `(${a.c}, 0)`, t };
          return { c: conv(a.c, a.t, t), t };
        }
        case "conditional_expression": {
          const t = rtype(typeOnly(n));
          const c = rv(field(n, "condition"));
          const y = rv(field(n, "consequence"));
          const z = rv(field(n, "alternative"));
          if (t.k === "void")
            return { c: `(${truthy(c)} ? ${y.c} : ${z.c})`, t };
          return {
            c: `(${truthy(c)} ? ${conv(y.c, y.t, t)} : ${conv(z.c, z.t, t)})`,
            t,
          };
        }
        case "generic_expression": {
          const [ctrl, ...rest] = stmts(n);
          let t = unqualified(typeOnly(ctrl));
          if (t.k === "array") t = ptr(t.of);
          else if (t.k === "func") t = ptr(t);
          let pick: Node | null = null;
          for (let i = 0; i + 1 < rest.length; i += 2) {
            const td = rest[i];
            if (td.text === "default") pick ??= rest[i + 1];
            else if (sameType(typeOfDescriptor(td), t)) {
              pick = rest[i + 1];
              break;
            }
          }
          return rv(pick ?? noJit());
        }
        case "call_expression":
          return callCode(n);
        default:
          return noJit();
      }
    };

    const callCode = (n: Node): R => {
      if (isStaticAssert(n)) return { c: "0", t: T.void };
      const fnNode = field(n, "function");
      const fname = fnNode.text;
      const argNodes = field(n, "arguments").namedChildren;
      const builtin =
        fnNode.type === "identifier" &&
        !lookupMaybe(fname) &&
        !funcs.has(fname) &&
        !protos.has(fname);
      if (builtin) {
        if (fname.startsWith("__va")) return noJit();
        const args = argNodes.map(rv);
        return {
          c: `lib(${N(n)}, ${JSON.stringify(fname)}, [${args.map(val).join(", ")}]).v`,
          t: BUILTIN_RET[fname] ?? T.int,
        };
      }
      const args = argNodes.map(rv);
      const fv = rv(fnNode);
      const ft = fv.t.k === "ptr" ? fv.t.to : fv.t;
      if (ft.k !== "func") return noJit();
      const addr = /^\d+$/.test(fv.c) ? Number(fv.c) : null;
      const callee = addr === null ? undefined : byAddr.get(addr);
      if (callee) {
        if (
          callee.variadic
            ? args.length < callee.params.length
            : callee.params.length !== args.length
        )
          return noJit();
        if (jitSig(callee)) {
          const xs = args.map((a, i) => conv(a.c, a.t, callee.params[i].type));
          return {
            c: `(at(${N(n)}), F[${jitOf(callee)}](${xs.join(", ")}))`,
            t: callee.ret,
          };
        }
        return {
          c: `inv(${K(callee)}, ${N(n)}, [${args.map(val).join(", ")}]).v`,
          t: callee.ret,
        };
      }
      if (addr !== null && LIBRARY[addr])
        return {
          c: `lib(${N(n)}, ${JSON.stringify(LIBRARY[addr])}, [${args.map(val).join(", ")}]).v`,
          t: ft.ret,
        };
      if (addr !== null) return noJit();
      return {
        c: `cpt(${N(n)}, ${JSON.stringify(fname)}, [${args.map(val).join(", ")}], ${fv.c}).v`,
        t: ft.ret,
      };
    };

    // --- 문장 ---
    const scopes = () => frame().scopes;
    const tick = (n: Node) => `if (--budget.n < 0) to(${N(n)});`;
    // 선언: 이름을 하나씩 묶고(뒤 선언자의 초깃값이 앞 이름을 본다) 자리를 잡는다.
    // reserve: switch 안에서 건너뛸 수 있는 선언의 자리 잡기
    const reserve: string[][] = [];
    const decl = (n: Node): string => {
      const b = specType(n);
      const isSt = isStatic(n);
      const isExt = storage(n, "extern");
      const scope = scopes()[scopes().length - 1];
      const out: string[] = [];
      for (const d of n.childrenForFieldName("declarator")) {
        if (!d) continue;
        const x = declare(b, d);
        const init =
          d.type === "init_declarator" ? d.childForFieldName("value") : null;
        if (x.fn) {
          const addr = funcs.get(x.name)?.addr ?? LIBRARY_ADDR.get(x.name) ?? 0;
          scope.set(x.name, { addr, type: x.type, linked: true });
          continue;
        }
        if (isExt) {
          const g = globals.get(x.name) ?? noJit();
          scope.set(x.name, { ...g, linked: true });
          continue;
        }
        const type =
          x.type.k === "array" && !x.type.n && init
            ? arr(x.type.of, initCount(init, x.type.of))
            : x.type;
        const k = count++;
        const bind: Binding = isSt
          ? { addr: 0, type, static: true }
          : { addr: 0, type, decl: n };
        scope.set(x.name, bind);
        // static 은 선언을 건너뛰어도 있어야 해서 옮길 때 잡고 초기화한다(초깃값은 상수)
        if (isSt) {
          if (d.memo === undefined) {
            dry--;
            try {
              d.memo = staticAlloc(d, type);
              if (init) initialize(d, d.memo, type, init);
            } finally {
              dry++;
            }
          }
          const a = lit(d.memo);
          vars.set(bind, { mem: true, js: a, slot: a, t: type });
          continue;
        }
        const slot = `m${k}`;
        lets.push(slot);
        const here = `if (${slot} === undefined) ${slot} = fresh(${N(n)}, ${K(type)});`;
        reserve.at(-1)?.push(here);
        out.push(here);
        const promoted =
          scalar(type) &&
          !escaped.has(x.name) &&
          init?.type !== "initializer_list";
        if (promoted) {
          const js = `v${k}`;
          lets.push(`${js} = ${lit(uninit(type))}`);
          vars.set(bind, { mem: false, js, slot, t: type });
          if (init) {
            const r = rv(init);
            out.push(`${js} = ${conv(r.c, r.t, type)};`);
          }
        } else {
          vars.set(bind, { mem: true, js: slot, slot, t: type });
          if (init) out.push(`${planCode(d, slot, type, init).join("; ")};`);
        }
      }
      return out.join("\n");
    };
    const block = (own: boolean, body: () => string) => {
      if (own) scopes().push(new Map());
      try {
        return body();
      } finally {
        if (own) scopes().pop();
      }
    };
    const st = (n: Node): string => {
      switch (n.type) {
        case "compound_statement":
          return block(true, () => `{\n${stmts(n).map(st).join("\n")}\n}`);
        case "declaration":
          return decl(n);
        case "type_definition":
        case "struct_specifier":
        case "union_specifier":
        case "enum_specifier":
          execSlow(n);
          return "";
        case "expression_statement": {
          const e = n.namedChildren[0];
          return e ? `${rv(e).c};` : "";
        }
        case ";":
          return "";
        case "if_statement": {
          const c = rv(field(n, "condition"));
          const alt = n.childForFieldName("alternative");
          const no = alt
            ? alt.type === "else_clause"
              ? (alt.namedChildren[0] ?? alt)
              : alt
            : null;
          return `if (${truthy(c)}) {\n${st(field(n, "consequence"))}\n}${no ? ` else {\n${st(no)}\n}` : ""}`;
        }
        case "while_statement": {
          const c = rv(field(n, "condition"));
          return `for (;;) {\n${tick(n)}\nif (!${truthy(c)}) break;\n${st(field(n, "body"))}\n}`;
        }
        case "do_statement": {
          const body = st(field(n, "body"));
          const c = rv(field(n, "condition"));
          return `do {\n${tick(n)}\n${body}\n} while (${truthy(c)});`;
        }
        case "for_statement":
          return block(true, () => {
            const init = n.childForFieldName("initializer");
            const head = init
              ? init.type === "declaration"
                ? decl(init)
                : `${rv(init).c};`
              : "";
            const cn = n.childForFieldName("condition");
            const un = n.childForFieldName("update");
            const c = cn ? `if (!${truthy(rv(cn))}) break;` : "";
            const u = un ? rv(un).c : "";
            return `{\n${head}\nfor (;; ${u}) {\n${tick(n)}\n${c}\n${st(field(n, "body"))}\n}\n}`;
          });
        case "return_statement": {
          const e = n.namedChildren[0];
          if (!e) return "{ ssp(sp0); return 0; }";
          const r = rv(e);
          if (f.ret.k === "void") return `{ ${r.c}; ssp(sp0); return 0; }`;
          const x = tmp();
          return `{ ${x} = ${conv(r.c, r.t, f.ret)}; ssp(sp0); return ${x}; }`;
        }
        case "break_statement":
          return "break;";
        case "continue_statement":
          return "continue;";
        case "switch_statement":
          return switchCode(n);
        default:
          return noJit();
      }
    };
    const switchCode = (n: Node): string => {
      const c = rv(field(n, "condition"));
      const t = c.t.k === "int" ? promote(c.t, c.t) : c.t;
      const body = field(n, "body");
      if (body.type !== "compound_statement") return noJit();
      return block(true, () => {
        reserve.push([]);
        const parts: string[] = [];
        let emitted = 0;
        const emitCase = (k: Node) => {
          emitted++;
          const v = k.childForFieldName("value");
          parts.push(
            v ? `case ${lit(wrap(t, rvalue(v, evalExpr(v)).v))}:` : "default:",
          );
          for (const s of caseBody(k))
            if (s.type === "case_statement") emitCase(s);
            else parts.push(st(s));
        };
        const pre: string[] = [];
        let seen = false;
        for (const k of stmts(body)) {
          if (k.type === "case_statement") {
            seen = true;
            emitCase(k);
          } else if (seen) parts.push(st(k));
          else if (
            k.type === "declaration" &&
            k
              .childrenForFieldName("declarator")
              .every((d) => d?.type !== "init_declarator")
          )
            pre.push(st(k));
          else return noJit();
        }
        // case 가 블록이나 반복 안에 있으면(Duff's device) JS switch 로 못 옮긴다
        if (emitted !== casesOf(body).length) return noJit();
        const skipped = reserve.pop() ?? [];
        return `{\n${pre.join("\n")}\n${skipped.join("\n")}\nswitch (${conv(c.c, c.t, t)}) {\n${parts.join("\n")}\n}\n}`;
      });
    };

    // 검사 때처럼 매개변수와 몸통의 맨 바깥 선언이 한 범위인 가짜 frame 에서 몸통을 훑는다
    const scope = new Map<string, Binding>();
    const prologue: string[] = [];
    const params = f.params.map((_, i) => `p${i}`);
    f.params.forEach((p, i) => {
      const bind: Binding = { addr: 0, type: p.type };
      scope.set(p.name, bind);
      const slot = `m${count++}`;
      lets.push(slot);
      // 자리는 해석기처럼 차례로 잡는다(주소가 같게)
      prologue.push(`${slot} = alloca(${N(f.body)}, ${K(p.type)});`);
      if (escaped.has(p.name)) {
        vars.set(bind, { mem: true, js: slot, slot, t: p.type });
        prologue.push(`${storeCode(f.body, { a: slot, t: p.type }, `p${i}`)};`);
      } else {
        const js = `v${count++}`;
        lets.push(js);
        vars.set(bind, { mem: false, js, slot, t: p.type });
        prologue.push(`${js} = p${i};`);
      }
    });
    frames.push({ name: f.name, scopes: [scope], slots: new Map() });
    dry++;
    let src: string;
    try {
      const body = stmts(f.body).map(st).join("\n");
      src = `"use strict";
const { ${HELPERS} } = H;
return function (${params.join(", ")}) {
${tick(f.body)}
const sp0 = sp();
let ${["$none", ...lets].join(", ")};
${prologue.join("\n")}
${body}
ssp(sp0);
return 0;
};`;
    } catch (e) {
      if (e instanceof NoJit || e instanceof Fail) return null;
      throw e;
    } finally {
      dry--;
      frames.pop();
    }
    try {
      return new Function("H", "N", "K", src)(helpers, nodes, consts) as JitFn;
    } catch (e) {
      // 생성기 실수. 해석기로 돌되 시험(globalThis.C_JIT_DEBUG)에선 드러낸다
      if (
        e instanceof SyntaxError &&
        !(globalThis as { C_JIT_DEBUG?: boolean }).C_JIT_DEBUG
      )
        return null;
      throw e;
    }
  };

  const checkFunction = (f: Func) => {
    // 매개변수와 몸통의 맨 바깥 선언은 같은 범위다(int f(int a) { int a; } 는 오류)
    const scope = new Map<string, Binding>();
    for (const p of f.params) scope.set(p.name, { addr: 0, type: p.type });
    frames.push({
      name: f.name,
      scopes: [scope],
      va: f.variadic ? 0 : undefined,
      slots: new Map(),
    });
    dry++;
    try {
      const c: Ctx = {
        name: f.name,
        ret: f.ret,
        loops: 0,
        breaks: 0,
        switches: [],
        labels: new Set(),
        gotos: [],
      };
      for (const k of stmts(f.body)) checkStmt(k, c);
      for (const g of c.gotos) {
        const l = field(g, "label").text;
        if (!c.labels.has(l))
          fail(g, `함수 ${f.name} 안에 레이블 ${l} 이 없습니다`);
      }
    } finally {
      dry--;
      frames.pop();
    }
  };

  // 문자열 상수를 실행 전에 모아 앞쪽(0x1000~)에 둔다. 전역은 그 뒤 0x2000 부터
  const collectStrings = (n: Node) => {
    if (n.type === "string_literal" || n.type === "concatenated_string")
      evalExpr(n);
    else for (const c of n.namedChildren) collectStrings(c);
  };

  const declaredName = (d: Node): string => {
    const inner = d.childForFieldName("declarator");
    if (inner) return declaredName(inner);
    const named = d.namedChildren[0];
    return d.type === "identifier" || !named ? d.text : declaredName(named);
  };
  // 정의가 있는 전역 이름: extern 이 아니거나 초기화가 있는 선언
  const defined = new Set<string>();
  const markDefined = (top: Node) => {
    for (const d of top.childrenForFieldName("declarator"))
      if (d && (!storage(top, "extern") || d.type === "init_declarator"))
        defined.add(declaredName(d));
  };
  for (const top of root.namedChildren ?? [])
    if (top.type === "declaration") markDefined(top);

  // 함수 안 static 변수들의 크기 합. 타입을 셀 수 없는 것(그 블록에서 만든 struct 등)은 0 으로 친다
  const staticLocals = (n: Node): number => {
    if (n.type === "declaration" && isStatic(n)) {
      const t = field(n, "type");
      if (
        /^(struct|union|enum)_specifier$/.test(t.type) &&
        t.childForFieldName("body")
      )
        return 0;
      try {
        const b = typeOf(t);
        return n
          .childrenForFieldName("declarator")
          .reduce((sum, d) => sum + (d ? declare(b, d).type.size + 16 : 0), 0);
      } catch {
        return 0;
      }
    }
    return n.namedChildren.reduce((sum, c) => sum + staticLocals(c), 0);
  };

  let error: CError | null = null;
  let exit = 0;
  try {
    checking = true;
    collectStrings(root);
    globalTop = Math.max(GLOBAL_BASE, Math.ceil(strTop / 0x1000) * 0x1000);
    for (const top of root.namedChildren) if (top) topLevel(top);
    for (const d of tentative) {
      const g = globals.get(declaredName(d));
      if (g && !complete(g.type) && g.type.k !== "array")
        fail(d, `크기를 모르는 타입 ${typeName(g.type)} 의 변수입니다`);
    }
    checking = false;
    // 실행 중에 생기는 static 지역 변수 자리를 남기고 힙을 시작한다
    heapBase = Math.max(
      HEAP_BASE,
      Math.ceil(
        (globalTop +
          root.namedChildren
            .filter((f) => f.type === "function_definition")
            .reduce((sum, f) => sum + staticLocals(field(f, "body")), 0) +
          0x1000) /
          0x1000,
      ) * 0x1000,
    );
    heapTop = heapBase;
    started = true;
    const main = funcs.get("main") ?? fail(null, "main 함수가 없습니다");
    // int main(int argc, char **argv) 면 프로그램 이름 하나만 넘긴다
    const argv = staticAlloc(root, arr(ptr(T.char), 2));
    store(null, argv, ptr(T.char), strAddr("main"));
    const mainArgs: Val[] = [
      { t: T.int, v: 1 },
      { t: ptr(ptr(T.char)), v: argv },
    ];
    exit = num(invoke(main, mainArgs.slice(0, main.params.length), root).v);
  } catch (e) {
    if (e instanceof Stop)
      return { steps, out: text(out), error, exit, leaked: 0, truncated, read };
    if (e instanceof Fail) error = { line: e.line, msg: e.message };
    else if (e instanceof Exit) exit = e.code;
    // 해석기를 돌리는 JS 의 스택이 C 스택(1MB)보다 먼저 찬다
    else if (e instanceof RangeError && /call stack/i.test(e.message))
      error = {
        line: here ? lineOf(here) : null,
        msg: "재귀가 너무 깊어 멈췄습니다. 이 실행기는 함수를 수천 번까지 겹쳐 부를 수 있습니다",
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
