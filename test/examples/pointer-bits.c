// 포인터와 정수 사이를 오가도 64비트 무늬가 그대로인가
#include <stdint.h>
#include <stdio.h>

#define FAILED ((void *)-1)

void *slot;

void *find(int ok) { return ok ? (void *)&slot : FAILED; }

int main(void) {
  void *p = find(0);
  slot = p;
  void *arr[2] = {p, (void *)0xdeadbeef};
  printf("%d %d %d\n", p == FAILED, slot == FAILED, arr[0] == FAILED);
  printf("%p %p %p\n", FAILED, arr[1], (void *)0x10);
  uintptr_t u = (uintptr_t)arr[0];
  printf("%llu %d\n", (unsigned long long)u, u == UINTPTR_MAX);
  intptr_t i = (intptr_t)p;
  printf("%lld\n", (long long)i);
  unsigned long ul = (unsigned long)(void *)-2;
  printf("%lx %d\n", ul, (void *)ul == (void *)-2);
  printf("%d\n", find(1) != FAILED);
  return 0;
}
