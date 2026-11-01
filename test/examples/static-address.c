// 전역 초깃값으로 쓰는 주소 상수: 다차원 배열의 칸·줄, 구조체의 배열 멤버
#include <stdio.h>
struct S { int a[3]; int b; };
static int g[2][3][4];
static struct S s = {{1, 2, 3}, 4};
static int *p1 = &g[1][2][3];
static int (*p2)[4] = g[1];
static int *p3 = g[1][2];
static int *p4 = s.a;
static int *p5 = &s.a[2];
static int **pp[2] = {&p1, &p3};
int main(void) {
  *p1 = 7; p3[1] = 8;
  printf("%d %d %d %d %d %d\n", g[1][2][3], g[1][2][1], (int)(p2 - g[0]), p4[1], *p5, **pp[1]);
  return 0;
}
