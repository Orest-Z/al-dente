package com.acme.shop.service;

import static com.acme.shop.shared.Money.cents;
import com.acme.shop.data.OrderRepository;
import com.acme.shop.shared.Money.Currency;

// import com.acme.shop.web.OrderController;
public class OrderService {
    public long total() {
        com.acme.shop.data.Order first = OrderRepository.all().get(0);
        String name = "com.acme.shop.web.OrderController";
        return cents(first.amount(), Currency.EUR) + name.length();
    }

    public void cancel(long id) {
    }
}
