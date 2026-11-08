cmake_minimum_required(VERSION 3.16)
# The board is fixed, so keep the target in the project instead of relying on
# an out-of-band `idf.py set-target`. VS Code / idf.py both pick this up.
set(IDF_TARGET "esp32c6")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(codex_air_remote)
