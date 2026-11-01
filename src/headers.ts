// 표준 헤더가 주는 이름. 헤더를 include 해야 그 이름(함수·타입·매크로)이 보인다.
// 여러 헤더가 같이 주는 이름(NULL, size_t)은 그중 하나만 include 해도 된다
// math.h 의 실수 함수. 이름 끝에 f 를 붙이면 float, l 을 붙이면 long double(= double) 판
export const MATH =
  "sqrt fabs floor ceil round trunc sin cos tan asin acos atan sinh cosh tanh exp exp2 log log10 log2 cbrt pow fmod atan2 hypot fmin fmax fdim copysign fma ldexp".split(
    " ",
  );
export const MATH_FL = MATH.flatMap((f) => [`${f}f`, `${f}l`]);

export const HEADER_NAMES: Record<string, string> = {
  "stdio.h":
    "printf fprintf sprintf snprintf puts putchar fputs fputc putc fflush getchar " +
    "fopen fclose fread fwrite fgetc getc fgets ungetc feof ferror rewind fseek ftell remove " +
    "FILE size_t stdin stdout stderr NULL EOF SEEK_SET SEEK_CUR SEEK_END FOPEN_MAX FILENAME_MAX",
  "stdlib.h":
    "malloc calloc realloc aligned_alloc free abs labs llabs atoi atol atoll atof " +
    "strtol strtoll strtoul strtoull strtod rand srand qsort bsearch exit abort " +
    "size_t wchar_t NULL EXIT_SUCCESS EXIT_FAILURE RAND_MAX",
  "string.h":
    "strlen strcmp strncmp strcpy strncpy strcat strncat strchr strrchr strstr " +
    "memset memcpy memmove memcmp size_t NULL",
  "ctype.h":
    "isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper",
  "math.h":
    "sqrt cbrt pow exp exp2 log log10 log2 sin cos tan asin acos atan atan2 sinh cosh tanh " +
    "fabs floor ceil round trunc fmod hypot fmin fmax fdim fma ldexp copysign " +
    "isnan isinf isfinite signbit INFINITY HUGE_VAL NAN " +
    MATH_FL.join(" "),
  "time.h": "clock time clock_t time_t size_t NULL CLOCKS_PER_SEC",
  "assert.h": "assert static_assert",
  "stdarg.h": "va_list va_start va_arg va_end va_copy",
  "stddef.h": "size_t ptrdiff_t wchar_t max_align_t NULL offsetof",
  "stdbool.h": "bool true false",
  "stdalign.h": "alignof alignas",
  "stdnoreturn.h": "noreturn",
  "iso646.h": "",
  "limits.h":
    "CHAR_BIT CHAR_MAX CHAR_MIN SCHAR_MAX SCHAR_MIN UCHAR_MAX SHRT_MAX SHRT_MIN USHRT_MAX " +
    "INT_MAX INT_MIN UINT_MAX LONG_MAX LONG_MIN ULONG_MAX LLONG_MAX LLONG_MIN ULLONG_MAX MB_LEN_MAX",
  "float.h":
    "FLT_RADIX FLT_MANT_DIG DBL_MANT_DIG FLT_DIG DBL_DIG FLT_MAX FLT_MIN FLT_EPSILON DBL_MAX DBL_MIN DBL_EPSILON",
  "stdint.h": [
    "intptr_t uintptr_t intmax_t uintmax_t SIZE_MAX PTRDIFF_MAX PTRDIFF_MIN",
    "INTPTR_MAX INTPTR_MIN UINTPTR_MAX INTMAX_MAX INTMAX_MIN UINTMAX_MAX",
    ...["8", "16", "32", "64"].map(
      (n) =>
        `int${n}_t uint${n}_t int_least${n}_t uint_least${n}_t int_fast${n}_t uint_fast${n}_t INT${n}_MAX INT${n}_MIN UINT${n}_MAX`,
    ),
  ].join(" "),
};

export const HEADERS = Object.keys(HEADER_NAMES);

// 이름 → 그 이름을 주는 헤더들
const HOME = new Map<string, string[]>();
for (const [h, names] of Object.entries(HEADER_NAMES))
  for (const name of names.split(" ").filter(Boolean))
    HOME.set(name, [...(HOME.get(name) ?? []), h]);

/** 헤더가 주는 이름이면 그 헤더들, 아니면 undefined */
export const headersOf = (name: string) => HOME.get(name);

/** included 로 이 이름이 보이는가(헤더와 상관없는 이름은 늘 보인다) */
export const visible = (name: string, included: ReadonlySet<string>) =>
  HOME.get(name)?.some((h) => included.has(h)) ?? true;

/** 안 보이는 이름의 오류 말에 붙일 안내 */
export const needs = (name: string) => {
  const hs = HOME.get(name);
  return hs ? `(#include <${hs[0]}> 가 필요합니다)` : "";
};
