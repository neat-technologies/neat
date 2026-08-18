// Checkout — Kotlin second-package + nested-type fixture (#1034).

package com.example.checkout

class CheckoutService {
    fun total(): Int {
        return 0
    }

    class Receipt {
        fun render(): String {
            return "ok"
        }
    }
}

fun topLevelHelper(): Int = 42
