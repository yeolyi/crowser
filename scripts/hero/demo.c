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
    head = push(head, 30);
    head = push(head, 20);
    head = push(head, 10);

    for (struct Node *p = head; p; p = p->next)
        printf("%d\n", p->value);

    while (head) {
        struct Node *next = head->next;
        free(head);
        head = next;
    }
    return 0;
}
