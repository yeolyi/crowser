#include <stdio.h>

// 반복마다 블록 안에서 변수를 선언해도 스택이 쌓이지 않는다
int main(void) {
    long sum = 0;
    for (int i = 0; i < 100000; i++) {
        int x = i % 7;
        int a[4] = {x, x + 1};
        sum += a[0] + a[1];
    }
    printf("%ld\n", sum);

    // goto 로 선언 앞으로 돌아가도 같은 자리를 쓴다
    int n = 0;
again:;
    int y = n * 2;
    n++;
    if (n < 50000) goto again;
    printf("%d %d\n", n, y);
    return 0;
}
