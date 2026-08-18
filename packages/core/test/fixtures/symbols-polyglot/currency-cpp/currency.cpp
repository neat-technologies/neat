// Currency conversion — C++ symbol-grain extraction fixture (#1040).
#include "money.hpp"
#include <string>

namespace currency {

class CurrencyService {
public:
  CurrencyService(double base_rate);
  Money convert(const Money& amount, const std::string& to) const;
  bool supports(const std::string& code) const {
    return code.size() == 3;
  }

private:
  double base_rate_;
};

CurrencyService::CurrencyService(double base_rate) : base_rate_(base_rate) {}

Money CurrencyService::convert(const Money& amount, const std::string& to) const {
  // An observed DB span's code.lineno points inside this method.
  long units = static_cast<long>(amount.units() * base_rate_);
  return Money{to, units};
}

template <typename T>
T clamp_non_negative(T value) {
  return value < 0 ? 0 : value;
}

double round_rate(double rate) {
  return clamp_non_negative(rate);
}

}  // namespace currency
