"""HTTP routes for orders.

Example in a docstring, not an import:
from shop.data import repo
"""
from __future__ import annotations
import os, json
from typing import TYPE_CHECKING
from fastapi import APIRouter  # installed package: skipped
# from shop.data import models  (a comment, not an import)
from shop.services import orders
from ..shared.money import (
    format_price,
    parse_price,
)
import shop.data.models as m

if TYPE_CHECKING:
    from shop.data.repo import Repo

router = APIRouter()
