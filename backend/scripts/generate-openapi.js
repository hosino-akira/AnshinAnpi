import { mkdir, writeFile } from 'node:fs/promises';
import { openApiDocument } from '../src/openapi.js';
await mkdir(new URL('../docs/',import.meta.url),{ recursive:true });
await writeFile(new URL('../docs/openapi.json',import.meta.url),JSON.stringify(openApiDocument(),null,2)+'\n');
console.log('Generated backend/docs/openapi.json');
