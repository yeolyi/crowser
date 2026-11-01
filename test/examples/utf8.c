#include <stdio.h>
#include <string.h>

int main(void) {
    char *fruit = "🍎";
    char word[] = "안녕";
    printf("%s %s\n", fruit, word);
    printf("%zu %zu %zu\n", strlen(fruit), strlen(word), sizeof(word));
    return 0;
}
