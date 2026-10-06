import importlib
from shop.data.repo import save, load
from . import pricing

plugins = importlib.import_module("shop.data.plugins")


class OrderService:
    """Places and cancels orders.

    More detail here.
    """

    def place(self, order):
        save(order)
