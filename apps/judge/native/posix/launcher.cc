// System calls the sandbox launcher and the judge need beyond Node.js: a message channel that passes descriptors,
// pinned directories, ownership walks that never follow links, and a few process settings.
#include <cerrno>
#include <cstring>
#include <set>
#include <string>
#include <system_error>
#include <vector>

#include <dirent.h>
#include <fcntl.h>
#include <pwd.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <napi.h>
#include <uv.h>

#include "launcher.h"

namespace
{
// A launcher message is small JSON; anything longer is refused rather than cut short.
constexpr size_t maximumMessage = 64 * 1024;
constexpr size_t maximumDescriptors = 16;

[[noreturn]] void ThrowErrno(Napi::Env env, const std::string &operation)
{
    const auto error = errno;
    throw Napi::Error::New(env, operation + ": " + std::system_category().message(error));
}

std::string ErrnoMessage(const std::string &operation, int error)
{
    return operation + ": " + std::system_category().message(error);
}

Napi::Value SeqpacketPair(const Napi::CallbackInfo &info)
{
    int fds[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, fds) != 0)
        ThrowErrno(info.Env(), "socketpair");
    auto result = Napi::Array::New(info.Env(), 2);
    result.Set((uint32_t)0, fds[0]);
    result.Set((uint32_t)1, fds[1]);
    return result;
}

// One end of a SOCK_SEQPACKET socket: each send is one message of JSON bytes with up to 16 descriptors. Received
// descriptors are close-on-exec. The callback gets (data, descriptors), and (null, []) when the peer is gone.
class Channel : public Napi::ObjectWrap<Channel>
{
public:
    static Napi::Function Define(Napi::Env env)
    {
        return DefineClass(env, "Channel", {InstanceMethod("send", &Channel::Send), InstanceMethod("close", &Channel::Close)});
    }

