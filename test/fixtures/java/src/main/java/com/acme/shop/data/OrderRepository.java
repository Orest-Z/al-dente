package com.acme.shop.data;

import java.util.List;

public interface OrderRepository {
    static List<Order> all() {
        return List.of(new Order(100));
    }

    Order find(long id);
}
