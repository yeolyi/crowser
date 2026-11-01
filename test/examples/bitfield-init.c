// 비트 필드와 중괄호를 생략한 초기화
#include <stdio.h>

struct Flags {
  unsigned ready : 1;
  unsigned mode : 3;
  int delta : 4;
  unsigned : 0;
  unsigned long big : 40;
  _Bool on : 1;
};

struct Pixel {
  unsigned char r : 5, g : 6, b : 5;
};

union U {
  int x : 3;
  char c;
};

struct Inner { int a[2]; int b; };
struct Outer { struct Inner in[2]; char name[4]; };

int main(void) {
  struct Flags f = {1, 5, -3, 0x123456789aUL, 7};
  printf("%zu %u %u %d %lx %d\n", sizeof f, f.ready, f.mode, f.delta, f.big, f.on);
  f.mode += 6;
  f.delta = 9;
  f.ready++;
  printf("%u %d %u\n", f.mode, f.delta, f.ready);
  struct Pixel p = {31, 63, 1};
  printf("%zu %d %d %d\n", sizeof p, p.r, p.g, p.b);
  p.g = p.r + 40;
  printf("%d %d\n", p.g, p.b);
  union U u = {5};
  printf("%zu %d\n", sizeof u, u.x);
  int m[2][3] = {1, 2, 3, 4, 5};
  int n[][2] = {1, 2, 3};
  printf("%d %d %d %zu\n", m[0][2], m[1][1], m[1][2], sizeof n / sizeof n[0]);
  struct Outer o = {1, 2, 3, {4, 5, 6}, "hi"};
  printf("%d %d %d %d %d %d %s\n", o.in[0].a[0], o.in[0].a[1], o.in[0].b, o.in[1].a[0], o.in[1].a[1], o.in[1].b, o.name);
  struct Outer q = {.in[1].b = 9, .name = "x"};
  printf("%d %s\n", q.in[1].b, q.name);
  struct Inner arr[] = {{1}, 2, 3, 4, [3].b = 8};
  printf("%zu %d %d %d\n", sizeof arr / sizeof arr[0], arr[1].a[0], arr[1].b, arr[3].b);
  return 0;
}
