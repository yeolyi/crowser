// 전처리기. 파싱 전에 #define·#if 를 풀어 평범한 C 로 바꾼다.
// 줄 번호가 원문과 같아야 오류와 지금 줄을 원문 위에 보일 수 있으니, 지시문 줄은 빈 줄로 두고 줄 수를 바꾸지 않는다.
// #include 는 아는 표준 헤더만 받는다. 헤더 파일은 없고 그 헤더의 매크로만 정의한다(함수·타입은 해석기가 안다).
import { HEADER_NAMES, HEADERS, headersOf } from "./headers.ts";

export { HEADERS };

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
  // 표준이 고르게 둔 기능 중 없는 것: 복소수, _Atomic, 스레드, 가변 길이 배열
  __STDC_NO_COMPLEX__: "1",
  __STDC_NO_VLA__: "1",
  __STDC_NO_ATOMICS__: "1",
  __STDC_NO_THREADS__: "1",
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
  EOF: "(-1)",
  SEEK_SET: "0",
  SEEK_CUR: "1",
  SEEK_END: "2",
  FOPEN_MAX: "20",
  FILENAME_MAX: "4096",
  CLOCKS_PER_SEC: "1000000",
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
  alignas: "_Alignas",
  alignof: "_Alignof",
  noreturn: "_Noreturn",
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
  /** include 한 표준 헤더 */
  headers: Set<string>;
} {
  const pushed = new Map<string, (Macro | undefined)[]>();
  const headers = new Set<string>();
  const known = (name: string): Macro | undefined =>
    name in BUILTIN
      ? { params: null, body: BUILTIN[name] }
      : FUNCTION_MACROS[name];
  // 헤더가 주는 매크로는 include 할 때 정의한다
  const macros = new Map<string, Macro>(
    [...Object.keys(BUILTIN), ...Object.keys(FUNCTION_MACROS)]
      .filter((k) => !headersOf(k))
      .map((k): [string, Macro] => [k, known(k) as Macro]),
  );
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

  // #line 이 바꾼 줄 번호(__LINE__ 에 더할 값)와 파일 이름
  let lineShift = 0;
  let fileName = '"main.c"';
  // 매크로를 펼친다. hide 는 지금 펼치는 중인 이름(자기 자신을 다시 펼치지 않게)
  const expand = (
    input: string,
    line: number,
    hide: Set<string> = new Set(),
  ): string => {
    let text = input;
    let out = "";
    let i = 0;
    // 펼친 결과를 내보내고 at 부터 이어 읽는다. 결과가 함수 꼴 매크로 이름으로 끝나고 뒤에 ( 가 오면
    // 표준대로 뒤 글과 이어서 다시 읽는다(CAT(A,B)(x) 가 AB(x) 가 되어 다시 펼쳐진다)
    const emit = (res: string, at: number, self: string) => {
      const tail = /([A-Za-z_]\w*)\s*$/.exec(res);
      const g = tail ? macros.get(tail[1]) : undefined;
      if (
        tail &&
        g?.params &&
        tail[1] !== self &&
        !hide.has(tail[1]) &&
        /^\s*\(/.test(text.slice(at))
      ) {
        out += ` ${res.slice(0, tail.index)}`;
        text = tail[1] + text.slice(at);
        i = 0;
        return;
      }
      out += ` ${res} `;
      i = at;
    };
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
        out += name === "__LINE__" ? String(line + 1 + lineShift) : fileName;
        i = j;
        continue;
      }
      const m = macros.get(name);
      // L'a'·u8"…" 의 접두사는 이름이 아니라 상수의 일부다
      const prefix = /^(L|u|U|u8)$/.test(name) && /['"]/.test(text[j] ?? "");
      if (!m || hide.has(name) || prefix) {
        out += name;
        i = j;
        continue;
      }
      // 펼친 결과는 앞뒤와 띄운다. 붙이면 0x1E 와 +1 이 0x1E+1 처럼 한 토큰으로 읽힌다
      if (m.params === null) {
        emit(expand(m.body, line, new Set([...hide, name])), j, name);
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
      emit(
        expand(
          substitute(m.body, bind, (a) => expand(a, line, hide)),
          line,
          new Set([...hide, name]),
        ),
        k + 1,
        name,
      );
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
        /##|#|(?:u8|[LuU])?"(?:\\.|[^"\\])*"|(?:u8|[LuU])?'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\s+|./g,
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
        // 붙인 결과가 뒤 토큰과 다시 붙지 않게(+ ## 빈 인자 뒤의 + 가 ++ 가 되지 않게) 띄운다
        res.push(bind.get(next) ?? next, " ");
        t = n;
        continue;
      }
      const a = bind.get(tok);
      let nextReal = t + 1;
      while (/^\s+$/.test(toks[nextReal] ?? "")) nextReal++;
      if (a !== undefined)
        res.push(toks[nextReal] === "##" ? a : ` ${full(a)} `);
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
    const e = expand(d, line).replace(
      /\b(?:u8|[LuU])?'(?:\\.|[^'\\])+'|'(?:\\.|[^'\\])+'|\b\d\w*|\b[A-Za-z_]\w*\b/g,
      (t) => (/^(?:u8|[LuU])?'|^\d/.test(t) ? t : "0"),
    );
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
            if (!headers.has(h)) {
              headers.add(h);
              for (const name of HEADER_NAMES[h].split(" ")) {
                const m = known(name);
                if (m && !macros.has(name)) macros.set(name, m);
              }
            }
          } else if (kw === "error") fail(i, `#error ${rest}`);
          else if (kw === "line") {
            // #line 줄 ["파일"]: 다음 줄의 번호가 줄이 된다
            const m = /^\s*(\d+)\s*("(?:\\.|[^"\\])*")?\s*$/.exec(
              expand(rest, i),
            );
            if (!m) fail(i, "#line 뒤에는 줄 번호를 씁니다");
            else {
              lineShift = Number(m[1]) - i - 2;
              if (m[2]) fileName = m[2];
            }
          } else if (kw === "pragma") {
            // push_macro·pop_macro: 표준은 아니지만 clang·gcc·MSVC 가 모두 받는다. 다른 #pragma 는 무시한다
            const m = /^(push|pop)_macro\s*\(\s*"([^"]*)"\s*\)\s*$/.exec(
              rest.trim(),
            );
            if (m) {
              const stack = pushed.get(m[2]) ?? [];
              pushed.set(m[2], stack);
              if (m[1] === "push") stack.push(macros.get(m[2]));
              else if (stack.length) {
                const old = stack.pop();
                if (old) macros.set(m[2], old);
                else macros.delete(m[2]);
              }
            }
          } else if (kw !== "") fail(i, `지원하지 않는 전처리 지시문 #${kw}`);
        }
      }
    }
    if (conds.length) fail(lines.length - 1, "#endif 가 모자랍니다");
  } catch (e) {
    if (e instanceof CppFail)
      return { code: "", error: { line: e.line, msg: e.message }, headers };
    throw e;
  }
  return { code: out.join("\n"), error: null, headers };
}

