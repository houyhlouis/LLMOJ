// The program test/launcher-server.root.cjs runs in its sandboxes (built statically, so the image needs no libraries).
#define _GNU_SOURCE

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc < 2)
        return 100;
    const char *mode = argv[1];
    if (!strcmp(mode, "id"))
    {
        printf("uid=%d gid=%d\n", (int)getuid(), (int)getgid());
        return 0;
    }
    if (!strcmp(mode, "fd") && argc > 2)
    {
        // A descriptor the judge passed, at the judge's own number
        int fd = atoi(argv[2]);
        const char message[] = "through the passed descriptor\n";
        return write(fd, message, sizeof message - 1) == (ssize_t)(sizeof message - 1) ? 0 : 3;
    }
    if (!strcmp(mode, "read") && argc > 2)
    {
        FILE *file = fopen(argv[2], "r");
        if (!file)
            return 4;
        char buffer[256];
        size_t length = fread(buffer, 1, sizeof buffer, file);
        fwrite(buffer, 1, length, stdout);
        return 0;
    }
    if (!strcmp(mode, "write"))
    {
        int fd = open("made-by-sandbox", O_CREAT | O_WRONLY, 0600);
        return fd >= 0 && write(fd, "made\n", 5) == 5 ? 0 : 5;
    }
    if (!strcmp(mode, "hostile") && argc > 2)
    {
        // What a judge must survive without following anything: unreadable directories and files, a pipe, a deep
        // tree, and a link to a file of root's
        mkdir("closed", 0);
        mkdir("hidden", 0700);
        int fd = open("hidden/secret", O_CREAT | O_WRONLY, 0);
        if (fd >= 0)
            close(fd);
        chmod("hidden", 0);
        fd = open("unreadable", O_CREAT | O_WRONLY, 0);
        if (fd >= 0)
            close(fd);
        mkfifo("pipe", 0600);
        symlink(argv[2], "canary");
        for (int i = 0; i < 100; i++)
            if (mkdir("deep", 0700) || chdir("deep"))
                return 6;
        return 0;
    }
    if (!strcmp(mode, "spin"))
        for (volatile unsigned long i = 0;; i++)
            ;
    return 101;
}
