// Money value type — C++ header fixture (#1040), proves .hpp extraction.
#pragma once
#include <string>
#include <utility>

namespace currency {

class Money {
public:
  Money(std::string code, long units) : code_(std::move(code)), units_(units) {}
  long units() const { return units_; }
  const std::string& code() const { return code_; }

private:
  std::string code_;
  long units_;
};

struct Rate {
  std::string from;
  std::string to;
  double factor;
};

}  // namespace currency
