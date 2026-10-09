/*
 * Licensed under the MIT License.
 */
package com.acme.shop.web;

import com.acme.shop.data.*; // a whole package: only the classes this file uses from it count
import com.acme.shop.service.OrderService;
import java.util.List;

/**
 * HTTP endpoints for orders, backed by {@link OrderService}.
 * <p>More detail that isn't the summary.
 */
@SuppressWarnings({"unused"})
public class OrderController {
    private final OrderService orders = new OrderService();

    public List<Order> list() {
        return OrderRepository.all();
    }

    public String help() {
        return """
            import com.acme.shop.data.Status;
            """;
    }
}
