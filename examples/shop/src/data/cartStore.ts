import { db } from './db';
import type { Product } from '../shared/types';

export const cartStore: Product[] = [];
export const addById = (id: string) => { const p = db.get(id); if (p) cartStore.push(p); };
