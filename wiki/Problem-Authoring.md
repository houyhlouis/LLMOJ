# Problem authoring

[简体中文](Problem-Authoring.zh-CN.md) | English | [Wiki home](Home.en.md)

This page walks through making a problem by hand: the statement, the test data, the judge settings of each of the four problem types, testing, and sharing or publishing it. To have AI draft a statement or generate test data, see [AI](AI.md); the result is edited the same way.

## 1. Create the problem

In the problem set, **Add Problem** opens a new problem. You need the **Create problems** permission (see [Permissions](Permissions.md)); by default every signed-in user may create problems (`preference.security.allowEveryoneCreateProblem`).

A new problem is **hidden**: only you, administrators and those you share it with can open it, and it has no ID in the problem set until one is set (see [Publishing](#6-share-or-publish)).

## 2. Write the statement

**Edit** opens the statement editor.

- **Languages.** A statement can have several languages, each with its own title and sections. The **Default language** is shown to users whose language has no statement. **Add default sections** adds the usual ones to fill in: Description, Input, Output, Sample, and Limits And Hints.
- **Sections** are **Text** (Markdown, with `$...$` and `$$...$$` for formulas) or **Sample**. Move, add and delete them from each section's menu; empty sections aren't shown.
- **Samples** belong to the problem, not to one language: each has an input, an output and, per language, an explanation. A **Sample** section shows one of them. The sample editor warns when a sample isn't shown in a language, or is shown twice.
- **Tags** are chosen from the site's tags. Creating and renaming tags needs **Manage problem tags**.

Samples are part of the statement. The data that judges submissions is separate (next step), although the samples can be run first (**Run samples when judging**).

## 3. Upload the test data

**Files** has two lists:

- **Test Data**: the files judging uses (inputs, outputs, checkers, interactors, graders, extra source files). Users never see them unless their permissions say so (**Read problem test data**).
- **Additional Files**: attachments users can download from the problem page.

Name test cases `1.in` and `1.out` (or `1.ans`), `2.in` and `2.out`, and so on: without explicit subtasks, every `X.in` with a matching `X.out` or `X.ans` becomes a test case, in the order of the numbers in their names. **Download as Archive** downloads a list as a ZIP. Changing the test data or judge settings creates a new [data version](Submissions.md#test-data-versions-and-earlier-results): submissions are judged with the version current when they were submitted, and **Rejudge** uses the current one.

## 4. Choose the judge settings

**Judge Settings** sets the problem type and how submissions are judged. Every setting is also available as YAML under **Edit Raw**; the examples below are in that form. Limits are in milliseconds and MiB, and can't exceed the site's limits (`resourceLimit` in the [backend configuration](Backend-Configuration.md)).

The **problem type** can be switched only while the problem has no submissions, and switching resets the judge settings to the new type's defaults (see [Changing a problem's type](Submissions.md#changing-a-problems-type)). **Submittable** turns submissions on and off.

### Settings every type shares

- **Subtasks.** `subtasks: null` finds the test cases automatically (one subtask, as described above). Explicit subtasks list their test cases, each with its own optional limits and points.
- **Scoring of a subtask** (`scoringType`): `Sum` adds the test cases' scores, `GroupMin` takes the lowest, `GroupMul` multiplies them (each as a fraction of full marks).
- **Points** are percentages: a subtask's share of the problem, and a test case's share of its subtask. Points left out are shared equally among the subtasks or test cases without them; the given ones may not add up to more than 100.
- **Dependencies** (`dependencies: [0, 1]`: the subtasks' positions, counting from 0) skip a subtask, scoring 0, when a subtask it depends on scored nothing. Cycles are refused.
- **Limits** (`timeLimit`, `memoryLimit`) apply to the whole problem, and a subtask or test case can override them.

### The checker

The checker compares the program's output with the answer (traditional and submit-answer problems):

| Checker | Accepts |
| --- | --- |
| `integers` | The same integers, whatever the spacing |
| `floats` | Numbers within the given relative or absolute error (`precision: 6` means 10⁻⁶) |
| `tokens` | The same whitespace-separated tokens (optionally ignoring letter case) |
| `lines` | The same lines, ignoring spaces at line ends and empty lines at the end (optionally ignoring letter case) |
| `binary` | Byte-for-byte identical files |
| `custom` | Your own program, uploaded with the test data |

A custom checker names its `interface` (`testlib`, `legacy`, `lemon`, `hustoj`, `qduoj` or `domjudge`: the conventions it was written for; `testlib` is the usual one), its `language` and options, its `filename`, and optionally its own `timeLimit` and `memoryLimit`. How each interface's partial scores count is listed in [Checker scores](Submissions.md#checker-scores).

### Traditional

The program reads the input and writes its output; the checker compares it with the answer.

```yaml
timeLimit: 1000
memoryLimit: 512
runSamples: true
# fileIo: { inputFilename: game.in, outputFilename: game.out }   # leave out for standard input and output
subtasks:
  - scoringType: GroupMin
    points: 30
    testcases:
      - { inputFile: 1.in, outputFile: 1.out }
      - { inputFile: 2.in, outputFile: 2.out }
  - scoringType: GroupMin
    points: 70
    dependencies: [0]     # skipped if the first subtask scores nothing
    testcases:
      - { inputFile: 3.in, outputFile: 3.out }
      - { inputFile: 4.in, outputFile: 4.out, timeLimit: 2000 }
checker:
  type: custom
  interface: testlib
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: checker.cpp
```

`extraSourceFiles` adds files to the program's source directory when it's compiled, per language (`extraSourceFiles: { cpp: { "graph.h": graph.h } }`, destination name to test data file).

### Interaction

The program talks to an interactor, which you write, and the interactor decides the result. There are no output files.

```yaml
timeLimit: 1000
memoryLimit: 256
runSamples: true
subtasks: null            # every X.in is a test case
interactor:
  interface: stdio        # the two programs' input and output are connected by pipes
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: interactor.cpp
  timeLimit: 2000         # optional; the interactor's own limits
  memoryLimit: 256
```

With `interface: shm`, the two programs share a memory region of `sharedMemorySize` MiB (4 to 128) instead. Left out, the interactor's limits are the problem's (its time limit is never shorter than the problem's). A new interaction problem starts with a time limit of 1,000 ms and a memory limit of 512 MiB, or the site's limits where they are lower.

### Submit answer

Users upload a ZIP of output files, one per test case; the checker compares each with the answer.

```yaml
subtasks:
  - scoringType: Sum
    testcases:
      - { inputFile: 1.in, outputFile: 1.out, userOutputFilename: answer1.txt }
      - { inputFile: 2.in, outputFile: 2.out, userOutputFilename: answer2.txt }
checker:
  type: lines
  caseSensitive: false
```

`userOutputFilename` is the file's name in the user's ZIP (by default the same as `outputFile`); the input files are optional and only passed to a custom checker. Publish the inputs as **Additional Files** so users can download them. See [Answer archives](Submissions.md#answer-archives) for what the ZIP may contain.

### Communication

Two separate runs of the contestant's program exchange information only through a trusted **manager**, which you write: each run talks to the manager, never to the other.

```yaml
timeLimit: 1000
memoryLimit: 256
runSamples: true
subtasks: null
manager:
  interface: run-twice
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: manager.cpp
grader:                   # optional: a function interface
  filename: grader.cpp
```

With a `grader`, contestants implement both sides' functions in C++ without `main`, and the grader (a test data file ending in `.cpp`, not `main.cpp`) provides `main` and calls them; the contest page then offers C++ only. How the judge admits the two runs' memory is described in [Judge configuration](Judge-Configuration.md).

## 5. Test it

- Submit a correct solution, and wrong ones: one that's too slow, one with a wrong answer on an edge case, one that uses too much memory. Check each result against what you expect.
- **Statistics** show the problem's submissions; **Rejudge** (with the permission) judges earlier submissions with the current data after you change it.
- A contest manager can add a problem they can edit to a contest while it's still hidden: contestants see it through the contest. For hacks, set up the trusted STD (see [Hacks](Hacks.md)).

## 6. Share or publish

- **Share** a hidden problem with **Permissions** on the problem page: give users or groups read access (to open it) or write access (to edit it). Whether owners may change this themselves depends on `preference.security.allowOwnerManageProblemPermission`; see [Permissions](Permissions.md) for which rule wins.
- **Publish** it with **Set ID** (its number in the problem set) and **Make Public**. Both need **Manage problem visibility and IDs** or the **Manage problem** privilege. Once a problem is public, its owner and those with write access can still edit it only if `preference.security.allowNonPrivilegedUserEditPublicProblem` is on.
- **In a contest**, a problem can have a different title, a score weight, its own input and output filenames, and **All tests in each subtask must pass to earn its score** (see [Contest rules](Contest-Rules.md)). These change the contest only, not the problem.
- **Delete** removes the problem with its submissions; owners may delete their own problems only while `preference.security.allowOwnerDeleteProblem` is on.

## See also

- [Statement downloads](Statement-Downloads.md): a statement as Markdown; a contest's problems as a ZIP.
- [Solutions](Solutions.md): tutorials on problem pages.
- [Self Eval](Self-Evaluation.md): hidden pretests in NOI / OI contests.
- [Study lists and discussions](Study-Lists-and-Discussions.md): personal problem lists, and moderating discussions.
