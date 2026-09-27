#ifndef WEBIDE_TEST_H
#define WEBIDE_TEST_H
#include <algorithm>
#include <cmath>
#include <exception>
#include <ostream>
#include <streambuf>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

// Original WebIDE testing framework. Test cases execute sequentially and stop
// at the first failed check. The registry is defined in one translation unit.
namespace webide_test {
struct CheckFailure {
    std::string message, path, actualExpression, expectedExpression, actual, expected;
    int line;
};
struct Test { std::string key, name, origin, path; int line; void (*body)(); };
struct Registrar {
    Registrar(const char* key, const char* name, const char* origin, const char* file, int line, unsigned ordinal, void (*body)());
};
int run(const char* nonce, const std::vector<std::string>& selected, bool all);
[[noreturn]] void fail(const std::string& message, const char* file, int line,
    const char* actualExpression = "", const char* expectedExpression = "",
    const std::string& actual = "", const std::string& expected = "");
class BoundedBuffer : public std::streambuf {
    std::string text;
    bool truncated = false;
protected:
    int_type overflow(int_type ch) override {
        if (!traits_type::eq_int_type(ch, traits_type::eof())) {
            if (text.size() < 2048) text += traits_type::to_char_type(ch); else truncated = true;
        }
        return traits_type::not_eof(ch);
    }
    std::streamsize xsputn(const char* data, std::streamsize n) override {
        const auto count = std::min<std::size_t>(2048 - text.size(), static_cast<std::size_t>(n));
        text.append(data, count); if (count < static_cast<std::size_t>(n)) truncated = true; return n;
    }
public:
    std::string str() const { return text + (truncated ? " [truncated]" : ""); }
};
template<class T, class = void> struct Streamable : std::false_type {};
template<class T> struct Streamable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};
template<class T> std::string format(const T& value) {
    if constexpr (Streamable<T>::value) {
        BoundedBuffer buffer; std::ostream out(&buffer); out.precision(17); out << std::boolalpha << value; return buffer.str();
    } else { return "<value cannot be printed>"; }
}
inline std::string format(const char* value) { return value ? std::string(value, std::min<std::size_t>(std::char_traits<char>::length(value), 2048)) : "<null>"; }
inline std::string format(char* value) { return format(static_cast<const char*>(value)); }
template<class T> constexpr bool stringLike = std::is_convertible_v<const T&, std::string_view>;
template<class A, class B> bool equal(const A& a, const B& b) {
    if constexpr (stringLike<A> && stringLike<B>) {
        if constexpr (std::is_pointer_v<std::decay_t<A>>) if (a == nullptr) { if constexpr (std::is_pointer_v<std::decay_t<B>>) return b == nullptr; else return false; }
        if constexpr (std::is_pointer_v<std::decay_t<B>>) if (b == nullptr) return false;
        return std::string_view(a) == std::string_view(b);
    } else if constexpr (std::is_arithmetic_v<A> && std::is_arithmetic_v<B> && (std::is_floating_point_v<A> || std::is_floating_point_v<B>)) {
        const long double left = a, right = b;
        if (left == right) return true;
        if (!std::isfinite(left) || !std::isfinite(right)) return false;
        return std::fabs(left - right) <= std::max(1e-9L, 1e-9L * std::max(std::fabs(left), std::fabs(right)));
    } else if constexpr (std::is_integral_v<A> && std::is_integral_v<B> && std::is_signed_v<A> != std::is_signed_v<B>) {
        if constexpr (std::is_signed_v<A>) return a >= 0 && static_cast<std::make_unsigned_t<A>>(a) == b;
        else return b >= 0 && a == static_cast<std::make_unsigned_t<B>>(b);
    } else { return a == b; }
}
template<class A, class B> void expectEqual(const A& a, const B& b, const char* ae, const char* be, const char* file, int line, const std::string& message = "") {
    if (!equal(a, b)) fail(message.empty() ? "EXPECT_EQUAL failed" : message, file, line, ae, be, format(a), format(b));
}
inline void expect(bool result, const char* expression, const char* file, int line, const std::string& message = "") {
    if (!result) fail(message.empty() ? "EXPECT failed" : message, file, line, expression, "true", "false", "true");
}
template<class F> void expectError(F&& body, const char* file, int line, const char* expression, const std::string& message = "") {
    try { body(); } catch (const CheckFailure&) { throw; } catch (...) { return; }
    fail(message.empty() ? "EXPECT_ERROR: no exception was thrown" : message, file, line, expression);
}
template<class F> void expectNoError(F&& body, const char* file, int line, const char* expression, const std::string& message = "") {
    try { body(); } catch (const CheckFailure&) { throw; }
    catch (const std::exception& e) { fail(message.empty() ? std::string("EXPECT_NO_ERROR: ") + e.what() : message, file, line, expression); }
    catch (...) { fail(message.empty() ? "EXPECT_NO_ERROR: an exception was thrown" : message, file, line, expression); }
}
}
#define WEBIDE_JOIN_IMPL(a,b) a##b
#define WEBIDE_JOIN(a,b) WEBIDE_JOIN_IMPL(a,b)
#define WEBIDE_TEST_IMPL(key,name,origin,n) static void WEBIDE_JOIN(webide_test_body_,n)(); static webide_test::Registrar WEBIDE_JOIN(webide_test_reg_,n)(key,name,origin,__FILE__,__LINE__,n,&WEBIDE_JOIN(webide_test_body_,n)); static void WEBIDE_JOIN(webide_test_body_,n)()
#define WEBIDE_TEST_KEY(key,name,origin) WEBIDE_TEST_IMPL(key,name,origin,__COUNTER__)
#define STUDENT_TEST(name) WEBIDE_TEST_KEY("",name,"student")
#define PROVIDED_TEST(name) WEBIDE_TEST_KEY("",name,"provided")
#define EXPECT(expression,...) do { webide_test::expect(static_cast<bool>(expression),#expression,__FILE__,__LINE__,##__VA_ARGS__); } while(false)
#define EXPECT_EQUAL(actual,expected,...) do { webide_test::expectEqual((actual),(expected),#actual,#expected,__FILE__,__LINE__,##__VA_ARGS__); } while(false)
#define EXPECT_ERROR(statement,...) do { webide_test::expectError([&]() { statement; },__FILE__,__LINE__,#statement,##__VA_ARGS__); } while(false)
#define EXPECT_NO_ERROR(statement,...) do { webide_test::expectNoError([&]() { statement; },__FILE__,__LINE__,#statement,##__VA_ARGS__); } while(false)
#endif
