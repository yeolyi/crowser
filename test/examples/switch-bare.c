// 본문이 { } 가 아닌 switch
#include <stdio.h>
int f(int x) {
  switch (x) case 0: return 10;
  switch (x) default: printf("d%d ", x);
  switch (x) ;
  switch (x) case 1: switch (x) { case 1: printf("in "); }
  switch (x)
    case 2:
      x += 100;
  return x;
}
int main(void) { printf("%d %d %d\n", f(0), f(1), f(2)); return 0; }
