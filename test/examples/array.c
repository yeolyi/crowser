#include <stdio.h>
#define N 5
int sum(int *a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
int main(void) {
    int a[N] = {3, 1, 4, 1, 5};
    int *p = a + 2;
    printf("%d %d %ld\n", sum(a, N), *p, sizeof(a));
    return 0;
}
