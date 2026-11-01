// 전처리기. 파싱 전에 #define·#if 를 풀어 평범한 C 로 바꾼다.
// 줄 번호가 원문과 같아야 오류와 지금 줄을 원문 위에 보일 수 있으니, 지시문 줄은 빈 줄로 두고 줄 수를 바꾸지 않는다.
// #include 는 아는 표준 헤더만 받고 내용은 넣지 않는다(printf·malloc 같은 함수는 해석기가 안다).

export const HEADERS = [
  "stdio.h",
  "stdlib.h",
  "string.h",
  "stdbool.h",
  "stddef.h",
  "stdint.h",
  "limits.h",
  "assert.h",
  "ctype.h",
  "math.h",
  "float.h",
  "stdarg.h",
  "iso646.h",
  "stdalign.h",
  "stdnoreturn.h",
];

type Macro = { params: string[] | null; body: string };
export type CppError = { line: number; msg: string };

class CppFail extends Error {
  line: number;
  constructor(line: number, msg: string) {
    super(msg);
    this.line = line;
  }
}

const BUILTIN: Record<string, string> = {
  NULL: "((void *)0)",
  __STDC__: "1",
  __STDC_VERSION__: "201710L",
  __STDC_HOSTED__: "1",
  true: "1",
  false: "0",
  bool: "_Bool",
  INT_MAX: "2147483647",
  INT_MIN: "(-2147483647 - 1)",
  UINT_MAX: "4294967295U",
  LONG_MAX: "9223372036854775807L",
  LONG_MIN: "(-9223372036854775807L - 1)",
  CHAR_BIT: "8",
  CHAR_MAX: "127",
  CHAR_MIN: "(-128)",
  SCHAR_MAX: "127",
  UCHAR_MAX: "255",
  SHRT_MAX: "32767",
  SHRT_MIN: "(-32768)",
  SCHAR_MIN: "(-128)",
  USHRT_MAX: "65535",
  ULONG_MAX: "18446744073709551615UL",
  LLONG_MAX: "9223372036854775807LL",
  LLONG_MIN: "(-9223372036854775807LL - 1)",
  ULLONG_MAX: "18446744073709551615ULL",
  MB_LEN_MAX: "6",
  SIZE_MAX: "18446744073709551615UL",
  PTRDIFF_MAX: "9223372036854775807L",
  PTRDIFF_MIN: "(-9223372036854775807L - 1)",
  INTPTR_MAX: "9223372036854775807L",
  INTPTR_MIN: "(-9223372036854775807L - 1)",
  UINTPTR_MAX: "18446744073709551615UL",
  INTMAX_MAX: "9223372036854775807L",
  INTMAX_MIN: "(-9223372036854775807L - 1)",
  UINTMAX_MAX: "18446744073709551615UL",
  INT8_MAX: "127",
  INT8_MIN: "(-128)",
  UINT8_MAX: "255",
  INT16_MAX: "32767",
  INT16_MIN: "(-32768)",
  UINT16_MAX: "65535",
  INT32_MAX: "2147483647",
  INT32_MIN: "(-2147483647 - 1)",
  UINT32_MAX: "4294967295U",
  INT64_MAX: "9223372036854775807L",
  INT64_MIN: "(-9223372036854775807L - 1)",
  UINT64_MAX: "18446744073709551615UL",
  EXIT_SUCCESS: "0",
  EXIT_FAILURE: "1",
  RAND_MAX: "2147483647",
  // float.h
  FLT_RADIX: "2",
  FLT_MANT_DIG: "24",
  DBL_MANT_DIG: "53",
  FLT_DIG: "6",
  DBL_DIG: "15",
  FLT_MAX: "3.40282347e+38F",
  FLT_MIN: "1.17549435e-38F",
  FLT_EPSILON: "1.19209290e-7F",
  DBL_MAX: "1.7976931348623157e+308",
  DBL_MIN: "2.2250738585072014e-308",
  DBL_EPSILON: "2.2204460492503131e-16",
  // math.h
  INFINITY: "(1e308f * 10)",
  HUGE_VAL: "(1e308 * 10)",
  NAN: "(0.0f / 0.0f)",
};

