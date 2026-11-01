// math.h 의 float(f)·long double(l) 판
#include <math.h>
#include <stdio.h>
int main(void) {
  float f = 2.0f;
  float (*fp)(float) = sqrtf;
  printf("%.9g %.9g %.9g %.9g\n", sqrtf(f), fabsf(-1.5f), fp(3.0f), (double)sinf(1.0f));
  printf("%.17g %.9g %zu %zu\n", (double)sqrtl(2.0L), powf(2.0f, 0.5f), sizeof(sqrtf(1)), sizeof(fabsl(1.0)));
  return 0;
}
