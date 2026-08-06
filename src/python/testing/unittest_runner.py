"""Ephemeral unittest entrypoint used by the Web IDE Python TestProvider."""

import io
import importlib.util
import json
import os
import sys
import time
import traceback
import unittest


MARKER = "###WEB_IDE_UNITTEST###"
USER_MAIN = "__web_ide_user_main__.py"
USER_MAIN_SOURCE = "main.py"


def preload_user_main():
    """Keep `import main` pointing at user code after this runner becomes main.py."""
    if not os.path.exists(USER_MAIN):
        return
    spec = importlib.util.spec_from_file_location("main", USER_MAIN)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    sys.modules["main"] = module
    spec.loader.exec_module(module)


def emit(event):
    print(MARKER + json.dumps(event, separators=(",", ":")), flush=True)


def location_from_error(error):
    frames = traceback.extract_tb(error[2])
    if not frames:
        return None
    frame = frames[-1]
    filename = frame.filename
    if os.path.basename(filename) == USER_MAIN:
        filename = USER_MAIN_SOURCE
    return {"file": filename, "line": frame.lineno}


class ProtocolResult(unittest.TextTestResult):
    def __init__(self, stream, descriptions, verbosity):
        super().__init__(stream, descriptions, verbosity)
        self.started_at = {}

    def startTest(self, test):
        super().startTest(test)
        test_id = test.id()
        self.started_at[test_id] = time.monotonic()
        emit({"type": "test-start", "testId": test_id, "name": str(test)})

    def _duration(self, test):
        started = self.started_at.pop(test.id(), None)
        if started is None:
            return None
        return round((time.monotonic() - started) * 1000, 3)

    def _end(self, test, status):
        event = {"type": "test-end", "testId": test.id(), "status": status}
        duration = self._duration(test)
        if duration is not None:
            event["durationMs"] = duration
        emit(event)

    def _diagnostic(self, test, error):
        exception = error[1]
        diagnostic = {
            "message": str(exception) or exception.__class__.__name__,
            "details": self._exc_info_to_string(error, test).replace(
                USER_MAIN,
                USER_MAIN_SOURCE,
            ),
        }
        location = location_from_error(error)
        if location is not None:
            diagnostic["location"] = location
        emit({
            "type": "test-diagnostic",
            "testId": test.id(),
            "diagnostic": diagnostic,
        })

    def addSuccess(self, test):
        super().addSuccess(test)
        self._end(test, "pass")

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self._diagnostic(test, error)
        self._end(test, "fail")

    def addError(self, test, error):
        super().addError(test, error)
        self._diagnostic(test, error)
        self._end(test, "error")

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        emit({
            "type": "test-diagnostic",
            "testId": test.id(),
            "diagnostic": {"message": reason},
        })
        self._end(test, "skip")

    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error)
        self._end(test, "skip")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        emit({
            "type": "test-diagnostic",
            "testId": test.id(),
            "diagnostic": {"message": "Unexpected success"},
        })
        self._end(test, "fail")

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is None:
            return
        self._diagnostic(test, error)
        if test.id() in self.started_at:
            status = "fail" if issubclass(error[0], test.failureException) else "error"
            self._end(test, status)


class ProtocolRunner(unittest.TextTestRunner):
    resultclass = ProtocolResult


preload_user_main()
suite = unittest.defaultTestLoader.discover(".", pattern="test*.py")
emit({"type": "run-start", "total": suite.countTestCases()})
result = ProtocolRunner(stream=io.StringIO(), verbosity=0).run(suite)
emit({"type": "run-end"})
sys.exit(0 if result.wasSuccessful() else 1)
