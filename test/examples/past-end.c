// 배열 끝 바로 다음 자리의 주소(&b[3])는 얻을 수 있다
#include <stdio.h>

int main(void) {
  int b[] = {1, 2, 3};
  for (int *p = &b[3]; p-- > b;) printf("%d", *p);
  printf("\n");
  return 0;
}
