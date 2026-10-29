cmake_minimum_required(VERSION 3.20)
project(kyp VERSION 0.1.0 LANGUAGES CXX)

# Keep Your Prompts C++ SDK. Consumers only need:
#   FetchContent_Declare(kyp GIT_REPOSITORY https://github.com/keep-your-prompts/keep-your-prompts-sdk
#                        GIT_TAG cpp-v0.1.0 SOURCE_SUBDIR cpp)
#   FetchContent_MakeAvailable(kyp)
#   target_link_libraries(app PRIVATE kyp::kyp)

if(CMAKE_SOURCE_DIR STREQUAL PROJECT_SOURCE_DIR)
  set(KYP_TOP_LEVEL ON)
else()
  set(KYP_TOP_LEVEL OFF)
endif()

option(KYP_WITH_CURL      "Fetch over HTTP(S) with libcurl (off = snapshot/disk mirrors only)" ON)
option(KYP_USE_SYSTEM_JSON "Use an installed nlohmann_json instead of fetching it"             OFF)
option(KYP_BUILD_TESTS    "Build the kyp tests"                                                ${KYP_TOP_LEVEL})
option(KYP_BUILD_EXAMPLES "Build the kyp examples"                                             ${KYP_TOP_LEVEL})
option(KYP_BUILD_TOOLS    "Build the kyp-snapshot tool"                                        ${KYP_TOP_LEVEL})
option(KYP_WARNINGS_AS_ERRORS "Compile kyp's own targets with -Wall -Wextra -Werror"           ${KYP_TOP_LEVEL})
option(KYP_WITH_OTEL      "Add kyp::otel (<kyp/otel.hpp>) on the opentelemetry-cpp API"       OFF)

# --- dependencies -----------------------------------------------------------
if(NOT TARGET nlohmann_json::nlohmann_json)
  if(KYP_USE_SYSTEM_JSON)
    find_package(nlohmann_json 3.11 REQUIRED)
  else()
    include(FetchContent)
    FetchContent_Declare(nlohmann_json
      URL      https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
      URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
      DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(nlohmann_json)
  endif()
endif()

if(KYP_WITH_CURL)
  find_package(CURL REQUIRED)
endif()
find_package(Threads REQUIRED)

# --- warnings ---------------------------------------------------------------
add_library(kyp_warnings INTERFACE)
if(KYP_WARNINGS_AS_ERRORS)
  if(MSVC)
    target_compile_options(kyp_warnings INTERFACE /W4 /WX)
  else()
    target_compile_options(kyp_warnings INTERFACE -Wall -Wextra -Werror)
  endif()
endif()

# --- library ----------------------------------------------------------------
add_library(kyp
  src/sha256.cpp
  src/template.cpp
  src/manifest.cpp
  src/fetch.cpp
  src/embedded.cpp
  src/telemetry.cpp
  src/client.cpp)
add_library(kyp::kyp ALIAS kyp)
target_compile_features(kyp PUBLIC cxx_std_17)
target_include_directories(kyp PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_link_libraries(kyp
  PUBLIC  Threads::Threads
  PRIVATE $<BUILD_INTERFACE:nlohmann_json::nlohmann_json> $<BUILD_INTERFACE:kyp_warnings>)
if(KYP_WITH_CURL)
  target_link_libraries(kyp PRIVATE CURL::libcurl)
  target_compile_definitions(kyp PRIVATE KYP_WITH_CURL=1)
endif()
set_target_properties(kyp PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE ON)

# --- OpenTelemetry adapter (optional) ---------------------------------------
# <kyp/tracing.hpp> (any tracer, no dependency) is always available through kyp::kyp.
# kyp::otel adds the header-only <kyp/otel.hpp> and the opentelemetry-cpp API.
if(KYP_WITH_OTEL)
  if(NOT TARGET opentelemetry-cpp::api)
    find_package(opentelemetry-cpp CONFIG REQUIRED)
  endif()
  add_library(kyp_otel INTERFACE)
  add_library(kyp::otel ALIAS kyp_otel)
  target_link_libraries(kyp_otel INTERFACE kyp::kyp opentelemetry-cpp::api)
endif()

# kyp_embed_snapshot(<target> DIR <snapshot-dir>)
include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/kyp_embed.cmake)

# --- tools, examples, tests -------------------------------------------------
if(KYP_BUILD_TOOLS)
  add_executable(kyp-snapshot tools/kyp-snapshot/main.cpp)
  target_link_libraries(kyp-snapshot PRIVATE kyp::kyp kyp_warnings)
endif()

if(KYP_BUILD_EXAMPLES)
  foreach(ex hello server bench)
    add_executable(kyp-example-${ex} examples/${ex}/main.cpp)
    target_link_libraries(kyp-example-${ex} PRIVATE kyp::kyp kyp_warnings)
  endforeach()
  # The bench and server examples run with zero files and zero network.
  kyp_embed_snapshot(kyp-example-bench  DIR examples/snapshot)
  kyp_embed_snapshot(kyp-example-server DIR examples/snapshot)
endif()

if(KYP_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
