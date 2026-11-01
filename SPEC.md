# crowser specification

English · [한국어](./SPEC.ko.md)

What C crowser runs and how. For usage, see the [README](./README.md).

## Reference

The reference is clang. The goal is to behave like a program that clang accepts as standard C17 (`-std=c17 -pedantic-errors`) running on a 64-bit machine. Implementation-defined behavior (signedness of `char`, right shift of negative numbers, an `enum` with only non-negative values being `unsigned`, and so on) follows clang too. Any difference from clang not listed here is a bug.

## Memory and addresses

Memory is a single 16 MB byte array. Each region starts at a fixed address, so you can tell where a value lives from its address alone.

| Address              | Contents                                     |
| -------------------- | -------------------------------------------- |
| `0x100`s             | Your functions (function pointers)           |
| `0xc00`s             | Library functions such as `strcmp`           |
| `0x1000`s            | String literals (`"hi"`)                     |
| from `0x2000`        | Globals and `static` variables               |
| from `0x4000` upward | Heap (`malloc`), higher if globals are large |
| from `0xff…` down    | Stack (locals, 1 MB)                         |

- Heap blocks are laid out back to back in 16-byte units, and freed space is never reused. Addresses never overlap, so a block is never mistaken for another.
- Addresses are the same on every run. Real systems randomize them for security; here the same code always gives the same addresses.
- Uninitialized locals and `malloc`'d memory are filled with `0xcd`. Read as an `int`, that is `-842150451`. If you see it, something was read before it was written.
- Pointer values are held in JavaScript numbers (doubles). Real addresses and sentinels like `(void *)-1` are exact, but bit patterns above 2⁵³ (an uninitialized pointer's `0xcdcdcdcdcdcdcdcd`, say) lose their low bits, and ordering comparisons between such pointers may differ from clang. Dereferencing one stops the program.
- Sizes and layout match 64-bit C: `char` 1, `short` 2, `int` and `float` 4, `long`, `double` and pointers 8 bytes. Struct padding, bit-field placement and `sizeof` match too. `long double` is the same 8 bytes as `double` (as on Apple silicon).

## Not supported

- **A single file.** No `#include "my.h"` and no separate compilation. Only standard headers are accepted.
- **`_Complex`, `_Atomic`, threads and variable-length arrays**: optional in the standard, so `__STDC_NO_COMPLEX__`, `__STDC_NO_VLA__` and friends are defined. An array sized by a variable such as `int a[n]` stops with "array size must be a constant". Use `malloc` for sizes decided at run time.
- **Old K&R function definitions** (`int f(a) int a; { … }`): removed in C23, so not included. `int f()` is accepted as in C17.

## Standard library

Only the functions below exist. Standard names (functions, macros such as `NULL` and `INT_MAX`, types such as `size_t`) are visible only after `#include`-ing their header; without it, the error names the header you need. Library functions can be passed as function pointers too (`strcmp` to `qsort`, say).

| Header     | Functions                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdio.h`  | `printf`, `fprintf` (`stdout`, `stderr`), `sprintf`, `snprintf`, `puts`, `putchar`, `fputs`, `fputc`, `putc`, `fflush`, `getchar` (no input, always `EOF`), files: `fopen`, `fclose`, `fread`, `fwrite`, `fgetc`, `getc`, `fgets`, `ungetc`, `feof`, `ferror`, `fseek`, `ftell`, `rewind`, `remove`                                                                                                   |
| `stdlib.h` | `malloc`, `calloc`, `realloc`, `aligned_alloc`, `free`, `abs`, `labs`, `llabs`, `atoi`, `atol`, `atoll`, `atof`, `strtol`, `strtoll`, `strtoul`, `strtoull`, `strtod`, `rand`, `srand`, `qsort`, `bsearch`, `exit`, `abort`                                                                                                                                                                           |
| `string.h` | `strlen`, `strcmp`, `strncmp`, `strcpy`, `strncpy`, `strcat`, `strncat`, `strchr`, `strrchr`, `strstr`, `memset`, `memcpy`, `memmove`, `memcmp`                                                                                                                                                                                                                                                       |
| `ctype.h`  | `isalnum`, `isalpha`, `iscntrl`, `isdigit`, `isgraph`, `islower`, `isprint`, `ispunct`, `isspace`, `isupper`, `isxdigit`, `tolower`, `toupper`                                                                                                                                                                                                                                                        |
| `math.h`   | `sqrt`, `cbrt`, `pow`, `exp`, `exp2`, `log`, `log10`, `log2`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `fabs`, `floor`, `ceil`, `round`, `trunc`, `fmod`, `hypot`, `fmin`, `fmax`, `fdim`, `fma`, `ldexp`, `copysign`, `isnan`, `isinf`, `isfinite`, `signbit`, plus the `f` (float) and `l` (long double) variants of the floating functions (`sqrtf`, `fabsl`) |
| `time.h`   | `clock`, `time`                                                                                                                                                                                                                                                                                                                                                                                       |
| `assert.h` | `assert`, `static_assert`                                                                                                                                                                                                                                                                                                                                                                             |
| `stdarg.h` | `va_start`, `va_arg`, `va_end`, `va_copy`                                                                                                                                                                                                                                                                                                                                                             |

- `stdbool.h`, `stddef.h`, `stdint.h`, `limits.h`, `float.h`, `iso646.h`, `stdalign.h` and `stdnoreturn.h` provide names only (`true`, `NULL`, `INT_MAX`, `int64_t`, …).
- Files live in memory for the duration of the run, not on a real disk.
- Commonly missed: input (`scanf`), `strtok`, the `vprintf` family.
- `rand` starts from a fixed seed, so every run gives the same numbers, from 0 to `RAND_MAX` (2³¹−1).

## Intentional differences

Mistakes that are undefined behavior in real C, which pass silently or crash somewhere else, stop at the offending line with a message.

| Mistake                          | Message (currently Korean)                          |
| -------------------------------- | --------------------------------------------------- |
| Out-of-bounds index (`a[3]`)     | 배열 a[3]의 범위 밖 인덱스 3입니다                  |
| Past the size given to `malloc`  | malloc 으로 받은 12바이트 밖(0x400c)을 건드렸습니다 |
| `NULL` dereference               | NULL 포인터를 따라갔습니다                          |
| Use after `free`                 | free 한 메모리(0x4000)를 건드렸습니다               |
| Double `free`                    | 같은 메모리를 두 번 free 했습니다                   |
| `free` of a non-`malloc` address | malloc 으로 받지 않은 주소를 free 했습니다          |
| Division by zero                 | 0으로 나눴습니다                                    |

Taking the address one past the end, `&a[n]`, is allowed, as in the standard. The old trick of over-allocating a trailing `data[1]` member is caught as out of bounds; use the standard flexible array member `data[]`.

## Undefined behavior not caught

These pass without stopping.

- **Reading uninitialized values**: values like `-842150451` are used as is.
- **Using the address of a returned function's local**: the old value is still read.
- **Reading past a local array through a pointer**: `a[5]` is caught, but `p[5]` after `int *p = a;` may read another local. On the heap, pointer access is caught too.
- **`int` overflow**: `INT_MAX + 1` becomes `-2147483648`.
- **Modifying a string literal**: `char *s = "hi"; s[0] = 'H';` succeeds. Real C usually crashes.

## Compile errors

Like a real compiler, the whole program is checked before it runs; on an error it reports the line and does not run. Mistakes in functions or branches that never execute are caught as well.

- Syntax: missing `;`, unclosed brackets, invalid type combinations (`unsigned double`)
- Names: undeclared names, redeclaration in the same block, calling a function declared further down, using standard names like `printf`, `NULL` or `size_t` without `#include`-ing their header
- Types: incompatible assignment (`double d = p;`), adding two pointers, comparing structs, using a `void` value, calling with the wrong number of arguments
- `const`: assigning to a `const` variable or member, dropping `const` by storing `const char *` in `char *`
- Other: duplicate `case`, `break` outside a loop, `goto` to a missing label, non-constant global initializers

## Speed and limits

- **Speed** (no recording, `limit: 0`): 100M loop iterations take about 0.3 s, roughly three to four times unoptimized native C (`clang -O0`). Functions using `goto` or varargs (`...`) are tens of times slower, and `long` (64-bit) arithmetic is about ten times slower than `int`.
- **Recording**: each step stores only what changed. Recording 20,000 steps of a 300-node linked list takes about 4.5 MB and 0.6 s.
- **Recursion depth** is bounded by the JavaScript stack: about 400 levels while recording, a few thousand without (varies by browser). Deeper recursion stops with an error.
- **Infinite loops**: by default the run stops after an operation budget (`ops`). With `ops: Infinity` it never stops on its own; cancel it with `runC`'s `signal`.

## Verification

- **Identical output**: every C file in `test/examples` is run with clang and with crowser, and the outputs are compared byte for byte, both recording and not recording.
- **Error reports**: each mistake in the table above has a program in `test/errors` that must stop at exactly that line.
- **Third-party suites**: [GCC torture](https://github.com/gcc-mirror/gcc/tree/master/gcc/testsuite/gcc.c-torture/execute), [c-testsuite](https://github.com/c-testsuite/c-testsuite) and [Writing a C Compiler](https://github.com/nlsandler/writing-a-c-compiler-tests). Only tests that clang accepts as standard C17, that pass under clang, and that are free of undefined behavior (checked with clang's sanitizers) are counted. Results are in the [README](./README.md#conformance).
- **Random programs**: [Csmith](https://github.com/csmith-project/csmith) generates UB-free programs that print a checksum of their globals; `test/fuzz.ts` compares crowser's checksum with clang's, both the fast run and the recording run. Csmith ignores some C17 constraints (comparing pointers to differently qualified types, for instance), so programs clang rejects under `-pedantic-errors` are skipped, after checking that crowser rejects them too.

None of these is a clause-by-clause conformance suite; those exist only as commercial products. So what is verified is "same results as clang", not "conforms to the standard".
