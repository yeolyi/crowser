#include <stdio.h>
int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main(void) {
    printf("%d %d\n", fact(10), fib(15));
    char s[] = "hi";
    return 0;
}
