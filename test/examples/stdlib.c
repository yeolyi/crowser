#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int cmp(const void *a, const void *b) {
    return *(const int *)a - *(const int *)b;
}

int main(void) {
    int a[] = {5, 3, 9, 1, 7, 3};
    qsort(a, 6, sizeof a[0], cmp);
    for (int i = 0; i < 6; i++) printf("%d ", a[i]);
    int key = 7;
    int *hit = bsearch(&key, a, 6, sizeof a[0], cmp);
    printf("| %td\n", hit - a);

    char buf[32];
    int n = sprintf(buf, "%s-%03d", "id", 42);
    printf("%s %d %zu\n", buf, n, strlen(buf));
    snprintf(buf, 5, "%d", 123456);
    printf("%s\n", buf);

    const char *s = "hello, world";
    printf("%s|%s|%s\n", strchr(s, 'o'), strrchr(s, 'o'), strstr(s, "wor"));
    char *end;
    long v = strtol("  -0x1f rest", &end, 0);
    printf("%ld [%s] %d %.2f\n", v, end, atoi("123abc"), atof("2.5e1"));

    char t[8] = "abc";
    strncat(t, "defgh", 2);
    memmove(t + 1, t, 3);
    printf("%s\n", t);

    printf("%.3f %.3f %.3f %.1f %.1f\n", fmod(7.5, 2), atan2(1, 1), hypot(3, 4),
           trunc(-2.7), round(-2.5));
    fprintf(stdout, "done %d\n", isnan(NAN));
    return 0;
}
