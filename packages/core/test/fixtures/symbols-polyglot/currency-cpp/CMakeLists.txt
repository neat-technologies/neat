# Currency service — C++ discovery fixture (#1040), the otel-demo `currency` shape.
cmake_minimum_required(VERSION 3.26)
project(currency)

add_executable(currency currency.cpp)
install(TARGETS currency DESTINATION bin)
