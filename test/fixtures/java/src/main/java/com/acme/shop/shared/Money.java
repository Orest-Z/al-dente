package com.acme.shop.shared;

public final class Money {
    public enum Currency { EUR, USD }

    private Money() {
    }

    public static long cents(long amount, Currency currency) {
        return amount * 100;
    }
}
