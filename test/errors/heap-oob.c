// 오류 6
#include <stdlib.h>
int main(void) {
    int *p = malloc(3 * sizeof(int));
    p[2] = 1;
    p[3] = 1;
    return 0;
}
