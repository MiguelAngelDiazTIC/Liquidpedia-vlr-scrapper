// npm start: busca en Liquipedia los equipos, jugadores y staff del Mercado y
// descarga sus imágenes en output/. No toca nada del Mercado (eso es npm run apply).
//
// Opciones:
//   --dry-run          solo busca y genera el informe, sin descargar
//   --force            vuelve a descargar aunque la imagen ya esté en output/
//   --refresh          ignora la caché de la API
//   --only=logos,players,staff
//   --region=emea      solo los archivos teams*.json cuyo nombre contenga esto

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  OUTPUT, ROOT, createApi, flagValue, hasFlag, infoboxImage, infoboxTeams, isDisambiguation,
  loadConfig, loadMercado, normalizeName, pageLinks, parseInfobox, readJson, slugify, writeJson,
} from './lib.mjs';

const KINDS = ['logos', 'players', 'staff'];
const only = new Set((flagValue('only') ?? KINDS.join(',')).split(',').map(s => s.trim()));
const region = flagValue('region')?.toLowerCase();
const dryRun = hasFlag('dry-run');
const force = hasFlag('force');

const config = await loadConfig();
if (config.userAgent.includes('PON-AQUI-TU-EMAIL')) {
  console.error('Antes de empezar, pon tu email en "userAgent" de config.json (Liquipedia lo pide para contactarte si hay algún problema).');
  process.exit(1);
}
const api = createApi(config, { refresh: hasFlag('refresh') });
const titlesPath = join(ROOT, 'titles.json');
const overrides = await readJson(titlesPath);
overrides.teams ??= {};
overrides.people ??= {};

const mercado = (await loadMercado(config.mercadoPath))
  .filter(f => !region || f.file.toLowerCase().includes(region));
const teams = mercado.flatMap(f => f.regions.flatMap(r => r.teams.map(t => ({ ...t, file: f.file }))));
console.log(`Mercado: ${teams.length} equipos en ${mercado.map(f => f.file).join(', ')}`);

const report = { teamsNotFound: [], notFound: [], ambiguous: [], noImage: [], teamMismatch: [], failed: [] };

// ─── 1. Equipos ───────────────────────────────────────────
// Hacen falta siempre: sirven para elegir bien en los nombres ambiguos.

console.log('\n1/4 Buscando equipos…');
const teamPage = new Map(); // nombre en el Mercado -> { title, infobox }

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
}

const firstTry = teams.map(t => {
  const o = overrides.teams[t.name];
  return o === null ? [] : o ? [o] : [t.name, titleCase(t.name)];
});
const found = await api.pages(firstTry.flat());
const pending = [];
teams.forEach((t, i) => {
  if (overrides.teams[t.name] === null) return;
  for (const title of firstTry[i]) {
    const page = found.get(title);
    const infobox = page && parseInfobox(page.content);
    if (infobox?.type.startsWith('team')) { teamPage.set(t.name, { title: page.title, infobox }); return; }
  }
  if (overrides.teams[t.name]) report.teamsNotFound.push(`${t.name} (la página "${overrides.teams[t.name]}" de titles.json no es de un equipo)`);
  else pending.push(t);
});

for (const t of pending) {
  const results = await api.search(t.name);
  const pages = await api.pages(results);
  const hit = results.map(r => pages.get(r)).find(p => p && parseInfobox(p.content)?.type.startsWith('team'));
  if (hit) teamPage.set(t.name, { title: hit.title, infobox: parseInfobox(hit.content) });
  else report.teamsNotFound.push(t.name);
}

