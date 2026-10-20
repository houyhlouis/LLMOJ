#pragma once

#include <napi.h>

// Adds the launcher's system calls (native/posix/launcher.cc) to the posix addon's exports.
void InitLauncher(Napi::Env env, Napi::Object exports);
