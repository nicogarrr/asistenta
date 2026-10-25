# Avisos de terceros — tv-home

tv-home es un fork de [zzeppieri/webos-custom-home](https://github.com/zzeppieri/webos-custom-home) (MIT, ver `LICENSE`)
con esquema UX de free-my-tv (simbasjungles, MIT).

Piezas portadas desde [rudra-avatar/Hearth](https://github.com/rudra-avatar/Hearth) (MIT,
Copyright (c) 2026 partridgeworks y rudra-avatar; a su vez fork de
[partridgeworks/webos-launcher](https://github.com/partridgeworks/webos-launcher), MIT):

- `src/service/appexec.ts` — canal root opt-in vía Homebrew Channel: lista de apps
  como root, lectura de iconos en base64 por índice (los appIds nunca llegan al
  shell), whitelist de rutas `SAFE_PATH` + `shellQuote`, y caché de iconos podada.

Texto completo de la licencia de Hearth:

```
MIT License

Copyright (c) 2026 webos-launcher contributors
Copyright (c) 2026 rudra-avatar (changes in this fork)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
