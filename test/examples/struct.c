#include <stdio.h>
#include <stdlib.h>
struct Point { int x; int y; };
struct Stack { int items[8]; int top; };
void push(struct Stack *s, int v) { s->items[s->top++] = v; }
int pop(struct Stack *s) { return s->items[--s->top]; }
int main(void) {
    struct Point p;
    p.x = 3; p.y = 4;
    struct Point q = p;
    q.x = 10;
    struct Stack st;
    st.top = 0;
    for (int i = 0; i < 5; i++) push(&st, i * i);
    while (st.top > 0) printf("%d ", pop(&st));
    printf("\n%d %d %d %lu\n", p.x, q.x, q.y, sizeof(struct Stack));
    int *heap = malloc(4 * sizeof(int));
    for (int i = 0; i < 4; i++) heap[i] = i + 100;
    printf("%d\n", heap[3]);
    free(heap);
    return 0;
}
