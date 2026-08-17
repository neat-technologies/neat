// Cart service — Java symbol-grain extraction fixture (#1028).

package com.example.cart;

public class CartService {
    private final ICartRepo repo;

    public CartService(ICartRepo repo) {
        this.repo = repo;
    }

    public Cart addItem(String userId, Item item) {
        // An observed DB span's code.lineno points inside this method.
        return repo.save(userId, item);
    }

    public static double defaultRate() {
        return 1.0;
    }
}

interface ICartRepo {
    Cart save(String userId, Item item);
}

enum Status {
    OPEN,
    CLOSED
}

record Item(String id, int qty) {}
