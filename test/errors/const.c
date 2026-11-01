// 오류 5
#include <string.h>

void upper(const char *s) {
  char *t = s;
  t[0] = 'A';
}

int main(void) {
  char name[] = "kim";
  upper(name);
  return 0;
}
