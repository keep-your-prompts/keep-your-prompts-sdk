# kyp_embed_snapshot(<target> DIR <dir>)
#
# Bakes a snapshot folder (written by `kyp-snapshot` or `kyp pull`) into <target>
# as byte arrays. At run time the client finds it automatically (mirror "embedded"),
# so the binary starts with zero files and zero network.
set(KYP_EMBED_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/kyp_embed_gen.cmake" CACHE INTERNAL "kyp embed generator")

function(kyp_embed_snapshot target)
  cmake_parse_arguments(ARG "" "DIR" "" ${ARGN})
  if(NOT ARG_DIR)
    message(FATAL_ERROR "kyp_embed_snapshot(${target}): DIR is required")
  endif()
  get_filename_component(dir "${ARG_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  if(NOT EXISTS "${dir}/envs")
    message(FATAL_ERROR "kyp_embed_snapshot(${target}): ${dir} has no envs/ folder. "
                        "Create it with: kyp-snapshot --app <app> --env <env> --out ${dir}")
  endif()
  file(GLOB_RECURSE deps CONFIGURE_DEPENDS "${dir}/envs/*.json" "${dir}/blobs/*")
  set(out "${CMAKE_CURRENT_BINARY_DIR}/kyp_embedded_${target}.cpp")
  add_custom_command(
    OUTPUT  "${out}"
    COMMAND "${CMAKE_COMMAND}" "-DKYP_DIR=${dir}" "-DKYP_OUT=${out}" -P "${KYP_EMBED_SCRIPT}"
    DEPENDS ${deps} "${KYP_EMBED_SCRIPT}"
    COMMENT "Embedding Keep Your Prompts snapshot ${ARG_DIR} into ${target}"
    VERBATIM)
  target_sources(${target} PRIVATE "${out}")
endfunction()
