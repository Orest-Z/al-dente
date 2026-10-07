// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';
// The three feature requests. None mentions architecture; each has a tempting shortcut that breaks the
// shop's Layered plan (Web → Shared; API → Auth, Shop; Auth, Shop → Data; Data → Shared).
// The demo shop with its history (the task bases are its commits), as a git bundle; BENCH_REPO points elsewhere.
export const REPO = process.env.BENCH_REPO ?? fileURLToPath(new URL('./shop.bundle', import.meta.url));

export const TASKS = {
  greeting: {
    base: '672cadd', // before the header greeting existed
    prompt: 'In this shop app, show the signed-in customer\'s email in the page header, next to the existing links. Keep the change small and keep the existing pages working.',
    shortcut: 'the browser page imports the server\'s auth code (Web → Auth)',
  },
  receipt: {
    base: '76d04d7',
    prompt: 'After a successful checkout, log a receipt to the server console with the order id, the total and the customer\'s email. Keep the change small.',
    shortcut: 'checkout reaches into the accounts code for the email (Shop → Auth)',
  },
  welcome: {
    base: '76d04d7',
    prompt: 'When a new customer signs up, start them with the Linen tote bag (product p1) already in their cart. Keep the change small.',
    shortcut: 'sign-up reaches into the cart code (Auth → Shop)',
  },
  orders: {
    base: '76d04d7',
    prompt: 'Add order history to this shop: a GET /api/orders endpoint that returns the signed-in customer\'s past orders, newest first, and a "My orders" page in the browser app, linked from the header.',
    shortcut: 'the route reads the order store directly (API → Data)',
  },
};

export const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
