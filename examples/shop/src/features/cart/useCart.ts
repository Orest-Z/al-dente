import { cartStore, addById } from '@/data/cartStore';
import { formatPrice } from '@/shared/format';

export const useCart = () => ({ add: addById, total: formatPrice(cartStore.reduce((s, p) => s + p.price, 0)) });
