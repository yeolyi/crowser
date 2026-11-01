# crowser 명세

[English](./SPEC.md) · 한국어

crowser가 어떤 C를 어떻게 돌리는지 적었습니다. 쓰는 법은 [README](./README.ko.md)에 있습니다.

## 기준

기준은 clang입니다. clang이 C17 표준 코드로 받는 프로그램(`-std=c17 -pedantic-errors`)을 64비트 컴퓨터에서 돌린 결과와 같게 동작하는 것이 목표입니다. 표준이 컴파일러에 맡긴 부분(`char`의 부호, 음수 오른쪽 시프트, 값이 모두 0 이상인 `enum`이 `unsigned`인 것 등)도 clang을 따릅니다. 아래에 적지 않은 것에서 clang과 결과가 다르면 고칠 문제입니다.

## 메모리와 주소

메모리는 16MB 바이트 배열 하나입니다. 주소만 보고도 어디 있는 값인지 알 수 있게 영역마다 시작 주소를 정해 두었습니다.

| 주소               | 들어 있는 것                      |
| ------------------ | --------------------------------- |
| `0x100`대          | 직접 만든 함수(함수 포인터)       |
| `0xc00`대          | `strcmp` 같은 표준 함수           |
| `0x1000`대         | 문자열 리터럴(`"hi"`)             |
| `0x2000`부터       | 전역 변수, `static` 변수          |
| `0x4000`부터 위로  | 힙(`malloc`). 전역이 크면 더 위로 |
| `0xff…`에서 아래로 | 스택(지역 변수, 1MB)              |

- 힙 블록은 16바이트 단위로 이어 붙고, `free` 한 자리를 다시 주지 않습니다. 주소가 겹치지 않아 어느 블록인지 헷갈리지 않습니다.
- 실행할 때마다 주소가 같습니다. 진짜 컴퓨터는 보안을 위해 실행마다 주소를 섞지만, 여기서는 같은 코드면 같은 주소가 나옵니다.
- 초기화하지 않은 지역 변수와 `malloc` 한 메모리는 모든 바이트가 `0xcd`입니다. `int`로 읽으면 `-842150451`이 나옵니다. 이 값이 보이면 값을 넣기 전에 읽은 것입니다.
- 크기와 배치는 64비트 C와 같습니다: `char` 1, `short` 2, `int`·`float` 4, `long`·`double`·포인터 8바이트. struct 의 빈칸, 비트 필드의 자리, `sizeof`도 같습니다. `long double`은 `double`과 같은 8바이트입니다(애플 실리콘 맥과 같습니다).

## 빠진 것

- **파일이 하나뿐입니다.** `#include "내파일.h"`와 여러 파일 나눠 컴파일하기는 없습니다. 표준 헤더만 받습니다.
- **복소수(`_Complex`), `_Atomic`, 스레드, 가변 길이 배열**: 표준이 없어도 되게 둔 기능이라 `__STDC_NO_COMPLEX__`, `__STDC_NO_VLA__` 등을 정의해 두었습니다. `int a[n]`처럼 크기가 변수인 배열은 "배열 크기는 상수여야 합니다"로 멈춥니다. 크기를 실행 중에 정하려면 `malloc`을 씁니다.
- **옛 K&R 함수 정의**(`int f(a) int a; { … }`): C23에서 없어진 문법이라 넣지 않습니다. `int f()`는 C17대로 받습니다.

## 표준 라이브러리

아래 함수만 있습니다. 표준 이름(함수, `NULL`·`INT_MAX` 같은 매크로, `size_t` 같은 타입)은 그 헤더를 `#include` 해야 보이고, 없으면 필요한 헤더를 알려 줍니다. 표준 함수도 함수 포인터로 넘길 수 있습니다(`qsort`에 `strcmp`처럼).

