// 오류 6
#include <stdio.h>

void never(void) {
  int *p = 0;
  double d = p;
}

int main(void) {
  printf("hi\n");
  return 0;
}
