# Site fonts

The site ships three subset WOFF2 files in `web/assets/fonts/`. Every release stores them on chain, so they hold only the characters the pages use.

| File | Source | Instance |
| --- | --- | --- |
| `text.woff2` | Archivo (Omnibus-Type, OFL 1.1) | width 100, weight 400–600 |
| `display.woff2` | Archivo | width 112.5, weight 620 (headings) |
| `mono.woff2` | IBM Plex Mono Regular (IBM, OFL 1.1) | weight 400, renamed Quay Mono. "Plex" is a Reserved Font Name, and a subset counts as a modified version, so the subset cannot carry it. |

Rebuild from the upstream files in `google/fonts` (`ofl/archivo/Archivo[wdth,wght].ttf`, `ofl/ibmplexmono/IBMPlexMono-Regular.ttf`) with fontTools:

```sh
python3 -I web/fonts/subset.py "Archivo[wdth,wght].ttf" web/assets/fonts/text.woff2 '{"wght":[400,600],"wdth":100}'
python3 -I web/fonts/subset.py "Archivo[wdth,wght].ttf" web/assets/fonts/display.woff2 '{"wght":620,"wdth":112.5}'
python3 -I web/fonts/subset.py IBMPlexMono-Regular.ttf web/assets/fonts/mono.woff2 '' 'Quay Mono'
```

The character list is in `subset.py`; add to it if a page starts using a new character. Licences: `Archivo-OFL.txt`, `IBMPlexMono-OFL.txt`.
