// 오류 6
#include <stdio.h>
struct Node { int value; struct Node *next; };
int main(void) {
    struct Node *p = NULL;
    printf("%d\n", p->value);
    return 0;
}
