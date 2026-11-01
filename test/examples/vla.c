// 가변 길이 배열과, 크기가 앞 매개변수에 달린 배열 매개변수
#include <stdio.h>

void show(int n, int m, int a[n][m]) {
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < m; j++) printf("%d ", a[i][j]);
    printf("| %zu\n", sizeof a[i]);
  }
}

int main(void) {
  int n = 2, m = 3;
  int a[n][m];
  for (int i = 0; i < n * m; i++) a[i / m][i % m] = i * i;
  show(n, m, a);
  printf("%zu\n", sizeof a);
  int b[] = {1, 2, 3};
  for (int *p = &b[3]; p-- > b;) printf("%d", *p);
  printf("\n");
  return 0;
}
