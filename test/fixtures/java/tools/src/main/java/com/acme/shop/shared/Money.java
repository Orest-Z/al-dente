package com.acme.shop.shared;

/** The tools module's own copy of Money, under the same name. */
public final class Money {
    public static String format(long cents) {
        return cents / 100 + "." + cents % 100;
    }
}
