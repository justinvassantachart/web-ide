// Ephemeral C++ Tests entrypoint. The provider hides the user's main function
// in its copied execution plan, leaving this as the program's sole main().
#include "nova_test.h"

int main() {
    ::nova_test::run_all();
    return 0;
}
