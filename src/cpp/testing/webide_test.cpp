#include "webide_test.h"
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <map>
#include <set>
#include <algorithm>

namespace webide_test {
static std::vector<Test>& registry() { static std::vector<Test> tests; return tests; }
static std::string bounded(const std::string& text, std::size_t limit = 1536) { const std::string suffix = " [truncated]"; return text.size() <= limit ? text : text.substr(0, limit > suffix.size() ? limit - suffix.size() : 0) + suffix.substr(0, limit); }
static std::string canonical(const char* file) {
    std::string path(file);
    if (path.rfind("/workspace/", 0) == 0 || path.rfind("/sysroot/", 0) == 0) return path;
    while (!path.empty() && path[0] == '/') path.erase(0, 1);
    return "/workspace/" + path;
}
static std::string hashKey(const std::string& text) {
    uint32_t a = 2166136261u, b = 3339675911u;
    for (unsigned char ch : text) { a = (a ^ ch) * 16777619u; b = (b ^ ch) * 16777619u; }
    char buffer[17]; std::snprintf(buffer, sizeof buffer, "%08x%08x", a, b); return buffer;
}
Registrar::Registrar(const char* key, const char* name, const char* origin, const char* file, int line, unsigned ordinal, void (*body)()) {
    const std::string path = canonical(file);
    registry().push_back({*key ? key : hashKey(path + "\n" + std::to_string(line) + "\n" + std::to_string(ordinal) + "\n" + name), bounded(name, 1024), origin, path, line, body});
}
[[noreturn]] void fail(const std::string& message, const char* file, int line, const char* ae, const char* be, const std::string& actual, const std::string& expected) {
    throw CheckFailure{bounded(message), canonical(file), bounded(ae), bounded(be), bounded(actual), bounded(expected), line};
}
// Preserve valid UTF-8; replace invalid bytes and truncate before JSON escaping.
static std::string quote(const std::string& input) {
    const std::string text = bounded(input); std::string output = "\"";
    const char hex[] = "0123456789abcdef";
    for (std::size_t i = 0; i < text.size();) {
        const unsigned char ch = text[i];
        if (ch == '"' || ch == '\\') { output += '\\'; output += ch; ++i; }
        else if (ch < 32) { output += "\\u00"; output += hex[ch >> 4]; output += hex[ch & 15]; ++i; }
        else if (ch < 128) { output += ch; ++i; }
        else {
            std::size_t count = ch >= 0xc2 && ch <= 0xdf ? 2 : ch >= 0xe0 && ch <= 0xef ? 3 : ch >= 0xf0 && ch <= 0xf4 ? 4 : 0;
            bool valid = count && i + count <= text.size();
            for (std::size_t j = 1; valid && j < count; ++j) valid = (static_cast<unsigned char>(text[i + j]) & 0xc0) == 0x80;
            if (valid && count >= 3) { unsigned char second = text[i + 1]; valid = !(ch == 0xe0 && second < 0xa0) && !(ch == 0xed && second >= 0xa0) && !(ch == 0xf0 && second < 0x90) && !(ch == 0xf4 && second >= 0x90); }
            if (valid) { output.append(text, i, count); i += count; } else { output += "\\ufffd"; ++i; }
        }
    }
    return output + '"';
}
static void emit(const char* nonce, const std::string& json) {
    std::printf("\n__WEBIDE_TEST_V2__:%s:%s\n", nonce, json.c_str()); std::fflush(stdout);
}
static std::string location(const Test& test) {
    return test.path.rfind("/workspace/", 0) == 0 ? ",\"path\":" + quote(test.path) + ",\"line\":" + std::to_string(test.line) : "";
}
int run(const char* nonce, const std::vector<std::string>& selected, bool all) {
    const auto suiteStart = std::chrono::steady_clock::now();
    emit(nonce, "{\"type\":\"run_started\"}");
    std::map<std::string, Test> unique;
    std::vector<Test> ordered;
    for (const auto& test : registry()) {
        auto inserted = unique.emplace(test.key, test);
        if (inserted.second) ordered.push_back(test);
        if (!inserted.second && (inserted.first->second.name != test.name || inserted.first->second.path != test.path || inserted.first->second.line != test.line)) {
            emit(nonce, "{\"type\":\"run_terminated\",\"reason\":\"protocol_violation\",\"message\":\"Test identity collision\"}"); return 1;
        }
        if (unique.size() > 10000) { emit(nonce, "{\"type\":\"run_terminated\",\"reason\":\"protocol_violation\",\"message\":\"Too many tests\"}"); return 1; }
    }
    std::stable_sort(ordered.begin(), ordered.end(), [](const Test& left, const Test& right) { return left.path < right.path || (left.path == right.path && left.line < right.line); });
    for (const auto& test : ordered) {
        emit(nonce, "{\"type\":\"test_discovered\",\"key\":" + quote(test.key) + ",\"name\":" + quote(test.name) + ",\"origin\":" + quote(test.origin) + ",\"group\":" + quote(bounded(test.path, 512)) + location(test) + "}");
    }
    emit(nonce, "{\"type\":\"discovery_finished\"}");
    const std::set<std::string> filter(selected.begin(), selected.end());
    for (const auto& key : filter) if (!unique.count(key)) {
        emit(nonce, "{\"type\":\"run_terminated\",\"reason\":\"selection_stale\",\"message\":\"A selected test is not present in the compiled program\"}"); return 1;
    }
    if (!all && filter.empty()) { emit(nonce, "{\"type\":\"run_terminated\",\"reason\":\"selection_stale\",\"message\":\"No tests selected\"}"); return 1; }
    int failures = 0; std::size_t count = 0;
    for (const auto& test : ordered) {
        if (!all && !filter.count(test.key)) continue;
        ++count; const std::string key = ",\"key\":" + quote(test.key);
        emit(nonce, "{\"type\":\"test_started\"" + key + "}");
        const auto start = std::chrono::steady_clock::now();
        std::string result = "test_passed", detail;
        try { test.body(); }
        catch (const CheckFailure& failure) {
            result = "test_failed"; ++failures;
            detail = ",\"message\":" + quote(failure.message) + ",\"actual\":{\"expression\":" + quote(failure.actualExpression) + ",\"value\":" + quote(failure.actual) + "},\"expected\":{\"expression\":" + quote(failure.expectedExpression) + ",\"value\":" + quote(failure.expected) + "}";
            if (failure.path.rfind("/workspace/", 0) == 0) detail += ",\"path\":" + quote(failure.path) + ",\"line\":" + std::to_string(failure.line);
        }
        catch (const std::exception& e) { result = "test_errored"; ++failures; detail = ",\"message\":" + quote(e.what()) + location(test); }
        catch (...) { result = "test_errored"; ++failures; detail = ",\"message\":\"Unexpected non-standard exception\"" + location(test); }
        const auto duration = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        emit(nonce, "{\"type\":" + quote(result) + key + ",\"durationMs\":" + std::to_string(duration) + detail + "}");
    }
    const auto duration = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - suiteStart).count();
    emit(nonce, "{\"type\":\"run_finished\",\"durationMs\":" + std::to_string(duration) + (count ? "" : ",\"message\":\"No tests ran\"") + "}");
    return failures ? 1 : 0;
}
}
