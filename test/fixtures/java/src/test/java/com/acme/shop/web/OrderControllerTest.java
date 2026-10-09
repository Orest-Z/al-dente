package com.acme.shop.web;

import com.acme.shop.data.OrderRepository;

class OrderControllerTest {
    void lists() {
        assert OrderRepository.all().size() == new OrderController().list().size();
    }
}
