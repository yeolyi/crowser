// 크기 없는 마지막 멤버(유연한 배열 멤버)
#include <stdio.h>
#include <stdlib.h>
struct Buf { int n; int data[]; };
int main(void) {
  struct Buf *b = malloc(sizeof(struct Buf) + 4 * sizeof(int));
  b->n = 4;
  for (int i = 0; i < b->n; i++) b->data[i] = i * 10;
  printf("%zu %d %d\n", sizeof(struct Buf), b->data[3], -7 >> 1);
  free(b);
  return 0;
}
