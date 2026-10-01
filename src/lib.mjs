// Utilidades compartidas: configuración, lectura del Mercado, cliente de la API
// de Liquipedia (con pausa entre peticiones y caché en disco) y lectura de infoboxes.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'output');
const CACHE = join(ROOT, '.cache', 'api');

export const args = process.argv.slice(2);
export const hasFlag = name => args.includes(`--${name}`);
export function flagValue(name) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Mismo formato que los JSON del Mercado (2 espacios y salto de línea final)
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function loadConfig() {
  const config = await readJson(join(ROOT, 'config.json'));
  config.mercadoPath = resolve(ROOT, config.mercadoPath);
  return config;
}

// Archivos de equipos del Mercado: public/data/teams*.json
export async function loadMercado(mercadoPath) {
  const dataDir = join(mercadoPath, 'public', 'data');
  if (!existsSync(dataDir)) {
    throw new Error(`No encuentro ${dataDir}. Revisa "mercadoPath" en config.json.`);
  }
  const files = (await readdir(dataDir)).filter(f => /^teams.*\.json$/i.test(f)).sort();
  const out = [];
  for (const file of files) {
    const path = join(dataDir, file);
    out.push({ file, path, regions: await readJson(path) });
  }
  return out;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Nombre de archivo: minúsculas, sin tildes ni espacios
export function slugify(text) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sin-nombre';
}

// Para comparar nombres de equipo: "BARÇA ESPORTS" ~ "Barça eSports"
export function normalizeName(text) {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Cliente de la API ────────────────────────────────────
// Condiciones de Liquipedia: 1 petición cada 2 s como mucho, user-agent propio,
// gzip y caché. https://liquipedia.net/api-terms-of-use

export function createApi(config, { refresh = false } = {}) {
  let last = 0;
  const maxAge = config.cacheDays * 24 * 3600 * 1000;
  const headers = { 'User-Agent': config.userAgent, 'Accept-Encoding': 'gzip' };

  async function throttle(delay) {
    const wait = last + delay - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  }

  async function get(params) {
    const qs = new URLSearchParams({ ...params, format: 'json', formatversion: '2' });
    const url = `${config.apiUrl}?${qs}`;
    const cacheFile = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');

    if (!refresh && existsSync(cacheFile)) {
      const cached = await readJson(cacheFile);
      if (Date.now() - cached.time < maxAge) return cached.data;
    }

    for (let attempt = 1; ; attempt++) {
      await throttle(config.apiDelayMs);
      const res = await fetch(url, { headers });
      if (res.status === 429 && attempt <= 3) {
        console.warn(`  Liquipedia pide ir más despacio (429). Espero ${attempt} min…`);
        await sleep(attempt * 60_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
      const data = await res.json();
      if (data.error) throw new Error(`API: ${data.error.info ?? data.error.code}`);
      await writeJson(cacheFile, { time: Date.now(), data });
      return data;
    }
  }

  // Sigue normalizaciones y redirecciones: título pedido -> título final
  function resolveTitles(query) {
    const map = new Map();
    for (const n of query.normalized ?? []) map.set(n.from, n.to);
    const redirects = new Map((query.redirects ?? []).map(r => [r.from, r.to]));
    return title => {
      let t = map.get(title) ?? title;
      for (let i = 0; i < 5 && redirects.has(t); i++) t = redirects.get(t);
      return t;
    };
  }

  // Contenido wikitext de varias páginas, de 50 en 50.
  // Devuelve Map: título pedido -> { title, content } o null si no existe.
  async function pages(titles) {
    const result = new Map();
    const unique = [...new Set(titles)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const data = await get({
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
        redirects: '1', titles: batch.join('|'),
      });
      const query = data.query ?? {};
      const finalTitle = resolveTitles(query);
      const byTitle = new Map((query.pages ?? []).map(p => [p.title, p]));
      for (const t of batch) {
        const page = byTitle.get(finalTitle(t));
        const content = page?.revisions?.[0]?.slots?.main?.content;
        result.set(t, page && !page.missing && content != null ? { title: page.title, content } : null);
      }
    }
    return result;
  }

  async function search(text, limit = 5) {
    const data = await get({ action: 'opensearch', search: text, limit: String(limit), namespace: '0', redirects: 'resolve' });
    return Array.isArray(data) ? data[1] ?? [] : [];
  }

  // URL de miniatura y datos de licencia de varios archivos.
  // Devuelve Map: nombre de archivo pedido -> info o null.
  async function imageInfo(fileNames, width) {
    const result = new Map();
    const unique = [...new Set(fileNames)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const data = await get({
        action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: String(width),
        iiextmetadatafilter: 'LicenseShortName|Artist|Credit',
        titles: batch.map(f => `File:${f}`).join('|'),
      });
      const query = data.query ?? {};
      const finalTitle = resolveTitles(query);
      const byTitle = new Map((query.pages ?? []).map(p => [p.title, p]));
      for (const f of batch) {
        const info = byTitle.get(finalTitle(`File:${f}`))?.imageinfo?.[0];
        if (!info) { result.set(f, null); continue; }
        const meta = info.extmetadata ?? {};
        result.set(f, {
          url: info.thumburl ?? info.url,
          descriptionUrl: info.descriptionurl ?? null,
          license: stripHtml(meta.LicenseShortName?.value),
          artist: stripHtml(meta.Artist?.value ?? meta.Credit?.value),
        });
      }
    }
    return result;
  }

  async function download(url, path) {
    await throttle(config.downloadDelayMs);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }

  return { pages, search, imageInfo, download };
}

function stripHtml(text) {
  if (!text) return null;
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
}

// ─── Wikitext ─────────────────────────────────────────────

// Primer {{Infobox ...}} de la página: { type: 'player', params: { image: '...' } }
export function parseInfobox(content) {
  const start = content.search(/\{\{\s*Infobox[\s_]/i);
  if (start < 0) return null;

  // Recorre hasta cerrar las llaves, partiendo por "|" solo en el primer nivel
  const parts = [];
  let depth = 0, current = '';
  for (let i = start; i < content.length; i++) {
    const two = content.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; current += two; i++; continue; }
    if (two === '}}' || two === ']]') {
      depth--;
      if (depth === 0) { parts.push(current); break; }
      current += two; i++; continue;
    }
    if (content[i] === '|' && depth === 1) { parts.push(current); current = ''; continue; }
    current += content[i];
  }

  const type = parts[0].replace(/^\{\{\s*Infobox[\s_]+/i, '').trim().toLowerCase();
  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (key) params[key] = value;
  }
  return { type, params };
}

export function isDisambiguation(content) {
  return /\{\{\s*(disambig|disambiguation|dab)\b/i.test(content) || content.includes('__DISAMBIG__');
}

// Enlaces [[Página]] de una página de desambiguación (sin archivos ni categorías)
export function pageLinks(content) {
  const links = new Set();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const title = m[1].trim();
    if (title && !title.includes(':')) links.add(title);
  }
  return [...links];
}

// Nombre del archivo de imagen del infobox, sin el prefijo "File:"
export function infoboxImage(params, keys = ['image', 'imagedark']) {
  for (const key of keys) {
    const v = params[key];
    if (v) return v.replace(/^(File|Image|Archivo):/i, '').trim();
  }
  return null;
}

// Equipos que aparecen en el infobox de una persona (team, team2, ...)
export function infoboxTeams(params) {
  return Object.entries(params)
    .filter(([k, v]) => /^team\d*$/.test(k) && v)
    .map(([, v]) => v.replace(/\[\[|\]\]/g, '').split('|')[0].trim());
}
