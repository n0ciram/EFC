# Componentes de terceros incluidos en EFC

EFC se distribuye junto con los siguientes componentes. Cada uno conserva su licencia original.

| Componente | Uso en EFC | Licencia |
|---|---|---|
| Electron 44 (incluye Chromium y Node.js) | Aplicación de escritorio | MIT (Chromium: BSD y otras; ver `LICENSES.chromium.html` junto a `EFC.exe`) |
| React y React DOM | Interfaz | MIT |
| sharp | Conversión de imágenes | Apache-2.0 |
| libvips y sus dependencias (paquete `@img/sharp-win32-x64`) | Motor de imágenes de sharp | LGPL-3.0-or-later y otras (ver `resources\app.asar.unpacked\node_modules\@img`) |
| pdf.js (`pdfjs-dist`, Mozilla) | Lectura y renderizado de PDF | Apache-2.0 |
| @napi-rs/canvas (basado en Skia) | Lienzo para renderizar PDF | MIT (Skia: BSD-3-Clause) |
| pdf-lib | Creación de PDF a partir de imágenes y de texto | MIT |
| @pdf-lib/fontkit | Incrustar la fuente en los PDF de texto | MIT |
| DejaVu Sans Mono 2.37 (`resources\fonts\DejaVuSansMono.ttf`) | Fuente de los PDF creados a partir de texto | Licencia de las fuentes Bitstream Vera y cambios de DejaVu en dominio público (ver `resources\fonts\DejaVu-LICENSE.txt`) |
| FFmpeg 6.1.1 «essentials», compilación de www.gyan.dev distribuida por el proyecto ffmpeg-static | Conversión de audio y vídeo (`resources\ffmpeg\ffmpeg.exe`) | GPL-3.0 (ver `resources\ffmpeg\LICENSE.txt` y `README.txt`) |
| Ayudante del Explorador (`efc-helper.exe`) | Detección del archivo seleccionado | Código propio de EFC (`electron/windows/helper/efc-helper.cpp`); usa cabeceras de mingw-w64 (licencias permisivas / dominio público) |

## Notas sobre FFmpeg

- FFmpeg se ejecuta como un programa independiente (proceso aparte); EFC no enlaza su código.
- Código fuente de la versión incluida: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 (indicado
  en `resources\ffmpeg\README.txt`). Todas las versiones: https://ffmpeg.org/download.html
- Si redistribuyes el instalador de EFC a terceros, la licencia GPL de FFmpeg exige ofrecer su código
  fuente correspondiente (basta con indicar el enlace anterior junto al instalador).
- Para compilar EFC sin FFmpeg: `EFC_NO_FFMPEG=1` al ejecutar `npm run dist`. EFC usará el FFmpeg del
  sistema si existe; si no, no ofrecerá conversiones de audio ni vídeo.