    Channel(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Channel>(info)
    {
        auto env = info.Env();
        fd = info[0].As<Napi::Number>().Int32Value();
        callback = Napi::Persistent(info[1].As<Napi::Function>());
        context = std::make_unique<Napi::AsyncContext>(env, "LauncherChannel");
        uv_loop_t *loop;
        if (napi_get_uv_event_loop(env, &loop) != napi_ok)
            throw Napi::Error::New(env, "Cannot get the event loop");
        poll = new uv_poll_t;
        if (uv_poll_init(loop, poll, fd) != 0)
        {
            delete poll;
            poll = nullptr;
            throw Napi::Error::New(env, "Cannot watch the channel");
        }
        poll->data = this;
        uv_poll_start(poll, UV_READABLE | UV_DISCONNECT, &Channel::OnReadable);
        // Keeps this object alive while the channel is open
        self = Napi::Persistent(info.This().As<Napi::Object>());
    }

    ~Channel()
    {
        Stop();
    }

private:
    int fd = -1;
    uv_poll_t *poll = nullptr;
    Napi::FunctionReference callback;
    Napi::ObjectReference self;
    std::unique_ptr<Napi::AsyncContext> context;

    void Stop()
    {
        if (poll)
        {
            uv_poll_stop(poll);
            uv_close(reinterpret_cast<uv_handle_t *>(poll), [](uv_handle_t *handle) {
                delete reinterpret_cast<uv_poll_t *>(handle);
            });
            poll = nullptr;
        }
        if (fd != -1)
        {
            close(fd);
            fd = -1;
        }
    }

    Napi::Value Send(const Napi::CallbackInfo &info)
    {
        auto env = info.Env();
        if (fd == -1)
            throw Napi::Error::New(env, "The launcher channel is closed");
        auto data = info[0].As<Napi::Buffer<char>>();
        if (data.Length() == 0 || data.Length() > maximumMessage)
            throw Napi::Error::New(env, "Invalid launcher message size");
        std::vector<int> descriptors;
        if (info.Length() > 1 && info[1].IsArray())
        {
            auto array = info[1].As<Napi::Array>();
            for (uint32_t i = 0; i < array.Length(); i++)
                descriptors.push_back(static_cast<Napi::Value>(array[i]).As<Napi::Number>().Int32Value());
        }
        if (descriptors.size() > maximumDescriptors)
            throw Napi::Error::New(env, "Too many descriptors in one launcher message");

        iovec vector = {data.Data(), data.Length()};
        msghdr message = {};
        message.msg_iov = &vector;
        message.msg_iovlen = 1;
        std::vector<char> control(CMSG_SPACE(sizeof(int) * maximumDescriptors));
        if (!descriptors.empty())
        {
            message.msg_control = control.data();
            message.msg_controllen = CMSG_SPACE(sizeof(int) * descriptors.size());
            auto header = CMSG_FIRSTHDR(&message);
            header->cmsg_level = SOL_SOCKET;
            header->cmsg_type = SCM_RIGHTS;
            header->cmsg_len = CMSG_LEN(sizeof(int) * descriptors.size());
            memcpy(CMSG_DATA(header), descriptors.data(), sizeof(int) * descriptors.size());
        }
        while (sendmsg(fd, &message, MSG_NOSIGNAL) == -1)
        {
            if (errno == EINTR)
                continue;
            ThrowErrno(env, "sendmsg");
        }
        return env.Undefined();
    }

    Napi::Value Close(const Napi::CallbackInfo &info)
    {
        Stop();
        self.Reset();
        return info.Env().Undefined();
    }

    static void OnReadable(uv_poll_t *handle, int status, int events)
    {
        static_cast<Channel *>(handle->data)->Receive();
    }

    void Deliver(Napi::Env env, Napi::Value data, const std::vector<int> &descriptors)
    {
        auto array = Napi::Array::New(env, descriptors.size());
        for (size_t i = 0; i < descriptors.size(); i++)
            array.Set((uint32_t)i, descriptors[i]);
        try
        {
            callback.MakeCallback(Value(), {data, array}, *context);
        }
        catch (const Napi::Error &error)
        {
            // Outside a JavaScript call: report it as an uncaught exception
            napi_fatal_exception(env, error.Value());
        }
    }

    void Receive()
    {
        auto env = Env();
        Napi::HandleScope scope(env);
        // Keep this object (and its callback) alive while delivering, even if the callback closes the channel
        auto keep = Napi::Persistent(Value());
        while (fd != -1)
        {
            std::vector<char> buffer(maximumMessage + 1);
            std::vector<char> control(CMSG_SPACE(sizeof(int) * maximumDescriptors));
            iovec vector = {buffer.data(), buffer.size()};
            msghdr message = {};
            message.msg_iov = &vector;
            message.msg_iovlen = 1;
            message.msg_control = control.data();
            message.msg_controllen = control.size();
            const auto received = recvmsg(fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
            if (received == -1)
            {
                if (errno == EINTR)
                    continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK)
                    return;
                Stop();
                Deliver(env, env.Null(), {});
                return;
            }
            std::vector<int> descriptors;
            for (auto header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header))
                if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS)
                {
                    const auto count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
                    const auto *values = reinterpret_cast<const int *>(CMSG_DATA(header));
                    for (size_t i = 0; i < count; i++)
                        descriptors.push_back(values[i]);
                }
            if (received == 0)
            {
                for (auto descriptor : descriptors)
                    close(descriptor);
                Stop();
                Deliver(env, env.Null(), {});
                return;
            }
            if (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC))
            {
                // A message too long, or with too many descriptors, is a broken peer: end the channel
                for (auto descriptor : descriptors)
                    close(descriptor);
                Stop();
                Deliver(env, env.Null(), {});
                return;
            }
            Deliver(env, Napi::Buffer<char>::Copy(env, buffer.data(), received), descriptors);
        }
    }
};

Napi::Value ListenUnix(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    const auto path = info[0].As<Napi::String>().Utf8Value();
    sockaddr_un address = {};
    address.sun_family = AF_UNIX;
    if (path.empty() || path.size() >= sizeof(address.sun_path))
        throw Napi::Error::New(env, "Invalid socket path");
    memcpy(address.sun_path, path.c_str(), path.size());
    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd == -1)
        ThrowErrno(env, "socket");
    if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 || listen(fd, 64) != 0)
    {
        const auto error = errno;
        close(fd);
        throw Napi::Error::New(env, ErrnoMessage("bind " + path, error));
    }
    return Napi::Number::New(env, fd);
}

Napi::Value NoNewPrivileges(const Napi::CallbackInfo &info)
{
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
        ThrowErrno(info.Env(), "prctl(PR_SET_NO_NEW_PRIVS)");
    return info.Env().Undefined();
}

Napi::Value UserEntry(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    const auto name = info[0].As<Napi::String>().Utf8Value();
    long size = sysconf(_SC_GETPW_R_SIZE_MAX);
    std::vector<char> buffer(size > 0 ? size : 16384);
    passwd entry, *result = nullptr;
    const auto error = getpwnam_r(name.c_str(), &entry, buffer.data(), buffer.size(), &result);
    if (error != 0)
        throw Napi::Error::New(env, ErrnoMessage("getpwnam_r", error));
    if (!result)
        return env.Null();
    auto object = Napi::Object::New(env);
    object.Set("uid", Napi::Number::New(env, entry.pw_uid));
    object.Set("gid", Napi::Number::New(env, entry.pw_gid));
    object.Set("home", entry.pw_dir ? entry.pw_dir : "");
    object.Set("shell", entry.pw_shell ? entry.pw_shell : "");
    return object;
}

