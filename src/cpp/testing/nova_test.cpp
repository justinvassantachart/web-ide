// Nova IDE test framework — single-TU definitions.
#include "nova_test.h"

namespace nova_test {

std::vector<Entry>& registry() {
    static std::vector<Entry> r;
    return r;
}

bool& current_failed() {
    static bool f = false;
    return f;
}

}  // namespace nova_test
