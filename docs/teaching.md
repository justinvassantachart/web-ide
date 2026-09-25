# Teaching with web-ide

web-ide lets learners edit, run, and debug C++ in their browser. Try the
[current interactive demo](https://deploy-preview-16--nova-ide.netlify.app) for the linked-list workspace and guided
debugger tour. This is a deploy preview of the new public demo. The existing
[hosted website](https://webide.org) provides ten self-paced lessons and a
classroom interface.

These teaching features are provided by the website applications; the reusable
component in this repository supplies the editor, execution, debugger, and test
interface.

## Start with a debugging activity

Open the [linked-list workspace](https://deploy-preview-16--nova-ide.netlify.app/ide?example=linked-list).
Ask learners to predict the list's values, links, and final sum before running it.

1. Click **Debug**. A new linked-list workspace starts with a breakpoint at the
   first executable statement. If it has been removed, click the gutter beside
   that statement to restore it.
2. Use **Step Over** to execute one statement at a time. Watch the **Graph**
   panel as each node is allocated and the links are assigned.
3. Compare the current pointer and running total with the prediction. Expand
   variables to inspect their fields.
4. Continue to the end and compare the terminal output with the prediction.
5. Change a value or a link and run again. Stop the debugger before changing
   breakpoints for a new C++ run.

The history controls revisit captured debugger states. They do not rewind the
running program. The [guided debugger demo](https://deploy-preview-16--nova-ide.netlify.app/demo) provides
an alternative activity that starts with a failing test and a loop to repair.

## Use the ten lessons

Open [Lessons](https://webide.org/learn) to choose one of ten self-paced
assignments. Each lesson has its own code workspace and progress. Learners can
start without an account and return using the same browser and site address.
Clearing site storage can remove that local work.

A lesson can support a short predict–step–explain exercise: predict what the
next statement changes, step once, then explain the observed state. For pointer
exercises, have learners draw the expected links before checking the Graph panel.

## Create a hosted class and assignment

The hosted classroom requires sign-in. The component alone does not create
accounts or provide a class database.

1. [Sign in](https://webide.org/login), open the dashboard, and choose
   **Create a class**. Enter a name and optional description.
2. Open the class and choose **New assignment**. In **Starter files**, use the
   file explorer to add or edit source files, headers, and tests. Starter-file
   edits save automatically.
3. Use **Edit details** to enter the title, instructions, and optional due date.
   Keep the assignment in **Draft** while checking the code and tests.
4. Toggle **Draft** to **Published**, or select **Published (visible to students)**
   in the edit dialog. Students see published assignments.
5. Use **Copy invite link** on the class page. Students sign in and follow the
   link, or enter the class code at the website's `/join` page.
6. Students open their own copy of the assignment and submit their work. Open
   **Submissions** in the teacher view to inspect submitted code and available
   session replay. Late submissions are accepted and marked as late.

Keep a copy of the original starter files. Updating the starter after learners
begin does not overwrite their existing workspaces.

## Add a small C++ test

The C++ testing provider supplies `nova_test.h`, `STUDENT_TEST`, and
`EXPECT_EQUALS`. The header's name is part of the testing API.

```cpp
#include "nova_test.h"

int twice(int value) { return value * 2; }

STUDENT_TEST("twice handles zero") {
    EXPECT_EQUALS(twice(0), 0);
}

int main() { return 0; }
```

Put tests beside the implementation or in a separate `.cpp` file with the
appropriate declarations, then run them from the **Tests** panel. In your own
application, register `cppTestingPlugin` and `testingPlugin` as shown in
[Import IDE component](import-ide-component.md). The provider adds its support
files during execution; there is no need to copy the header into each workspace.
See the [test-provider source](../src/cpp/testing/provider.ts) and
[framework header](../src/cpp/testing/nova_test.h) for the supported API.

## Understand storage

The built-in compiler and debugger execute on the learner's device. Runtime
assets download over the network. Signed-in classroom features use Firebase for
membership, assignment files, submissions, and session events; authenticated
lessons may also record session events. The public linked-list workspace has no
session-event sink.

Tell learners what your deployment records. If you build your own course site,
the [component's host API](../src/web-ide/contracts/host.ts) lets you supply
workspace identity, initial files, saving callbacks, and optional event handling.
Authentication, access rules, lesson content, and assignment submission remain
part of your application. Start with [Import IDE component](import-ide-component.md)
and [Self-hosting](self-hosting.md).
