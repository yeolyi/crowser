// 오류 3
#include <stdio.h>
int depth(int n) { return n == 0 ? 0 : 1 + depth(n - 1); }
int main(void) {
    printf("%d\n", depth(100000));
    return 0;
}
