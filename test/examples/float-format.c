// printf 의 %a·큰 %f, fma 는 한 번만 반올림
#include <stdio.h>
#include <math.h>
int main(void) {
  double xs[] = {1.0, 0.125, 3.14159, -2.5e-310, 1e300, 0.1, 255.5, 0.0};
  for (int i = 0; i < 8; i++) printf("%a %A %.2a %.0a %.15a %f\n", xs[i], xs[i], xs[i], xs[i], xs[i], xs[i] > 1e200 ? 1e22 : xs[i]);
  printf("%.17g %.17g %.17g\n", fma(5.0, 1E22, 4000000.0), fma(0.1, 10, -1), fma(1e308, 10, -1e308));
  printf("%f %.0f %.3f\n", 1e22, 123456789012345678901234567890.0, 2.0e25);
  return 0;
}
