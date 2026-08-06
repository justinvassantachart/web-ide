#pragma once

// Nova IDE student testing framework. Declare a test with STUDENT_TEST("name"),
// then call EXPECT_EQUALS(actual, expected) or EXPECT(condition) inside it.
// Results stream out as stdout markers that the C++ TestProvider translates.

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace nova_test {

struct Entry {
    const char* name;
    void (*func)();
};

// Defined in nova_test.cpp (single-TU) to avoid duplicate COMDAT static
// locals across multi-file builds, which corrupt wasm-ld's DWARF tables.
std::vector<Entry>& registry();
bool& current_failed();

struct Registrar {
    Registrar(const char* name, void (*func)()) { registry().push_back({name, func}); }
};

template <typename T>
inline std::string to_str(const T& v) {
    std::ostringstream o;
    o << v;
    return o.str();
}
inline std::string to_str(const std::string& v) { return std::string("\"") + v + "\""; }
inline std::string to_str(const char* v) {
    return v ? std::string("\"") + v + "\"" : std::string("nullptr");
}
inline std::string to_str(char* v) { return to_str(static_cast<const char*>(v)); }
inline std::string to_str(bool v) { return v ? "true" : "false"; }

// Escape characters that would break the marker-line wire format. `|` is the
// field delimiter and `\` is the escape character, so both are mandatory;
// `\n` and `\r` are escaped so a multi-line value cannot become a new marker.
inline std::string escape(const std::string& s) {
    std::string o;
    o.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '|':  o += "\\p"; break;
            default:   o += c;
        }
    }
    return o;
}

inline void emit(const char* kind, const std::string& payload) {
    std::cout << "###NOVA_TEST###|~|" << kind << "|~|" << payload << "\n" << std::flush;
}

template <typename A, typename B>
void check_eq(const A& actual, const B& expected,
              const char* actual_expr, const char* expected_expr,
              const char* file, int line) {
    bool ok = (actual == expected);
    if (!ok) current_failed() = true;
    std::ostringstream p;
    p << file << "|~|" << line << "|~|" << (ok ? "PASS" : "FAIL") << "|~|"
      << escape(actual_expr) << "|~|" << escape(expected_expr) << "|~|"
      << escape(to_str(actual)) << "|~|" << escape(to_str(expected));
    emit("ASSERT", p.str());
}

inline void run_all() {
    emit("SUITE_START", std::to_string(registry().size()));
    for (const auto& t : registry()) {
        emit("TEST_START", escape(t.name));
        current_failed() = false;
        t.func();
        emit("TEST_END", current_failed() ? "FAIL" : "PASS");
    }
    emit("SUITE_END", "");
}

}  // namespace nova_test

#define NOVA_TEST_CAT_INNER(a, b) a##b
#define NOVA_TEST_CAT(a, b) NOVA_TEST_CAT_INNER(a, b)

#define EXPECT_EQUALS(actual, expected)                                                  \
    ::nova_test::check_eq((actual), (expected), #actual, #expected, __FILE__, __LINE__)

#define EXPECT(condition)                                                                \
    ::nova_test::check_eq(static_cast<bool>(condition), true, #condition, "true",         \
                          __FILE__, __LINE__)

#define STUDENT_TEST(name) NOVA_TEST_DECL(name, __COUNTER__)
#define NOVA_TEST_DECL(name, ctr)                                                         \
    static void NOVA_TEST_CAT(_nova_test_fn_, ctr)();                                     \
    static ::nova_test::Registrar NOVA_TEST_CAT(_nova_test_reg_, ctr)(                    \
        name, &NOVA_TEST_CAT(_nova_test_fn_, ctr));                                       \
    static void NOVA_TEST_CAT(_nova_test_fn_, ctr)()
