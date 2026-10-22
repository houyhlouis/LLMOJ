// The built-in checkers as a program of their own. The judge (src/checkers/builtin.ts) starts it for each check with
// a time limit and a cap on the message it reads back, instead of forking the multithreaded judge process.
//
//   builtin_checker integers
//   builtin_checker floats PRECISION
//   builtin_checker tokens|lines CASE_SENSITIVE (0 or 1)
//   builtin_checker binary
//
// The contestant's output is descriptor 3 and the answer descriptor 4. The result is testlib's message on standard
// error, as when the checkers ran in a forked judge; the exit status is testlib's.

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include <dirent.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <testlib.h>

#include "integers.h"
#include "floats.h"
#include "lines.h"
#include "tokens.h"
#include "binary.h"

namespace {

const int OUTPUT_DESCRIPTOR = 3, ANSWER_DESCRIPTOR = 4;
// Not one of testlib's exit statuses, so the judge can't take it for a verdict
const int USAGE_ERROR = 64;

[[noreturn]] void usageError(const char *message) {
    std::fprintf(stderr, "Invalid built-in checker arguments: %s\n", message);
    std::fflush(stderr);
    // Without testlib's exit handlers, which would report that no checker was registered
    _exit(USAGE_ERROR);
}

// Only the output, the answer and standard error stay open: a descriptor the judge didn't mark close-on-exec
// mustn't reach code that parses a contestant's output.
void closeOtherDescriptors() {
#ifdef SYS_close_range
    if (syscall(SYS_close_range, ANSWER_DESCRIPTOR + 1, UINT_MAX, 0) == 0) return;
#endif
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) usageError("can't list open descriptors");
    const int own = dirfd(directory);
    std::vector<int> descriptors;
    while (dirent *entry = readdir(directory)) {
        char *end;
        const long fd = std::strtol(entry->d_name, &end, 10);
        if (*end == '\0' && end != entry->d_name && fd > ANSWER_DESCRIPTOR && fd != own) descriptors.push_back(fd);
    }
    closedir(directory);
    for (const int fd : descriptors) close(fd);
}

bool parseFlag(const char *value) {
    if (std::strcmp(value, "0") == 0) return false;
    if (std::strcmp(value, "1") == 0) return true;
    usageError("expected 0 or 1");
}

int parsePrecision(const char *value) {
    char *end;
    errno = 0;
    const long precision = std::strtol(value, &end, 10);
    if (errno || *value == '\0' || *end != '\0' || precision < INT_MIN || precision > INT_MAX)
        usageError("expected an integer precision");
    return int(precision);
}

std::function<void()> selectChecker(int argc, char *argv[]) {
    if (argc < 2) usageError("no checker type");
    const std::string type = argv[1];
    const int parameters = argc - 2;
    if (type == "integers" && parameters == 0) return builtinCheckerIntegers;
    if (type == "floats" && parameters == 1) return std::bind(builtinCheckerFloats, parsePrecision(argv[2]));
    if (type == "tokens" && parameters == 1) return std::bind(builtinCheckerTokens, parseFlag(argv[2]));
    if (type == "lines" && parameters == 1) return std::bind(builtinCheckerLines, parseFlag(argv[2]));
    if (type == "binary" && parameters == 0) return builtinCheckerBinary;
    usageError("unknown checker type or wrong number of parameters");
}

}  // namespace

int main(int argc, char *argv[]) {
    const std::function<void()> checker = selectChecker(argc, argv);
    closeOtherDescriptors();

    char programName[] = "builtin_checker";
    char inputFile[] = "/dev/null";
    char outputFile[32], answerFile[32];
    std::snprintf(outputFile, sizeof outputFile, "/proc/self/fd/%d", OUTPUT_DESCRIPTOR);
    std::snprintf(answerFile, sizeof answerFile, "/proc/self/fd/%d", ANSWER_DESCRIPTOR);
    char *checkerArgv[] = {programName, inputFile, outputFile, answerFile};
    registerTestlibCmd(4, checkerArgv);
    checker();
    quitf(_fail, "Builtin checker returned without reporting a result");
}
