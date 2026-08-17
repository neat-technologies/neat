// Fraud service — Kotlin symbol-grain extraction fixture (#1034).

package com.example.fraud

class FraudService(private val repo: FraudRepo) {
    constructor() : this(NoopRepo)

    fun check(userId: String, amount: Double): Boolean {
        // An observed DB span's code.lineno points inside this method.
        return repo.lookup(userId) && amount < defaultRate()
    }

    fun defaultRate(): Double {
        return 1000.0
    }

    companion object {
        fun threshold(): Double = 500.0
    }
}

interface FraudRepo {
    fun lookup(userId: String): Boolean
}

object NoopRepo : FraudRepo {
    override fun lookup(userId: String): Boolean = false
}

object FraudRegistry {
    fun register(name: String) {}
}

enum class Decision {
    ALLOW,
    DENY
}

data class Score(val userId: String, val value: Int)
