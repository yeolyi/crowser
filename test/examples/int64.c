#include <limits.h>
#include <stdio.h>

int main(void) {
    long a = 9007199254740993L;
    unsigned long u = ULONG_MAX;
    printf("%ld %lu %lx\n", a, u, u);
    printf("%ld %ld\n", LONG_MAX, LONG_MIN);
    long m = 3037000499L;
    printf("%ld\n", m * m);
    printf("%ld %ld\n", LONG_MAX / 7, LONG_MAX % 7);
    printf("%lu\n", u >> 1);
    printf("%ld\n", -1L << 62);
    unsigned long h = 14695981039346656037UL;
    for (const char *s = "hash"; *s; s++) {
        h ^= (unsigned char)*s;
        h *= 1099511628211UL;
    }
    printf("%lu\n", h);
    long long ll = LLONG_MIN + 1;
    printf("%lld %d %u\n", ll, (int)a, (unsigned)u);
    printf("%d %d\n", 0x7fffffff + 0 > 0, -1 < 0u);
    printf("%zu %zu %zu\n", sizeof 2147483648, sizeof 0x80000000, sizeof 1u);
    return 0;
}
