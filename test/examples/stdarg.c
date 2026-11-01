#include <stdarg.h>
#include <stdio.h>

struct Pair {
    int a;
    long b;
};

// 개수를 먼저 받고 그만큼 더한다
int sum(int n, ...) {
    va_list ap;
    va_start(ap, n);
    int total = 0;
    for (int i = 0; i < n; i++) total += va_arg(ap, int);
    va_end(ap);
    return total;
}

// 형식 글자에 따라 다른 타입을 꺼낸다
void show(const char *kinds, ...) {
    va_list ap;
    va_start(ap, kinds);
    for (const char *k = kinds; *k; k++) {
        if (*k == 'i') printf("%d ", va_arg(ap, int));
        if (*k == 'l') printf("%ld ", va_arg(ap, long));
        if (*k == 'd') printf("%.2f ", va_arg(ap, double));
        if (*k == 's') printf("%s ", va_arg(ap, char *));
        if (*k == 'c') printf("%c ", va_arg(ap, int));
        if (*k == 'p') {
            struct Pair p = va_arg(ap, struct Pair);
            printf("{%d %ld} ", p.a, p.b);
        }
    }
    va_end(ap);
    printf("\n");
}

int main(void) {
    printf("%d\n", sum(4, 1, 2, 3, 4));
    float f = 1.5f;
    char c = 'z';
    struct Pair p = {7, 9000000000L};
    show("ildscp", -3, 1L << 40, f, "hi", c, p);
    return 0;
}
