import { button } from '@web/ui/button';
import { add } from '@mono/shared/math';
import fs from 'node:fs';

console.log(button(), add(2, 3), fs);