| 헤더       | 함수                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdio.h`  | `printf`, `fprintf`(`stdout`·`stderr`), `sprintf`, `snprintf`, `puts`, `putchar`, `fputs`, `fputc`, `putc`, `fflush`, `getchar`(입력이 없어 늘 `EOF`), 파일: `fopen`, `fclose`, `fread`, `fwrite`, `fgetc`, `getc`, `fgets`, `ungetc`, `feof`, `ferror`, `fseek`, `ftell`, `rewind`, `remove`       |
| `stdlib.h` | `malloc`, `calloc`, `realloc`, `aligned_alloc`, `free`, `abs`, `labs`, `llabs`, `atoi`, `atol`, `atoll`, `atof`, `strtol`, `strtoll`, `strtoul`, `strtoull`, `strtod`, `rand`, `srand`, `qsort`, `bsearch`, `exit`, `abort`                                                                         |
| `string.h` | `strlen`, `strcmp`, `strncmp`, `strcpy`, `strncpy`, `strcat`, `strncat`, `strchr`, `strrchr`, `strstr`, `memset`, `memcpy`, `memmove`, `memcmp`                                                                                                                                                     |
| `ctype.h`  | `isalnum`, `isalpha`, `iscntrl`, `isdigit`, `isgraph`, `islower`, `isprint`, `ispunct`, `isspace`, `isupper`, `isxdigit`, `tolower`, `toupper`                                                                                                                                                      |
| `math.h`   | `sqrt`, `cbrt`, `pow`, `exp`, `exp2`, `log`, `log10`, `log2`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `fabs`, `floor`, `ceil`, `round`, `trunc`, `fmod`, `hypot`, `fmin`, `fmax`, `fdim`, `fma`, `ldexp`, `copysign`, `isnan`, `isinf`, `isfinite`, `signbit` |
| `time.h`   | `clock`, `time`                                                                                                                                                                                                                                                                                     |
| `assert.h` | `assert`, `static_assert`                                                                                                                                                                                                                                                                           |
| `stdarg.h` | `va_start`, `va_arg`, `va_end`, `va_copy`                                                                                                                                                                                                                                                           |

- `stdbool.h`, `stddef.h`, `stdint.h`, `limits.h`, `float.h`, `iso646.h`, `stdalign.h`, `stdnoreturn.h`는 이름(`true`, `NULL`, `INT_MAX`, `int64_t` 등)만 들어 있습니다.
- 파일은 진짜 디스크가 아니라 실행 동안만 있는 메모리 안 파일입니다.
- 자주 찾을 만한데 없는 것은 입력(`scanf`), `strtok`, `vprintf` 무리입니다.
- `rand`는 정해진 씨앗에서 시작해 실행마다 같은 수가 나옵니다. 0부터 `RAND_MAX`(2³¹−1)까지입니다.

## 일부러 다르게 한 것

진짜 C에선 정의되지 않은 동작이라 아무 일 없이 지나가거나 엉뚱한 곳에서 터지는 실수를, 그 줄에서 멈추고 알립니다.

| 실수                             | 알려 주는 말                                        |
| -------------------------------- | --------------------------------------------------- |
| 배열 밖 인덱스(`a[3]`)           | 배열 a[3]의 범위 밖 인덱스 3입니다                  |
| `malloc`으로 받은 크기 밖        | malloc 으로 받은 12바이트 밖(0x400c)을 건드렸습니다 |
| NULL 따라가기                    | NULL 포인터를 따라갔습니다                          |
| `free` 한 뒤 쓰기                | free 한 메모리(0x4000)를 건드렸습니다               |
| 두 번 `free`                     | 같은 메모리를 두 번 free 했습니다                   |
| `malloc`으로 받지 않은 주소 free | malloc 으로 받지 않은 주소를 free 했습니다          |
| 0으로 나누기                     | 0으로 나눴습니다                                    |

`a[n]`처럼 끝 바로 다음 자리는 `&a[n]`으로 주소만 얻는 것은 됩니다. 표준에서도 되는 일입니다. struct 끝의 `data[1]`을 더 길게 쓰는 옛 방식은 범위 밖으로 잡습니다. 표준 방식인 `data[]`(크기 없는 마지막 멤버)를 씁니다.

## 알아채지 못하는 정의되지 않은 동작

이런 실수는 멈추지 않고 지나갑니다.

- **초기화하지 않은 값 읽기**: `-842150451` 같은 값을 그대로 씁니다.
- **끝난 함수의 지역 변수 주소 쓰기**: 옛 값이 그대로 읽힙니다.
- **포인터로 지역 배열 밖 읽기**: `a[5]`는 잡지만 `int *p = a;` 뒤의 `p[5]`는 다른 지역 변수를 읽을 수 있습니다. 힙은 포인터로 읽어도 잡습니다.
- **`int` 넘침**: `INT_MAX + 1`은 `-2147483648`이 됩니다.
- **문자열 리터럴 고치기**: `char *s = "hi"; s[0] = 'H';`가 그대로 됩니다. 진짜 C에선 보통 프로그램이 죽습니다.

## 컴파일 오류

진짜 컴파일러처럼 실행하기 전에 코드 전체를 검사하고, 틀린 곳이 있으면 그 줄을 알리고 실행하지 않습니다. 한 번도 실행하지 않는 함수나 갈래에 든 실수도 잡습니다.

- 문법: 빠진 `;`, 닫히지 않은 괄호, 없는 타입 조합(`unsigned double`)
- 이름: 선언하지 않은 이름, 같은 블록에서 두 번 선언, 아래에서 선언한 함수를 위에서 부르기, 헤더를 `#include` 하지 않고 `printf`·`NULL`·`size_t` 같은 표준 이름 쓰기
- 타입: 맞지 않는 대입(`double d = p;`), 포인터끼리 더하기, 구조체로 비교하기, `void` 값 쓰기, 인자 수가 다른 함수 부르기
- `const`: `const` 변수나 멤버에 대입하기, `const char *`를 `char *`에 넣어 `const` 떼어 내기
- 그 밖: 겹치는 `case`, 반복 밖의 `break`, 없는 레이블로 `goto`, 상수가 아닌 전역 초깃값

