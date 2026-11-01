#include <stdio.h>
#include <stdlib.h>

struct Node {
    int value;
    struct Node *next;
};

// 맨 앞에 새 노드 넣기
struct Node *push(struct Node *head,
                  int value) {
    struct Node *node =
        malloc(sizeof(struct Node));
    node->value = value;
    node->next = head;
    return node;
}

int main(void) {
    struct Node *head = NULL;
    head = push(head, 30);
    head = push(head, 20);
    head = push(head, 10);

    // 처음부터 따라가며 읽기
    struct Node *p = head;
    while (p != NULL) {
        printf("%d\n", p->value);
        p = p->next;
    }
    return 0;
}
