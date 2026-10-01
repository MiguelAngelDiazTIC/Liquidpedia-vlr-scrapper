// npm run apply: copia las imágenes de output/ al Mercado y rellena logoUrl/photoUrl.
// Solo toca los campos que están en null, salvo con --force.
//
// Opciones:
//   --dry-run   enseña lo que cambiaría sin tocar nada
//   --force     sustituye también las imágenes y rutas que ya tenga el Mercado

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OUTPUT, hasFlag, loadConfig, loadMercado, readJson, writeJson } from './lib.mjs';

const dryRun = hasFlag('dry-run');
const force = hasFlag('force');

const mapPath = join(OUTPUT, 'image-map.json');
if (!existsSync(mapPath)) {
  console.error('No hay output/image-map.json. Ejecuta antes: npm start');
  process.exit(1);
}
const map = await readJson(mapPath);
const credits = await readJson(join(OUTPUT, 'image-credits.json'));
const config = await loadConfig();
const publicDir = join(config.mercadoPath, 'public');
const mercado = await loadMercado(config.mercadoPath);

const applied = new Set();
let copied = 0, reused = 0, fields = 0;

async function place(rel) {
  const dest = join(publicDir, rel);
  if (existsSync(dest) && !force) { reused++; return; }
  if (!dryRun) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(OUTPUT, rel), dest);
  }
  copied++;
}

for (const file of mercado) {
  let changed = false;
  for (const region of file.regions) {
    for (const team of region.teams) {
      const entry = map.teams[team.name];
      if (!entry) continue;

      const updates = [];
      if (entry.logo && (team.logoUrl == null || force) && team.logoUrl !== entry.logo) {
        updates.push([team, 'logoUrl', entry.logo, `logo de ${team.name}`]);
      }
      for (const kind of ['players', 'staff']) {
        for (const person of team[kind] ?? []) {
          const rel = entry[kind][person.name];
          if (rel && (person.photoUrl == null || force) && person.photoUrl !== rel) {
            updates.push([person, 'photoUrl', rel, `${person.name} (${team.name})`]);
          }
        }
      }

      for (const [obj, key, rel, label] of updates) {
        console.log(`  ${file.file}: ${label} → ${rel}`);
        await place(rel);
        obj[key] = rel;
        applied.add(rel);
        fields++;
        changed = true;
      }
    }
  }
  if (changed && !dryRun) await writeJson(file.path, file.regions);
}

// Créditos de las imágenes usadas, junto a los que ya hubiera
if (applied.size && !dryRun) {
  const creditsPath = join(publicDir, 'data', 'image-credits.json');
  const all = existsSync(creditsPath) ? await readJson(creditsPath) : {};
  for (const rel of applied) if (credits[rel]) all[rel] = credits[rel];
  await writeJson(creditsPath, Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))));
}

console.log(`\n${dryRun ? '[--dry-run] Cambiaría' : 'Cambiados'}: ${fields} campos, ${copied} imágenes copiadas, ${reused} ya estaban en public/ (se usa la que había).`);
if (dryRun) console.log('Quita --dry-run para aplicarlo.');
else if (fields) console.log('Revisa con "npm run dev" en el Mercado y haz commit cuando te guste.');
