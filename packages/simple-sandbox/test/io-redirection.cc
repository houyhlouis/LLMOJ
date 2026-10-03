// Trusted pipe fixture: exercises the same redirector used before sandbox exec.
#include "../native/io-redirection.h"
#include <sys/wait.h>
#include <poll.h>
#include <cassert>
#include <cstring>
#include <iostream>

static void eofWhilePeerLives(bool mergedError)
{
    int input[2], output[2];
    ENSURE(pipe(input));
    ENSURE(pipe(output));
    const pid_t child = ENSURE(fork());
    if (child == 0)
    {
        close(input[1]);
        close(output[0]);
        const int extra = ENSURE(open("/dev/zero", O_RDONLY));
        const int nullfd = ENSURE(open("/dev/null", O_RDWR));
        SandboxParameter parameter{};
        parameter.stdinRedirectionFileDescriptor = input[0];
        parameter.stdoutRedirectionFileDescriptor = output[1];
        parameter.stderrRedirectionFileDescriptor = mergedError ? output[1] : -1;
        RedirectIO(parameter, nullfd);
        // The shared-memory API and other explicit extra handles must survive.
        assert(fcntl(extra, F_GETFD) >= 0);
        for (const int fd : {input[0], output[1], nullfd})
        {
            errno = 0;
            assert(fcntl(fd, F_GETFD) == -1 && errno == EBADF);
        }
        ENSURE(write(STDOUT_FILENO, "request", 7));
        ENSURE(close(STDOUT_FILENO));
        if (mergedError)
        {
            ENSURE(write(STDERR_FILENO, "error", 5));
            ENSURE(close(STDERR_FILENO));
        }
        char response;
        assert(read(STDIN_FILENO, &response, 1) == 1 && response == 'x');
        _exit(0);
    }
    close(input[0]);
    close(output[1]);
    std::string received;
    for (;;)
    {
        pollfd fd{output[0], POLLIN | POLLHUP, 0};
        assert(poll(&fd, 1, 1000) == 1 && "EOF hidden by a duplicate pipe writer");
        char bytes[32];
        const auto count = read(output[0], bytes, sizeof(bytes));
        assert(count >= 0);
        if (count == 0) break;
        received.append(bytes, count);
    }
    assert(received == (mergedError ? "requesterror" : "request"));
    assert(waitpid(child, nullptr, WNOHANG) == 0 && "EOF must arrive before process exit");
    ENSURE(write(input[1], "x", 1));
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(input[1]);
    close(output[0]);
}

int main()
{
    eofWhilePeerLives(false);
    eofWhilePeerLives(true);
    std::cout << "stdio EOF, merged stderr, source FD cleanup, and extra FD retention passed\n";
}
