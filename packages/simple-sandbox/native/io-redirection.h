#pragma once

#include <fcntl.h>
#include <unistd.h>

#include "sandbox.h"
#include "utils.h"

// Make sure fd 0,1,2 exists.
inline void RedirectIO(const SandboxParameter &param, int nullfd)
{
    const std::string &std_input = param.stdinRedirection,
                 std_output = param.stdoutRedirection,
                 std_error = param.stderrRedirection;

    int inputfd, outputfd, errorfd;
    if (param.stdinRedirectionFileDescriptor == -1)
    {
        if (std_input != "")
        {
            inputfd = ENSURE(open(std_input.c_str(), O_RDONLY));
        }
        else
        {
            inputfd = nullfd;
        }
    }
    else
    {
        inputfd = param.stdinRedirectionFileDescriptor;
    }
    ENSURE(dup2(inputfd, STDIN_FILENO));

    if (param.stdoutRedirectionFileDescriptor == -1)
    {
        if (std_output != "")
        {
            outputfd = ENSURE(open(std_output.c_str(), O_WRONLY | O_TRUNC | O_CREAT,
                                   S_IWUSR | S_IRUSR | S_IRGRP | S_IWGRP));
        }
        else
        {
            outputfd = nullfd;
        }
    }
    else
    {
        outputfd = param.stdoutRedirectionFileDescriptor;
    }
    ENSURE(dup2(outputfd, STDOUT_FILENO));

    if (param.stderrRedirectionFileDescriptor == -1)
    {
        if (std_error != "")
        {
            if (std_error == std_output)
            {
                errorfd = outputfd;
            }
            else
            {
                errorfd = ENSURE(open(std_error.c_str(), O_WRONLY | O_TRUNC | O_CREAT,
                                      S_IWUSR | S_IRUSR | S_IRGRP | S_IWGRP));
            }
        }
        else
        {
            errorfd = nullfd;
        }
    }
    else
    {
        errorfd = param.stderrRedirectionFileDescriptor;
    }
    ENSURE(dup2(errorfd, STDERR_FILENO));

    // dup2 creates the program's only stdio handles. Retaining the source pipe
    // write end prevents close(stdout) from delivering EOF to its peer.
    // Finish every duplication first: stdout and stderr may share one source.
    const int sources[] = {inputfd, outputfd, errorfd, nullfd};
    for (size_t i = 0; i < 4; ++i)
    {
        if (sources[i] <= STDERR_FILENO) continue;
        bool closed = false;
        for (size_t previous = 0; previous < i; ++previous)
            if (sources[previous] == sources[i]) closed = true;
        if (!closed) ENSURE(close(sources[i]));
    }
    // Other explicitly preserved handles (e.g. shared memory) remain available.
}