// Opens `relative` (components separated by "/") under the directory `root` as an O_PATH descriptor, refusing any
// component that is a symbolic link or not a directory. The descriptor pins the directory: a path through
// /proc/self/fd/N reaches exactly it, whatever is renamed or replaced later.
Napi::Value OpenDirectory(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    const auto root = info[0].As<Napi::String>().Utf8Value();
    const auto relative = info[1].As<Napi::String>().Utf8Value();
    if (root.empty() || root[0] != '/')
        throw Napi::Error::New(env, "The root must be an absolute path");
    int fd = open(root.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd == -1)
        ThrowErrno(env, "open " + root);
    size_t start = 0;
    while (start <= relative.size() && !relative.empty())
    {
        auto end = relative.find('/', start);
        if (end == std::string::npos)
            end = relative.size();
        const auto component = relative.substr(start, end - start);
        start = end + 1;
        if (component.empty() || component == "." || component == "..")
        {
            close(fd);
            throw Napi::Error::New(env, "Invalid path component");
        }
        const int next = openat(fd, component.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        const auto error = errno;
        close(fd);
        if (next == -1)
            throw Napi::Error::New(env, ErrnoMessage("open " + component, error));
        fd = next;
    }
    struct stat status;
    if (fstat(fd, &status) != 0 || !S_ISDIR(status.st_mode))
    {
        close(fd);
        throw Napi::Error::New(env, "Not a directory");
    }
    return Napi::Number::New(env, fd);
}

struct WalkOptions
{
    // Only inodes owned by one of these are changed
    std::set<uid_t> owners;
    // The new owner, or -1 to keep it
    uid_t uid = static_cast<uid_t>(-1);
    gid_t gid = static_cast<gid_t>(-1);
    // `exact`: the modes below replace the permission bits; otherwise they are added to them
    bool exact = false;
    mode_t directoryMode = 0, fileMode = 0;
};

// Changes the owner and mode of the directory tree at a pinned descriptor. It never follows a symbolic link and never
// leaves the directory's file system. Only directories and regular files are changed: links, pipes and sockets are
// left alone, as their owner removes them through the directory. A regular file with more than one link that root
// owns is left alone too.
class WalkWorker : public Napi::AsyncWorker
{
public:
    WalkWorker(Napi::Env env, int root, WalkOptions options)
        : Napi::AsyncWorker(env), root(root), options(std::move(options)), deferred(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise Promise() const { return deferred.Promise(); }

    void Execute() override
    {
        try
        {
            Walk();
        }
        catch (const std::exception &error)
        {
            SetError(error.what());
        }
    }

    void OnOK() override { deferred.Resolve(Napi::Number::New(Env(), changed)); }
    void OnError(const Napi::Error &error) override { deferred.Reject(error.Value()); }

private:
    int root;
    WalkOptions options;
    Napi::Promise::Deferred deferred;
    double changed = 0;

    void Fix(int fd, const struct stat &status)
    {
        if (!options.owners.count(status.st_uid))
            return;
        const bool directory = S_ISDIR(status.st_mode);
        if (status.st_uid == 0 && !directory && status.st_nlink > 1)
            return;
        bool change = false;
        if (options.uid != static_cast<uid_t>(-1) && (status.st_uid != options.uid || status.st_gid != options.gid))
        {
            if (fchown(fd, options.uid, options.gid) != 0)
                throw std::runtime_error(ErrnoMessage("fchown", errno));
            change = true;
        }
        const mode_t bits = directory ? options.directoryMode : options.fileMode;
        const mode_t mode = options.exact ? bits : ((status.st_mode & 0777) | bits);
        // fchown may have cleared set-user-ID bits: compare against what the inode had, and always set the result
        if (change || mode != (status.st_mode & 07777))
        {
            if (fchmod(fd, mode) != 0)
                throw std::runtime_error(ErrnoMessage("fchmod", errno));
            change = true;
        }
        if (change)
            changed++;
    }

    void Walk()
    {
        const int top = openat(root, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (top == -1)
            throw std::runtime_error(ErrnoMessage("open the walked directory", errno));
        struct stat status;
        if (fstat(top, &status) != 0)
        {
            close(top);
            throw std::runtime_error(ErrnoMessage("fstat", errno));
        }
        const auto device = status.st_dev;
        std::vector<DIR *> stack;
        auto cleanup = [&]() {
            for (auto *directory : stack)
                closedir(directory);
            stack.clear();
        };
        try
        {
            Fix(top, status);
            DIR *directory = fdopendir(top);
            if (!directory)
            {
                close(top);
                throw std::runtime_error(ErrnoMessage("fdopendir", errno));
            }
            stack.push_back(directory);
            while (!stack.empty())
            {
                DIR *current = stack.back();
                errno = 0;
                const auto *entry = readdir(current);
                if (!entry)
                {
                    if (errno != 0)
                        throw std::runtime_error(ErrnoMessage("readdir", errno));
                    closedir(current);
                    stack.pop_back();
                    continue;
                }
                const std::string name = entry->d_name;
                if (name == "." || name == "..")
                    continue;
                const int parent = dirfd(current);
                struct stat linkStatus;
                if (fstatat(parent, name.c_str(), &linkStatus, AT_SYMLINK_NOFOLLOW) != 0)
                {
                    if (errno == ENOENT)
                        continue;
                    throw std::runtime_error(ErrnoMessage("fstatat", errno));
                }
                if (linkStatus.st_dev != device)
                    continue;
                if (S_ISDIR(linkStatus.st_mode))
                {
                    const int child = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
                    if (child == -1)
                    {
                        if (errno == ENOENT || errno == ELOOP || errno == ENOTDIR)
                            continue;
                        throw std::runtime_error(ErrnoMessage("open a directory", errno));
                    }
                    struct stat childStatus;
                    if (fstat(child, &childStatus) != 0 || childStatus.st_dev != device || childStatus.st_ino != linkStatus.st_ino)
                    {
                        close(child);
                        continue;
                    }
                    try
                    {
                        Fix(child, childStatus);
                    }
                    catch (...)
                    {
                        close(child);
                        throw;
                    }
                    DIR *opened = fdopendir(child);
                    if (!opened)
                    {
                        close(child);
                        throw std::runtime_error(ErrnoMessage("fdopendir", errno));
                    }
                    stack.push_back(opened);
                }
                else if (S_ISREG(linkStatus.st_mode))
                {
                    if (!options.owners.count(linkStatus.st_uid) || (linkStatus.st_uid == 0 && linkStatus.st_nlink > 1))
                        continue;
                    const int file = openat(parent, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
                    if (file == -1)
                    {
                        if (errno == ENOENT || errno == ELOOP)
                            continue;
                        throw std::runtime_error(ErrnoMessage("open a file", errno));
                    }
                    struct stat fileStatus;
                    if (fstat(file, &fileStatus) == 0 && S_ISREG(fileStatus.st_mode) && fileStatus.st_dev == device &&
                        fileStatus.st_ino == linkStatus.st_ino)
                    {
                        try
                        {
                            Fix(file, fileStatus);
                        }
                        catch (...)
                        {
                            close(file);
                            throw;
                        }
                    }
                    close(file);
                }
            }
        }
        catch (...)
        {
            cleanup();
            throw;
        }
    }
};

Napi::Value WalkOwnership(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    const int fd = info[0].As<Napi::Number>().Int32Value();
    const auto object = info[1].As<Napi::Object>();
    WalkOptions options;
    const auto owners = object.Get("owners").As<Napi::Array>();
    for (uint32_t i = 0; i < owners.Length(); i++)
        options.owners.insert(static_cast<Napi::Value>(owners[i]).As<Napi::Number>().Uint32Value());
    if (object.Has("uid"))
    {
        options.uid = object.Get("uid").As<Napi::Number>().Uint32Value();
        options.gid = object.Get("gid").As<Napi::Number>().Uint32Value();
    }
    options.exact = object.Get("exact").ToBoolean().Value();
    options.directoryMode = object.Get("directoryMode").As<Napi::Number>().Uint32Value() & 07777;
    options.fileMode = object.Get("fileMode").As<Napi::Number>().Uint32Value() & 07777;
    auto worker = new WalkWorker(env, fd, std::move(options));
    worker->Queue();
    return worker->Promise();
}
}

void InitLauncher(Napi::Env env, Napi::Object exports)
{
    exports.Set("seqpacketPair", Napi::Function::New(env, SeqpacketPair));
    exports.Set("Channel", Channel::Define(env));
    exports.Set("listenUnix", Napi::Function::New(env, ListenUnix));
    exports.Set("noNewPrivileges", Napi::Function::New(env, NoNewPrivileges));
    exports.Set("userEntry", Napi::Function::New(env, UserEntry));
    exports.Set("openDirectory", Napi::Function::New(env, OpenDirectory));
    exports.Set("walkOwnership", Napi::Function::New(env, WalkOwnership));
}
