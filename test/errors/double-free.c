// 오류 6
#include <stdlib.h>
int main(void) {
    int *p = malloc(4);
    free(p);
    free(p);
    return 0;
}
