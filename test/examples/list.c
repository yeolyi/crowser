#include <stdio.h>
#include <stdlib.h>

struct Node {
    int value;
    struct Node *next;
};

struct Node *push(struct Node *head, int value) {
    struct Node *node = malloc(sizeof(struct Node));
    node->value = value;
    node->next = head;
    return node;
}

int main(void) {
    struct Node *head = NULL;
    for (int i = 1; i <= 3; i++) {
        head = push(head, i * 10);
    }
    struct Node *p = head;
    while (p != NULL) {
        printf("%d\n", p->value);
        p = p->next;
    }
    return 0;
}
