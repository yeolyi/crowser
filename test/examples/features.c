#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int x, y; } Point;
enum Color { RED, GREEN = 5, BLUE };
#define SQUARE(a) ((a) * (a))

Point add(Point a, Point b) {
    Point r = {a.x + b.x, a.y + b.y};
    return r;
}
int twice(int v) { return v * 2; }
int apply(int (*f)(int), int v) { return f(v); }
int counter(void) {
    static int n = 0;
    return ++n;
}

int main(void) {
    Point p = add((Point){1, 2}, (Point){3, 4});
    printf("%d %d\n", p.x, p.y);
    printf("%d %d %d\n", RED, GREEN, BLUE);
    printf("%d\n", SQUARE(3 + 1));
    printf("%d\n", apply(twice, 21));
    counter();
    counter();
    printf("%d\n", counter());
    double d = 1.0 / 3;
    printf("%.3f %g %e\n", d, 2.5, 12345.678);
    char s[16];
    strcpy(s, "hi");
    strcat(s, " there");
    printf("%s %zu\n", s, strlen(s));
    int a[5] = {[2] = 7, 9};
    for (int i = 0; i < 5; i++) printf("%d ", a[i]);
    printf("\n");
    switch (p.x) {
    case 4:
        printf("four\n");
    case 5:
        printf("fall\n");
        break;
    default:
        printf("no\n");
    }
    unsigned char c = 250;
    c += 10;
    printf("%u %x %08.3f|%-4d|\n", c, -1, 3.14159, 7);
    return 0;
}
