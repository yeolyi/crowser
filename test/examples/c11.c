// C11: _Static_assert, _Generic, _Alignof, offsetof
#include <assert.h>
#include <stdio.h>
_Static_assert(sizeof(int) == 4, "int");

#define T(x) _Generic((x), int: "int", double: "double", char *: "str", default: "other")

#include <stdalign.h>
#include <stddef.h>
struct S { char c; double d; int i; };

int main(void) {
  static_assert(1, "x");
  char *s = "a";
  printf("%s %s %s %s\n", T(1), T(1.0), T(s), T(1L));
  _Alignas(16) int x = 1;
  printf("%zu %zu %zu %zu %d\n", _Alignof(double), alignof(struct S), offsetof(struct S, i), offsetof(struct S, d), x);
  return 0;
}
