import { formatPrice } from '@/shared/format';
import type { Product } from '@/shared/types';

export const ProductCard = ({ p }: { p: Product }) => <div>{p.name} {formatPrice(p.price)}</div>;