// Se guardan para no repetir la búsqueda y para que puedas corregirlos
for (const [name, { title }] of teamPage) overrides.teams[name] ??= title;
await writeFile(titlesPath, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
console.log(`  ${teamPage.size}/${teams.length} equipos encontrados`);

// ─── 2. Jugadores y staff ─────────────────────────────────

console.log('\n2/4 Buscando jugadores y staff…');
const people = []; // { team, kind, name, candidate }
for (const t of teams) {
  for (const [kind, list] of [['players', t.players], ['staff', t.staff]]) {
    if (!only.has(kind)) continue;
    for (const p of list ?? []) {
      const o = overrides.people[p.name];
      if (o === null) continue;
      people.push({ team: t.name, kind, name: p.name, candidate: o ?? p.name });
    }
  }
}

const isPerson = infobox => infobox && !infobox.type.startsWith('team');

function sameTeam(infobox, teamName) {
  const ours = [teamName, teamPage.get(teamName)?.title].filter(Boolean).map(normalizeName);
  return infoboxTeams(infobox.params).map(normalizeName)
    .some(theirs => theirs && ours.some(o => o === theirs || o.includes(theirs) || theirs.includes(o)));
}

const personPages = await api.pages(people.map(p => p.candidate));
const disambig = [];
for (const p of people) {
  const page = personPages.get(p.candidate);
  if (!page) { report.notFound.push(`${p.name} (${p.team})`); continue; }
  if (isDisambiguation(page.content)) { disambig.push({ p, options: pageLinks(page.content) }); continue; }
  const infobox = parseInfobox(page.content);
  if (!isPerson(infobox)) { report.notFound.push(`${p.name} (${p.team}): "${page.title}" no es la página de una persona`); continue; }
  p.page = { title: page.title, infobox };
  const theirTeams = infoboxTeams(infobox.params);
  if (theirTeams.length && !sameTeam(infobox, p.team)) {
    report.teamMismatch.push(`${p.name} (${p.team}): Liquipedia dice "${theirTeams.join(', ')}" en "${page.title}"`);
  }
}

// Nombres ambiguos: se elige la opción cuyo equipo coincide con el del Mercado
if (disambig.length) {
  const optionPages = await api.pages(disambig.flatMap(d => d.options));
  for (const { p, options } of disambig) {
    const candidates = options.map(o => optionPages.get(o))
      .filter(Boolean).map(page => ({ title: page.title, infobox: parseInfobox(page.content) }))
      .filter(o => isPerson(o.infobox));
    const matches = candidates.filter(o => sameTeam(o.infobox, p.team));
    if (matches.length === 1) p.page = matches[0];
    else report.ambiguous.push(`${p.name} (${p.team}): ${candidates.map(o => `"${o.title}"`).join(', ') || 'sin opciones'}`);
  }
}
console.log(`  ${people.filter(p => p.page).length}/${people.length} personas encontradas`);

// ─── 3. Imágenes ──────────────────────────────────────────

console.log('\n3/4 Buscando las imágenes…');
const items = []; // { team, kind, name, page, file }
if (only.has('logos')) {
  for (const [name, page] of teamPage) {
    // El Mercado tiene fondo claro: primero el logo normal, si no el de modo oscuro
    const file = infoboxImage(page.infobox.params, ['image', 'imagelight', 'imagedark']);
    if (file) items.push({ team: name, kind: 'logos', name, page: page.title, file });
    else report.noImage.push(`Logo de ${name} ("${page.title}")`);
  }
}
for (const p of people.filter(p => p.page)) {
  const file = infoboxImage(p.page.infobox.params);
  if (file) items.push({ team: p.team, kind: p.kind, name: p.name, page: p.page.title, file });
  else report.noImage.push(`${p.name} (${p.team}) en "${p.page.title}"`);
}
const infos = await api.imageInfo(items.map(i => i.file), config.thumbWidth);

// ─── 4. Descarga ──────────────────────────────────────────

const toDownload = items.filter(i => {
  i.info = infos.get(i.file);
  if (!i.info?.url) { report.noImage.push(`${i.name} (${i.team}): el archivo "${i.file}" no existe`); return false; }
  const ext = (extname(new URL(i.info.url).pathname) || '.png').toLowerCase();
  i.rel = `/${i.kind}/${slugify(i.page)}${ext}`;
  i.path = join(OUTPUT, i.rel);
  return true;
});

console.log(`\n4/4 ${dryRun ? 'Sin descargar (--dry-run)' : 'Descargando'}: ${toDownload.length} imágenes…`);
const map = { generatedAt: new Date().toISOString(), teams: {} };
const credits = {};
let done = 0, skipped = 0;
for (const i of toDownload) {
  if (!dryRun) {
    if (existsSync(i.path) && !force) skipped++;
    else {
      try {
        await api.download(i.info.url, i.path);
        done++;
        if (done % 25 === 0) console.log(`  ${done} descargadas…`);
      } catch (err) {
        report.failed.push(`${i.name} (${i.team}): ${err.message}`);
        continue;
      }
    }
  }
  const entry = map.teams[i.team] ??= { logo: null, players: {}, staff: {} };
  if (i.kind === 'logos') entry.logo = i.rel;
  else entry[i.kind][i.name] = i.rel;
  credits[i.rel] = {
    source: 'Liquipedia',
    page: `https://liquipedia.net/valorant/${encodeURIComponent(i.page.replace(/ /g, '_'))}`,
    file: i.info.descriptionUrl,
    license: i.info.license,
    author: i.info.artist,
  };
}

if (!dryRun) {
  await writeJson(join(OUTPUT, 'image-map.json'), map);
  await writeJson(join(OUTPUT, 'image-credits.json'), credits);
}

// ─── Informe ──────────────────────────────────────────────

const sections = [
  ['Equipos no encontrados (añádelos en titles.json → teams)', report.teamsNotFound],
  ['Personas sin página en Liquipedia (corrige el nombre en titles.json → people)', report.notFound],
  ['Nombres ambiguos sin decidir (elige una página y ponla en titles.json → people)', report.ambiguous],
  ['Equipo distinto en Liquipedia (revisa que sea la persona correcta)', report.teamMismatch],
  ['Sin imagen en Liquipedia', report.noImage],
  ['Errores de descarga', report.failed],
];
const lines = [
  `Informe ${new Date().toLocaleString('es-ES')}`,
  `Imágenes: ${toDownload.length} encontradas, ${done} descargadas, ${skipped} ya estaban en output/${dryRun ? ' (--dry-run: no se descargó nada)' : ''}`,
  '',
  ...sections.flatMap(([title, list]) => list.length ? [`${title}: ${list.length}`, ...list.map(l => `  - ${l}`), ''] : []),
];
const text = lines.join('\n');
await mkdir(OUTPUT, { recursive: true });
await writeFile(join(OUTPUT, 'report.txt'), text + '\n', 'utf8');
console.log('\n' + text);
console.log(dryRun ? 'Quita --dry-run para descargar.' : 'Revisa output/ y después ejecuta: npm run apply -- --dry-run');
