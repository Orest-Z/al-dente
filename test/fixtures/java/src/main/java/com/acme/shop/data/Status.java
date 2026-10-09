package com.acme.shop.data;

public enum Status {
    NEW, PAID("p"), SHIPPED {
        @Override
        public String toString() { return "shipped"; }
    }, CANCELLED;

    Status() {
    }

    Status(String code) {
    }
}
