"""Execution-only unittest adapter. Student code is imported only after run_started."""
import hashlib
import importlib.util
import io
import json
import os
import sys
import time
import traceback
import unittest

CONFIG = json.loads(bytes.fromhex("__WEB_IDE_CONFIG_HEX__").decode("utf-8"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKER = "__WEBIDE_TEST_V2__:" + CONFIG["nonce"] + ":"
PROTOCOL_OUT = sys.stdout
SOURCES = CONFIG["sources"]
BY_RUNTIME = {os.path.normpath(os.path.join(ROOT, s["runtimePath"].lstrip("/"))): s for s in SOURCES}
BY_MODULE = {s["module"]: s for s in SOURCES if s.get("module")}
MAX_TESTS = 10000
MAX_FRAME = 60000  # ASCII JSON, including marker; safely below the shared 64K cap.


def clipped(value, limit):
    value = str(value)
    suffix = "… [truncated]"
    return value if len(value) <= limit else value[:max(0, limit - len(suffix))] + suffix


def emit(event):
    # A test may leave stdout halfway through a line. Always establish framing.
    event = dict(event)
    for field, limit in (("name", 1024), ("group", 512), ("message", 4000), ("details", 6000)):
        if field in event:
            event[field] = clipped(event[field], limit)
    payload = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
    while len(MARKER) + len(payload) > MAX_FRAME:
        field = max((k for k in ("details", "message", "name") if k in event),
                    key=lambda k: len(event[k]), default=None)
        if field is None or len(event[field]) < 64:
            raise RuntimeError("Test report metadata exceeds frame limit")
        event[field] = clipped(event[field], len(event[field]) // 2)
        payload = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
    PROTOCOL_OUT.write("\n" + MARKER + payload + "\n")
    PROTOCOL_OUT.flush()


def source_for_filename(filename):
    return BY_RUNTIME.get(os.path.normpath(os.path.abspath(filename)))


def error_fields(error):
    frames = traceback.extract_tb(error[2])
    fields = {"message": str(error[1]) or type(error[1]).__name__,
              "details": "".join(traceback.format_exception(*error))}
    for source in SOURCES:
        runtime = os.path.join(ROOT, source["runtimePath"].lstrip("/"))
        fields["details"] = fields["details"].replace(runtime, source["path"])
    for frame in reversed(frames):
        source = source_for_filename(frame.filename)
        if source:
            fields.update(path=source["path"], line=frame.lineno)
            break
    return fields


def descriptor(test, error=None):
    raw_id = test.id()
    method = getattr(test, getattr(test, "_testMethodName", ""), None)
    function = getattr(test, "_testFunc", None) or getattr(method, "__func__", method)
    code = getattr(function, "__code__", None)
    module = sys.modules.get(type(test).__module__)
    source = source_for_filename(getattr(module, "__file__", ""))
    location_source = source_for_filename(code.co_filename) if code else source
    if not source and location_source:
        source = location_source
    if not source and isinstance(test, unittest.loader._FailedTest):
        source = BY_MODULE.get(getattr(test, "_testMethodName", ""))
    if not source and error:
        for frame in reversed(traceback.extract_tb(error[2])):
            source = source_for_filename(frame.filename)
            if source:
                break
    # Fixture skips have no traceback. Resolve the module/class named by _ErrorHolder.
    if not source:
        holder = raw_id.split("(", 1)[-1].rstrip(")")
        candidates = [s for name, s in BY_MODULE.items() if holder == name or holder.startswith(name + ".")]
        if candidates:
            source = max(candidates, key=lambda s: len(s["module"]))
    path = source["path"] if source else "external"
    key = hashlib.sha256((path + "\n" + raw_id).encode("utf-8")).hexdigest()
    item = {"key": key, "name": str(test), "origin": source["origin"] if source else "external",
            "group": path.rsplit("/", 1)[-1]}
    if isinstance(test, unittest.loader._FailedTest):
        item["kind"] = "fixture"
    if location_source and code:
        item.update(path=location_source["path"], line=code.co_firstlineno)
    elif error:
        fields = error_fields(error)
        if "path" in fields:
            item.update(path=fields["path"], line=fields["line"])
    return item


class ProtocolResult(unittest.TextTestResult):
    def __init__(self, stream, descriptions, verbosity):
        super().__init__(stream, descriptions, verbosity)
        self.active = {}
        self.completed = set()
        self.fixture_count = {}
        self.had_fixture = False

    def startTest(self, test):
        super().startTest(test)
        item = descriptor(test)
        self.active[id(test)] = {"item": item, "started": time.monotonic(), "status": "passed", "fields": {}}
        emit({"type": "test_started", "key": item["key"]})

    def stopTest(self, test):
        state = self.active.pop(id(test), None)
        if state:
            emit(dict(state["fields"], type="test_" + state["status"], key=state["item"]["key"], durationMs=round((time.monotonic() - state["started"]) * 1000, 3)))
            self.completed.add(state["item"]["key"])
        super().stopTest(test)

    def outcome(self, test, status, error=None, message=None):
        # unittest reports skipped subtests under the child identity.
        parent = getattr(test, "test_case", test)
        state = self.active.get(id(parent))
        fields = error_fields(error) if error else {"message": message or ""}
        if not state:
            # Module/class setup/teardown failures do not call startTest/stopTest.
            self.had_fixture = True
            item = descriptor(test, error)
            item["kind"] = "fixture"
            count = self.fixture_count.get(item["key"], 0) + 1
            self.fixture_count[item["key"]] = count
            if count > 1:
                item["key"] = hashlib.sha256((item["key"] + "#" + str(count)).encode("utf-8")).hexdigest()
                item["name"] += " (" + str(count) + ")"
            emit(dict(item, type="test_discovered"))
            emit({"type": "test_started", "key": item["key"]})
            emit(dict(fields, type="test_" + status, key=item["key"]))
            self.completed.add(item["key"])
            return
        priority = {"passed": 0, "skipped": 1, "failed": 2, "errored": 3}
        if priority[status] > priority[state["status"]]:
            state["status"] = status
            state["fields"] = fields
        elif error and state["fields"].get("details"):
            state["fields"]["details"] = clipped(state["fields"]["details"] + "\n" + fields.get("details", ""), 6000)

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.outcome(test, "failed", error)

    def addError(self, test, error):
        super().addError(test, error)
        self.outcome(test, "errored", error)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.outcome(test, "skipped", message=reason)

    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error)
        self.outcome(test, "skipped", message="Expected failure: " + str(error[1]))

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.outcome(test, "failed", message="Unexpected success")

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error:
            status = "failed" if issubclass(error[0], test.failureException) else "errored"
            self.outcome(test, status, error)


def flatten(suite):
    if isinstance(suite, unittest.TestSuite):
        for child in suite:
            yield from flatten(child)
    else:
        yield suite


def select_suite(suite, selected, seen=None):
    # Retain the suite tree and testcase instances: do not re-import via loadTestsFromName.
    if seen is None:
        seen = set()
    if isinstance(suite, unittest.TestSuite):
        children = [select_suite(child, selected, seen) for child in suite]
        children = [child for child in children if child is not None]
        if not children:
            return None
        suite._tests = children
        return suite
    key = descriptor(suite)["key"]
    if key not in selected or key in seen:
        return None
    seen.add(key)
    return suite


def import_failure_source(test):
    if isinstance(test, unittest.loader._FailedTest):
        return BY_MODULE.get(getattr(test, "_testMethodName", ""))
    return None


def failed_selected_imports(tests, missing):
    paths = {CONFIG.get("selectionSources", {}).get(key) for key in missing}
    paths.discard(None)
    failures = []
    for test in tests:
        source = import_failure_source(test)
        if not source:
            continue
        path = source["path"]
        package = path.rsplit("/", 1)[0] + "/" if path.endswith("/__init__.py") else None
        if not paths or path in paths or (package and any(value.startswith(package) for value in paths)):
            failures.append(test)
    return failures


def preload_main():
    source = BY_MODULE.get("main")
    if not source:
        return
    filename = os.path.join(ROOT, source["runtimePath"].lstrip("/"))
    spec = importlib.util.spec_from_file_location("main", filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules["main"] = module
    spec.loader.exec_module(module)


def run():
    emit({"type": "run_started"})
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    result = ProtocolResult(io.StringIO(), False, 0)
    discovery_complete = False
    try:
        preload_main()
        suite = unittest.TestLoader().discover(ROOT, pattern="test*.py", top_level_dir=ROOT)
        tests = list(flatten(suite))
        if len(tests) > MAX_TESTS:
            raise RuntimeError("More than 10000 tests were discovered")
        unique = {}
        for test in tests:
            key = descriptor(test)["key"]
            previous = unique.get(key)
            if previous is not None:
                # Importing the same TestCase in another test module makes unittest
                # load it again. Preserve one exact case, but reject parameterized
                # cases that expose the same ID with different instance state.
                if type(previous) is type(test) and previous.__dict__ == test.__dict__:
                    continue
                emit({"type": "run_terminated", "reason": "protocol_violation", "message": "Duplicate unittest IDs refer to different test instances"})
                return 1
            unique[key] = test
        tests = list(unique.values())
        items = [descriptor(test) for test in tests]
        keys = [item["key"] for item in items]
        for item in items:
            emit(dict(item, type="test_discovered"))
        emit({"type": "discovery_finished"})
        discovery_complete = True
        if CONFIG["selection"] is not None:
            selected = set(CONFIG["selection"])
            missing = selected - set(keys)
            failed_imports = failed_selected_imports(tests, missing) if missing else []
            if failed_imports:
                unittest.TestSuite(failed_imports).run(result)
                modules = [getattr(test, "_testMethodName", "") for test in failed_imports]
                emit({"type": "run_terminated", "reason": "runtime_crash", "message": "Cannot load selected test modules: " + ", ".join(modules)})
                return 1
            if not selected or missing:
                emit({"type": "run_terminated", "reason": "selection_stale", "message": "Selected tests were not found in the loaded suite"})
                return 1
            suite = select_suite(suite, selected)
        else:
            suite = select_suite(suite, set(keys))
        if suite is not None:
            suite.run(result)
        if result.had_fixture:
            # unittest suppresses cases blocked by module/class setup. Reconcile
            # those announced cases explicitly, preserving the fixture's outcome.
            expected = set(keys) if CONFIG["selection"] is None else set(CONFIG["selection"])
            for key in keys:
                if key in expected and key not in result.completed:
                    emit({"type": "test_started", "key": key})
                    emit({"type": "test_skipped", "key": key, "message": "Not run after a suite fixture failure or skip"})
                    result.completed.add(key)
        emit({"type": "run_finished", "message": "No tests ran" if not result.completed else ""})
        return 0 if result.wasSuccessful() else 1
    except Exception:
        # Preload/load_tests failures need a visible row even before suite discovery.
        error = sys.exc_info()
        if not discovery_complete:
            emit({"type": "discovery_finished"})
        holder = unittest.suite._ErrorHolder("discovery (main)")
        result.outcome(holder, "errored", error)
        emit({"type": "run_terminated", "reason": "runtime_crash", "message": "Test discovery failed: " + str(error[1])})
        return 1


if __name__ == "__main__":
    sys.exit(run())
