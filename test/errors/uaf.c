// 오류 6
#include <stdlib.h>
int main(void) {
    int *p = malloc(sizeof(int));
    free(p);
    *p = 5;
    return 0;
}