// stdarg.h. 가변 인자는 부른 쪽 스택에 8바이트 칸으로 차례로 놓인다(__va_start 가 첫 칸 주소).
// va_arg 는 진짜 헤더처럼 매크로로: 타입 자리를 파서가 식으로 읽지 못해 형 변환과 sizeof 로 바꾼다
const FUNCTION_MACROS: Record<string, Macro> = {
  va_start: { params: ["ap", "last"], body: "((ap) = __va_start())" },
  va_arg: {
    params: ["ap", "T"],
    body: "(*(T *)__va_next(&(ap), sizeof(T)))",
  },
  va_end: { params: ["ap"], body: "((void)(ap))" },
  va_copy: { params: ["d", "s"], body: "((d) = (s))" },
};

// 주석을 공백으로 바꾼다(줄바꿈은 남긴다). 문자열 속 /* 는 건드리지 않는다
function stripComments(src: string) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const j = skipQuoted(src, i);
      out += src.slice(i, j);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, " ");
      i += body.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipQuoted(s: string, i: number) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q && s[j] !== "\n")
    j += s[j] === "\\" ? 2 : 1;
  return j + 1;
}

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isId = (c: string) => /[A-Za-z0-9_]/.test(c);

export function preprocess(src: string): {
  code: string;
  error: CppError | null;
} {
  const macros = new Map<string, Macro>([
    ...Object.entries(BUILTIN).map(([k, body]): [string, Macro] => [
      k,
      { params: null, body },
    ]),
    ...Object.entries(FUNCTION_MACROS),
  ]);
  // 줄 끝 \ 로 이은 줄을 합치고, 합친 만큼 뒤에 빈 줄을 둔다
  const raw = stripComments(src).split("\n");
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    let extra = 0;
    while (line.endsWith("\\") && i + 1 < raw.length) {
      line = line.slice(0, -1) + raw[++i];
      extra++;
    }
    lines.push(line, ...Array<string>(extra).fill(""));
  }

  // 매크로를 펼친다. hide 는 지금 펼치는 중인 이름(자기 자신을 다시 펼치지 않게)
  const expand = (
    text: string,
    line: number,
    hide: Set<string> = new Set(),
  ): string => {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const j = skipQuoted(text, i);
        out += text.slice(i, j);
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < text.length && /[0-9A-Za-z_.]/.test(text[j])) j++;
        out += text.slice(i, j);
        i = j;
        continue;
      }
      if (!isIdStart(c)) {
        out += c;
        i++;
        continue;
      }
      let j = i;
      while (j < text.length && isId(text[j])) j++;
      const name = text.slice(i, j);
      if (name === "__LINE__" || name === "__FILE__") {
        out += name === "__LINE__" ? String(line + 1) : '"main.c"';
        i = j;
        continue;
      }
      const m = macros.get(name);
      if (!m || hide.has(name)) {
        out += name;
        i = j;
        continue;
      }
      // 펼친 결과는 앞뒤와 띄운다. 붙이면 0x1E 와 +1 이 0x1E+1 처럼 한 토큰으로 읽힌다
      if (m.params === null) {
        out += ` ${expand(m.body, line, new Set([...hide, name]))} `;
        i = j;
        continue;
      }
      // 함수 꼴 매크로: 이름 뒤에 ( 가 와야 부른 것이다
      let k = j;
      while (text[k] === " " || text[k] === "\t") k++;
      if (text[k] !== "(") {
        out += name;
        i = j;
        continue;
      }
      const args: string[] = [];
      let depth = 0;
      let cur = "";
      k++;
      for (; k < text.length; k++) {
        const ch = text[k];
        if (ch === '"' || ch === "'") {
          const e = skipQuoted(text, k);
          cur += text.slice(k, e);
          k = e - 1;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") {
          if (depth === 0) break;
          depth--;
        }
        if (ch === "," && depth === 0) {
          args.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      if (k >= text.length)
        throw new CppFail(line, `${name}( 의 닫는 괄호가 없습니다`);
      if (cur.trim() || args.length) args.push(cur.trim());
      const variadic = m.params.at(-1) === "...";
      const fixed = variadic ? m.params.length - 1 : m.params.length;
      if (
        variadic
          ? args.length < fixed
          : args.length !== fixed && !(fixed === 0 && args.length === 0)
      )
        throw new CppFail(
          line,
          `매크로 ${name}에 인자를 ${fixed}개 넘겨야 합니다`,
        );
      const bind = new Map<string, string>(
        m.params.slice(0, fixed).map((p, x) => [p, args[x]]),
      );
      if (variadic) bind.set("__VA_ARGS__", args.slice(fixed).join(", "));
      out += ` ${expand(
        substitute(m.body, bind, (a) => expand(a, line, hide)),
        line,
        new Set([...hide, name]),
      )} `;
      i = k + 1;
    }
    return out;
  };

  // 매개변수 자리에 인자를 넣는다. #x 는 문자열로, a ## b 는 붙인다(이 둘은 인자를 펼치지 않는다)
  const substitute = (
    body: string,
    bind: Map<string, string>,
    full: (a: string) => string,
  ) => {
    const toks =
      body.match(
        /##|#|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\s+|./g,
      ) ?? [];
    const res: string[] = [];
    for (let t = 0; t < toks.length; t++) {
      const tok = toks[t];
      if (tok === "#" && t + 1 < toks.length) {
        let n = t + 1;
        while (/^\s+$/.test(toks[n] ?? "")) n++;
        const a = bind.get(toks[n]);
        if (a !== undefined) {
          res.push(JSON.stringify(a));
          t = n;
          continue;
        }
      }
      if (tok === "##") {
        while (res.length && /^\s+$/.test(res[res.length - 1])) res.pop();
        let n = t + 1;
        while (/^\s+$/.test(toks[n] ?? "")) n++;
        const next = toks[n] ?? "";
        res.push(bind.get(next) ?? next);
        t = n;
        continue;
      }
      const a = bind.get(tok);
      let nextReal = t + 1;
      while (/^\s+$/.test(toks[nextReal] ?? "")) nextReal++;
      if (a !== undefined) res.push(toks[nextReal] === "##" ? a : full(a));
      else res.push(tok);
    }
    // 붙이기는 앞 조각과 뒤 조각을 사이 공백 없이 잇는 것
    return res.join("");
  };

  // #if 식: defined 를 풀고 매크로를 펼친 뒤 남은 이름은 0
  const condition = (expr: string, line: number) => {
    const d = expr.replace(
      /\bdefined\s*(?:\(\s*(\w+)\s*\)|(\w+))/g,
      (_, a, b) => (macros.has(a ?? b) ? " 1 " : " 0 "),
    );
    const e = expand(d, line).replace(/\b[A-Za-z_]\w*\b/g, "0");
    return evalIf(e, line) !== 0;
  };

  const out: string[] = [];
  // 조건 스택: 지금 줄을 내보내는지, 이 #if 묶음에서 이미 참인 갈래가 있었는지
  const conds: { on: boolean; taken: boolean; parentOn: boolean }[] = [];
  const active = () => conds.every((c) => c.on);
  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dir = /^\s*#\s*(\w*)\s*(.*)$/.exec(line);
      if (!dir) {
        out.push(active() ? expand(line, i) : "");
        continue;
      }
      out.push("");
      const [, kw, rest] = dir;
      switch (kw) {
        case "if":
        case "ifdef":
        case "ifndef": {
          const parentOn = active();
          const v =
            parentOn &&
            (kw === "if"
              ? condition(rest, i)
              : macros.has(rest.trim()) === (kw === "ifdef"));
          conds.push({ on: v, taken: v, parentOn });
          break;
        }
        case "elif": {
          const c = conds.at(-1) ?? fail(i, "#if 없이 #elif 를 썼습니다");
          c.on = c.parentOn && !c.taken && condition(rest, i);
          c.taken ||= c.on;
          break;
        }
        case "else": {
          const c = conds.at(-1) ?? fail(i, "#if 없이 #else 를 썼습니다");
          c.on = c.parentOn && !c.taken;
          c.taken = true;
          break;
        }
        case "endif":
          if (!conds.pop()) fail(i, "#if 없이 #endif 를 썼습니다");
          break;
        default: {
          if (!active()) break;
          if (kw === "define") {
            const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
            if (!m) fail(i, "#define 뒤에 이름이 없습니다");
            else
              macros.set(m[1], {
                params: m[2]
                  ? m[3]
                      .split(",")
                      .map((p) => p.trim())
                      .filter(Boolean)
                  : null,
                body: m[4].trim(),
              });
          } else if (kw === "undef") macros.delete(rest.trim());
          else if (kw === "include") {
            const h = /^<([^>]+)>/.exec(rest.trim())?.[1];
            if (!h || !HEADERS.includes(h))
              fail(
                i,
                `지원하지 않는 헤더 ${rest.trim()}(표준 헤더 ${HEADERS.join(", ")}만 됩니다)`,
              );
          } else if (kw === "error") fail(i, `#error ${rest}`);
          else if (kw !== "" && kw !== "pragma" && kw !== "line")
            fail(i, `지원하지 않는 전처리 지시문 #${kw}`);
        }
      }
    }
    if (conds.length) fail(lines.length - 1, "#endif 가 모자랍니다");
  } catch (e) {
    if (e instanceof CppFail)
      return { code: "", error: { line: e.line, msg: e.message } };
    throw e;
  }
  return { code: out.join("\n"), error: null };
}

