#include <testlib.h>

// Match testlib's token semantics used by contest checkers. Newlines, tabs,
// spaces and CRLF are separators; token contents and their order remain exact.
void builtinCheckerTokens(bool caseSensitive) {
    int count = 0;
    while (!ans.seekEof()) {
        if (ouf.seekEof())
            quitf(_wa, "Output is shorter than answer at token %d", count + 1);
        const std::string expected = ans.readToken();
        const std::string actual = ouf.readToken();
        ++count;
        if ((caseSensitive ? expected : lowerCase(expected)) !=
            (caseSensitive ? actual : lowerCase(actual)))
            quitf(_wa, "Token %d differs - expected: '%s', found: '%s'", count,
                  compress(expected).c_str(), compress(actual).c_str());
    }
    if (!ouf.seekEof())
        quitf(_wa, "Output contains extra tokens after token %d", count);
    quitf(_ok, "%d token(s)", count);
}