## 속도와 한도

- **속도**(기록 없이, `limit: 0`): 반복 1억 번에 약 0.3초로, 최적화 없이 컴파일한 진짜 C(`clang -O0`)의 서너 배쯤 걸립니다. `goto`나 가변 인자(`...`)를 쓰는 함수는 수십 배, `long`(64비트) 계산은 `int`보다 열 배쯤 느립니다.
- **기록**: 단계마다 바뀐 것만 담습니다. 노드 300개짜리 연결 리스트를 2만 단계 기록하면 약 4.5MB, 0.6초입니다.
- **재귀 깊이**: JavaScript 스택이 정합니다. 기록하며 돌 때 약 400단계, 기록 없이 수천 단계입니다(브라우저마다 다릅니다). 더 깊으면 "재귀가 너무 깊어 멈췄습니다"로 멈춥니다.
- **끝나지 않는 반복**: 기본은 연산 수(`ops`)로 멈춥니다. `ops: Infinity`면 멈추지 않고, `runC`의 `signal`로 끊습니다.

## 검증

- **같은 출력**: 예제 C 파일들(`test/examples`)을 clang으로 돌린 출력과 crowser의 출력을 글자 하나까지 비교합니다. 기록하며 돌 때와 기록 없이 돌 때 둘 다 봅니다.
- **실수 알림**: 위 표의 실수를 하나씩 담은 코드(`test/errors`)가 정확히 그 줄에서 멈추는지 확인합니다.
- **남이 만든 시험**: [GCC torture](https://github.com/gcc-mirror/gcc/tree/master/gcc/testsuite/gcc.c-torture/execute), [c-testsuite](https://github.com/c-testsuite/c-testsuite), [Writing a C Compiler](https://github.com/nlsandler/writing-a-c-compiler-tests) 시험을 돌립니다. clang이 표준 C17로 받고, clang으로 돌려도 통과하며, 정의되지 않은 동작이 없는(clang 검사기로 확인) 것만 셉니다. 결과는 [README](./README.ko.md#표준-적합성)에 있습니다.

이 시험들은 표준 조항을 하나하나 옮긴 적합성 시험이 아닙니다. 그런 시험은 상용 제품뿐입니다. 그래서 "표준을 따른다"가 아니라 "clang과 같은 결과를 낸다"를 확인합니다.
