// Checkout — Java second-package + nested-type fixture (#1028).

package com.example.checkout;

public class CheckoutService {
    public int total() {
        return 0;
    }

    public static class Receipt {
        public String render() {
            return "ok";
        }
    }
}
