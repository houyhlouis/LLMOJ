// Exercise the private production waiter against ordinary files, without a delegated cgroup.
#include "../native/cgroup.cc"

#include <cassert>

static void CheckEventsClosed(const fs::path &events)
{
    for (const auto &entry : fs::directory_iterator("/proc/self/fd"))
        assert(fs::read_symlink(entry.path()) != events && "cgroup.events descriptor still open");
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    const fs::path directory = fs::canonical(argv[1]);
    const auto events = directory / "cgroup.events";
    std::ofstream(events) << "populated 0\n";
    WaitUntilEmpty(directory);
    CheckEventsClosed(events);

    std::ofstream(events) << "frozen 0\n";
    try
    {
        WaitUntilEmpty(directory);
        return 1;
    }
    catch (const std::runtime_error &error)
    {
        assert(std::string(error.what()) == "Missing key populated in " + events.string());
    }
    CheckEventsClosed(events);
}
