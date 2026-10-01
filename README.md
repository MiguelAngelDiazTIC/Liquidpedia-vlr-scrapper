# VLR Image Scraper

Descarga de [Liquipedia](https://liquipedia.net/valorant) las fotos de jugadores y staff y los logos de los equipos que aparecen en **Mercado Fichajes VLR**. Es un proyecto aparte: lee los JSON del Mercado, pero solo los modifica cuando tú ejecutas `npm run apply`.

Solo usa la API oficial de Liquipedia y respeta [sus condiciones](https://liquipedia.net/api-terms-of-use): una petición cada 2 segundos, user-agent con tu contacto y caché en disco.

## Requisitos

- Node 20 o superior. No hace falta `npm install`, porque no tiene dependencias.
- Las dos carpetas juntas:

```
proyectos/
├── Mercado-Fichajes-VLR/
└── vlr-image-scraper/
```

Si el Mercado está en otro sitio, cambia `mercadoPath` en `config.json`.

## Antes de la primera vez

Abre `config.json` y cambia `PON-AQUI-TU-EMAIL` por tu email. Liquipedia lo pide para poder avisarte si algo va mal en vez de bloquearte.

## Uso

```bash
# 1. Busca y descarga en output/ (no toca el Mercado)
npm start

# 2. Mira qué cambiaría en el Mercado
npm run apply -- --dry-run

# 3. Cópialo al Mercado y rellena logoUrl/photoUrl
npm run apply
```

Después, en el Mercado: `npm run dev` para revisarlo y `git add -A && git commit && git push` para publicarlo.

La primera vez tarda unos 15 minutos. Las siguientes van mucho más rápidas, porque las búsquedas se guardan 7 días en `.cache/` y las imágenes que ya están en `output/` no se vuelven a descargar.

### Opciones

| Comando | Qué hace |
|---|---|
| `npm start -- --dry-run` | Busca y genera el informe sin descargar nada |
| `npm start -- --region=emea` | Solo un archivo (`emea`, `amer`, `pacf`, `cn`) |
| `npm start -- --only=logos` | Solo logos (`logos`, `players`, `staff`, separados por comas) |
| `npm start -- --force` | Vuelve a descargar las imágenes que ya están en `output/` |
| `npm start -- --refresh` | Ignora la caché y pregunta todo de nuevo a Liquipedia |
| `npm run apply -- --force` | Sustituye también las fotos y logos que ya tenía el Mercado |

Sin `--force`, `apply` solo rellena los campos que están en `null`, así que tus imágenes puestas a mano no se tocan.

## Qué genera

```
output/
├── logos/  players/  staff/   imágenes (miniaturas de 256 px)
├── image-map.json             equipo → logo, jugador → foto
├── image-credits.json         origen, autor y licencia de cada imagen
└── report.txt                 quién no se encontró y por qué
```

`apply` copia los créditos de las imágenes usadas a `public/data/image-credits.json` del Mercado.

## Corregir lo que no encuentre

Revisa `output/report.txt` y corrige a mano en `titles.json`:

```json
{
  "teams": {
    "FUT ESPORTS": "FUT Esports"
  },
  "people": {
    "Happy": "Happy (French player)",
    "zjc": null
  }
}
```

- **teams:** nombre en el Mercado → título exacto de la página en Liquipedia. El script añade aquí los equipos que encuentra solo; si alguno está mal, cámbialo.
- **people:** igual, para jugadores o staff. Sirve para los nombres que están en varias páginas o cuyo nombre en Liquipedia es distinto.
- **null** salta a esa persona o equipo.

El título es el que sale en la dirección de la página: `liquipedia.net/valorant/Happy_(French_player)` → `"Happy (French player)"`.

Los avisos de "Equipo distinto en Liquipedia" no bloquean nada: la imagen se descarga igual, pero conviene comprobar que es la persona correcta, sobre todo con rumores o fichajes recientes.

## Licencia de las imágenes

Los textos de Liquipedia son CC BY-SA 3.0, pero **cada imagen tiene su propia licencia** y muchas son de Riot o de los equipos. Por eso el Mercado cita a Liquipedia en el pie y guarda el origen de cada imagen en `image-credits.json`. Si alguien te pide quitar una foto, pon su `photoUrl` a `null` y borra el archivo.
