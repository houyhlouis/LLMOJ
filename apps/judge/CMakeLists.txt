cmake_minimum_required(VERSION 3.15)
project(libreoj-judge)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_FLAGS "-Wall -std=c++17")
set(CMAKE_CXX_FLAGS_DEBUG "-g")
set(CMAKE_CXX_FLAGS_RELEASE "-O2")

include_directories(${CMAKE_JS_INC})

# Builtin Checkers: a program the judge starts for each check (src/checkers/builtin.ts), next to the add-ons
add_executable(
    builtin_checker
    "native/builtin_checkers/builtin_checkers.cc"
    "native/builtin_checkers/integers.h"
    "native/builtin_checkers/floats.h"
    "native/builtin_checkers/lines.h"
    "native/builtin_checkers/tokens.h"
    "native/builtin_checkers/binary.h"
)
set_target_properties(builtin_checker PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}")
target_include_directories(builtin_checker PRIVATE "vendor/testlib")

# POSIX
add_library(
    posix
    SHARED
    ${CMAKE_JS_SRC}
    "native/posix/posix.cc"
    "native/posix/launcher.cc"
    "native/posix/launcher.h"
)
set_target_properties(posix PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(posix PRIVATE 
    ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api 
    ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api/src
    ${CMAKE_JS_INC}
)
target_link_libraries(posix PRIVATE ${CMAKE_JS_LIB})

# fs_native
add_library(
    fs_native
    SHARED
    ${CMAKE_JS_SRC}
    "native/fs_native/fs_native.cc"
)
set_target_properties(fs_native PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(fs_native PRIVATE 
    ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api 
    ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api/src
    ${CMAKE_JS_INC}
)
target_link_libraries(fs_native PRIVATE ${CMAKE_JS_LIB} stdc++fs)