function fail(line: number, msg: string): never {
  throw new CppFail(line, msg);
}

// #if 의 정수 식을 계산한다(우선순위 오름차순으로 내려가는 재귀 하강). 표준대로 intmax_t·uintmax_t(64비트)로
// 계산하고, 하나라도 unsigned 면 unsigned 로. && || ?: 의 계산하지 않는 쪽에서는 0 으로 나눠도 오류가 아니다
type IfVal = { v: bigint; u: boolean };
function evalIf(src: string, line: number): number {
  const toks =
    src.match(
      /0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|\d+[uUlL]*|(?:u8|[LuU])?'(?:\\.|[^'\\])+'|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%<>!~&|^()?:]|\S/g,
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
  const fix = (x: IfVal): IfVal => ({
    v: x.u ? BigInt.asUintN(64, x.v) : BigInt.asIntN(64, x.v),
    u: x.u,
  });
  const bool = (b: boolean): IfVal => ({ v: b ? 1n : 0n, u: false });
  const ternary = (live: boolean): IfVal => {
    const c = binary(0, live);
    if (peek() !== "?") return c;
    eat("?");
    const a = ternary(live && c.v !== 0n);
    eat(":");
    const b = ternary(live && c.v === 0n);
    return fix({ v: c.v ? a.v : b.v, u: a.u || b.u });
  };
  const binary = (lv: number, live: boolean): IfVal => {
    if (lv === BIN.length) return unary(live);
    let a = binary(lv + 1, live);
    while (BIN[lv].includes(peek())) {
      const op = eat();
      const rhsLive =
        live && (op === "&&" ? a.v !== 0n : op === "||" ? a.v === 0n : true);
      const b = binary(lv + 1, rhsLive);
      a = apply(op, a, b, rhsLive);
    }
    return a;
  };
  const apply = (op: string, a: IfVal, b: IfVal, live: boolean): IfVal => {
    if (op === "&&") return bool(a.v !== 0n && b.v !== 0n);
    if (op === "||") return bool(a.v !== 0n || b.v !== 0n);
    // << >> 는 왼쪽 값의 타입, 나머지는 둘 중 하나라도 unsigned 면 unsigned
    const u = op === "<<" || op === ">>" ? a.u : a.u || b.u;
    const x = u ? BigInt.asUintN(64, a.v) : a.v;
    const y = u && op !== "<<" && op !== ">>" ? BigInt.asUintN(64, b.v) : b.v;
    switch (op) {
      case "==":
        return bool(x === y);
      case "!=":
        return bool(x !== y);
      case "<":
        return bool(x < y);
      case ">":
        return bool(x > y);
      case "<=":
        return bool(x <= y);
      case ">=":
        return bool(x >= y);
      case "/":
      case "%":
        if (y === 0n) {
          if (live) fail(line, "#if 식에서 0으로 나눴습니다");
          return { v: 0n, u };
        }
        return fix({ v: op === "/" ? x / y : x % y, u });
    }
    const r = {
      "|": x | y,
      "^": x ^ y,
      "&": x & y,
      "<<": x << (y & 63n),
      ">>": x >> (y & 63n),
      "+": x + y,
      "-": x - y,
      "*": x * y,
    }[op];
    if (r === undefined) return fail(line, `#if 식의 연산자 ${op}`);
    return fix({ v: r, u });
  };
  const unary = (live: boolean): IfVal => {
    const t = eat();
    if (t === "(") {
      const v = ternary(live);
      eat(")");
      return v;
    }
    if (t === "-") {
      const x = unary(live);
      return fix({ v: -x.v, u: x.u });
    }
    if (t === "+") return unary(live);
    if (t === "!") return bool(unary(live).v === 0n);
    if (t === "~") {
      const x = unary(live);
      return fix({ v: ~x.v, u: x.u });
    }
    const q = t?.indexOf("'") ?? -1;
    if (t && q >= 0) {
      // L·u·U 문자는 부호 없이 그 값 그대로, 그냥 문자는 char(부호 있음)
      const wide = q > 0 && t.slice(0, q) !== "u8";
      return { v: BigInt(charValue(t.slice(q + 1, -1), wide)), u: false };
    }
    const m = t && /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)([uUlL]*)$/.exec(t);
    if (!m) return fail(line, "#if 식을 읽지 못했습니다");
    const digits = m[1];
    const v = /^0\d/.test(digits)
      ? BigInt(`0o${digits.slice(1)}`)
      : BigInt(digits);
    // 접미사 u 가 있거나 intmax_t 에 안 들어가면 unsigned
    return { v, u: /u/i.test(m[2]) || v > 0x7fffffffffffffffn };
  };
  const v = ternary(true);
  if (p < toks.length) fail(line, "#if 식을 읽지 못했습니다");
  return v.v === 0n ? 0 : 1;
}

const CHAR_ESC: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  "0": 0,
  "\\": 92,
  "'": 39,
  '"': 34,
  "?": 63,
};
// '\n'·'\x41'·'\101' 같은 문자 상수의 값(char 는 부호가 있다)
function charValue(body: string, wide = false): number {
  let c: number;
  if (body[0] !== "\\") c = body.codePointAt(0) ?? 0;
  else if (body[1] === "x") c = Number.parseInt(body.slice(2), 16);
  else if (/[0-7]/.test(body[1])) c = Number.parseInt(body.slice(1, 4), 8);
  else c = CHAR_ESC[body[1]] ?? body.charCodeAt(1);
  return wide ? c : (c << 24) >> 24;
}
