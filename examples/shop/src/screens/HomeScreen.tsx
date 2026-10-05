import { ProductCard } from '@/components/ProductCard';
import { useCart } from '@/features/cart/useCart';

export const HomeScreen = () => { const cart = useCart(); return <main><ProductCard p={{ id: '1', name: 'Pasta', price: 4 }} />{cart.total}</main>; };