function fail(line: number, msg: string): never {
  throw new CppFail(line, msg);
}

// #if 의 정수 식을 계산한다(우선순위 오름차순으로 내려가는 재귀 하강)
function evalIf(src: string, line: number): number {
  const toks =
    src.match(
      /0[xX][0-9a-fA-F]+|\d+|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%<>!~&|^()?:]|\S/g,
    ) ?? [];
  let p = 0;
  const peek = () => toks[p];
  const eat = (t?: string) => {
    if (t && toks[p] !== t) fail(line, "#if 식을 읽지 못했습니다");
    return toks[p++];
  };
  const BIN: string[][] = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<", ">", "<=", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];
  const ternary = (): number => {
    const c = binary(0);
    if (peek() !== "?") return c;
    eat("?");
    const a = ternary();
    eat(":");
    const b = ternary();
    return c ? a : b;
  };
  const binary = (lv: number): number => {
    if (lv === BIN.length) return unary();
    let a = binary(lv + 1);
    while (BIN[lv].includes(peek())) {
      const op = eat();
      const b = binary(lv + 1);
      a = applyOp(op, a, b, line);
    }
    return a;
  };
  const unary = (): number => {
    const t = eat();
    if (t === "(") {
      const v = ternary();
      eat(")");
      return v;
    }
    if (t === "-") return -unary();
    if (t === "+") return unary();
    if (t === "!") return unary() ? 0 : 1;
    if (t === "~") return ~unary();
    const v = Number(t?.replace(/[uUlL]+$/, ""));
    if (t === undefined || Number.isNaN(v))
      return fail(line, "#if 식을 읽지 못했습니다");
    return v;
  };
  const v = ternary();
  if (p < toks.length) fail(line, "#if 식을 읽지 못했습니다");
  return v;
}

function applyOp(op: string, a: number, b: number, line: number): number {
  switch (op) {
    case "||":
      return a || b ? 1 : 0;
    case "&&":
      return a && b ? 1 : 0;
    case "|":
      return a | b;
    case "^":
      return a ^ b;
    case "&":
      return a & b;
    case "==":
      return a === b ? 1 : 0;
    case "!=":
      return a !== b ? 1 : 0;
    case "<":
      return a < b ? 1 : 0;
    case ">":
      return a > b ? 1 : 0;
    case "<=":
      return a <= b ? 1 : 0;
    case ">=":
      return a >= b ? 1 : 0;
    case "<<":
      return a << b;
    case ">>":
      return a >> b;
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
    case "%":
      if (b === 0) fail(line, "#if 식에서 0으로 나눴습니다");
      return op === "/" ? Math.trunc(a / b) : a % b;
    default:
      return fail(line, `#if 식의 연산자 ${op}`);
  }
}
