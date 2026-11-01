// 매크로를 펼친 결과는 뒤 글과 이어 다시 읽는다, #line
#include <stdio.h>
#define CAT2(a, b) a##b
#define CAT(a, b) CAT2(a, b)
#define AB(x) CAT(x, y)
#define ID(x) x
#define APPLY(m, v) m(v)
#define SQ(x) ((x) * (x))
int line_here; extern const char *file_here;
int main(void) {
  int xy = 42, z = 3;
  printf("%d\n", CAT(A, B)(x));
  printf("%d %d\n", APPLY(SQ, z + 1), ID(SQ)(4));
  printf("%d %s\n", line_here, file_here);
  return 0;
}
#define NUM 100
#line NUM "renamed.c"
int line_here = __LINE__;
const char *file_here = __FILE__;
