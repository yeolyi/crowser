#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
int main(void) {
  double (*f)(double) = sqrt;
  int (*p)(const char *, ...) = printf;
  p("%.1f\n", f(2.25));
  char *w[] = {"pear", "apple", "fig"};
  qsort(w, 3, sizeof w[0], cmp);
  printf("%s %s %s\n", w[0], w[1], w[2]);
  int (*c)(const char *, const char *) = strcmp;
  printf("%d\n", c("a", "b") < 0);
  return 0;
}
