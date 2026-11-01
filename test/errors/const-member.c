// 오류 9
struct account {
  const int id;
  int balance;
};

int main(void) {
  struct account a = { 1, 100 };
  a.id = 2;
  return 0;
}
