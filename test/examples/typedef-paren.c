// typedef 이름 뒤에 ( 가 오는 선언
#include <stdio.h>
typedef int X;
int f(int a) { return a + 1; }
X (*fp)(int) = &f;
int main(void) { X (*g)(int) = f; printf("%d %d\n", fp(1), g(2)); return 0; }
