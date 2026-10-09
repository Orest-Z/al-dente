package com.acme.shop;

import com.acme.shop.web.OrderController;

public class App {
    public static void main(String[] args) {
        System.out.println(new OrderController().list());
    }
}
