// #if 식: 64비트, unsigned, 접미사, 문자 상수
#include <stdio.h>
#include <limits.h>
#if ULONG_MAX != 18446744073709551615ull
#error ulong
#endif
#if -1 > 0u
int a = 1;
#else
int a = 2;
#endif
#if 'A' == 65 && '\n' == 10 && '\xff' < 0 && (0 && 1/0) == 0 && (1 ? 2 : 1/0) == 2
int b = 1;
#endif
#if 0x7fffffffffffffff + 0 > 0 && (1 << 40) == 1099511627776 && UNDEFINED_NAME == 0
int c = 1;
#endif
#define L 5
int main(void) { printf("%d %d %d %d %d\n", a, b, c, L'1' == '1', L); return 0; }
