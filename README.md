# EFC — Easy File Converter

Conversor de archivos para Windows que vive en segundo plano. Seleccionas un archivo en el
Explorador, pulsas **Ctrl + Mayús + E**, aparece una rueda de cristal junto al cursor, eliges el
formato y el archivo convertido aparece en la misma carpeta. Sin ventanas ni cuadros de diálogo.

- Rueda radial transparente con el escritorio real desenfocado detrás, sin colores de acento.
- Conversiones reales y locales: nada sale del equipo.
- El original nunca se modifica y nada se sobrescribe (`foto.jpg` → `foto_converted.jpg` →
  `foto_converted_2.jpg`).
- Aviso de progreso con el progreso real, «N de M procesados», cancelación y reintento.

---

## 1. Instalar y probar (sin compilar nada)

### Requisitos

- Windows 10 (64 bits) u 11. Para el desenfoque más fiel, Windows 10 versión 2004 o posterior.
- No hace falta Node.js, permisos de administrador ni instalar FFmpeg: todo va dentro del instalador.

### Pasos

1. Descarga `EFC-Setup-1.6.0.exe` de la sección **Releases** del repositorio de GitHub, o genéralo con
   `npm run dist` (queda en `release\EFC-Setup-1.6.0.exe`).
2. Ejecuta `EFC-Setup-1.6.0.exe`. Primero eliges el idioma (**Español** o **English**): el instalador
   y EFC salen en ese idioma. Se instala solo para tu usuario y se abre al terminar.
   - El instalador **no está firmado digitalmente**, así que Windows SmartScreen puede mostrar
     «Windows protegió su PC». Pulsa **Más información → Ejecutar de todas formas**.
3. Aparece el aviso «EFC está listo» y un icono en el área de notificación (junto al reloj).
4. En el Explorador, selecciona un archivo (por ejemplo, uno de la carpeta `muestras`) y pulsa
   **Ctrl + Mayús + E**.
5. Elige el formato:
   - con el ratón: clic, o arrastrar desde el centro y soltar;
   - con el teclado: las flechas e **Intro**, o las teclas **1–8**.

   **Esc**, un clic fuera o volver a pulsar el atajo cierran la rueda.
6. El resultado se guarda junto al original. Haz clic en **Mostrar** para verlo en el Explorador.

Comportamiento del atajo:

- Fuera del Explorador (escritorio, navegador, Word…) o sin archivos seleccionados, la rueda **no**
  aparece y el atajo se reenvía a la aplicación activa.
- Con varias pestañas abiertas en el Explorador de Windows 11 se usa la pestaña visible.

**Menú del botón derecho** (además del atajo): haz clic derecho sobre uno o varios archivos y elige
**«Convertir con EFC»**. La rueda aparece junto al cursor con todos los archivos seleccionados.

- En **Windows 10** la entrada está directamente en el menú.
- En **Windows 11** está en **«Mostrar más opciones»** (o haz **Mayús + clic derecho** para abrir ese
  menú directamente). El menú corto de Windows 11 solo admite aplicaciones empaquetadas y firmadas
  digitalmente, algo que EFC todavía no es.
- Solo aparece en los tipos de archivo que EFC sabe convertir, y admite hasta 100 archivos a la vez
  (límite del Explorador para este tipo de entradas).
- Si EFC no estaba abierto, se abre solo.
- Se activa o desactiva en **Ajustes** (ver más abajo) o con `contextMenu` en la configuración. Se
  registra solo para tu usuario y el desinstalador lo retira.

**Ajustes**: clic derecho en el icono de EFC junto al reloj → **Ajustes…** (o un clic normal en el
icono). Aparece un panel de cristal junto al icono, sobre el escritorio desenfocado, como los de
Windows. Los cambios se aplican al momento, sin botón «Guardar»; se cierra con **Esc**, con su **×** o
haciendo clic fuera.

- **General**: el atajo (pulsa la tecla y después la nueva combinación; Esc cancela; debe llevar
  Ctrl, Alt o Win, salvo las teclas F1–F24), iniciar con Windows, «Convertir con EFC» en el botón
  derecho e **idioma** (Español o English; cambia al momento toda la aplicación).
- **Apariencia**: desenfocar el fondo (de la rueda, los avisos y el panel), transparencia de la rueda
  y ocultar EFC en capturas de pantalla.
- **Calidad**: calidad de imagen (Máxima, Alta o Equilibrada), resolución de PDF a imagen (150, 200 o
  300 ppp) y REDUCIR fotos (1280, 1920 o 2560 px) y vídeos (480p, 720p o 1080p).
- Abajo indica qué motores hay: FFmpeg y las aplicaciones de Office encontradas.
- Iniciar con Windows y «Convertir con EFC» solo se pueden cambiar en la versión instalada (con
  `npm run dev` aparecen desactivados y lo dicen).

El menú del icono queda con «Ajustes…», «Abrir registro de diagnóstico» y «Salir de EFC».

Desinstalar: *Configuración → Aplicaciones → EFC — Easy File Converter → Desinstalar*.

---

## 2. Formatos que funcionan

| Origen | Destinos | Motor |
|---|---|---|
| PNG, JPG/JPEG, WEBP, AVIF, BMP, TIFF, GIF | JPG, PNG, WEBP, AVIF, BMP, TIFF, GIF, ICO, PDF | sharp (libvips). BMP e ICO con códec propio; PDF con pdf-lib |
| SVG | PNG, JPG, WEBP, AVIF, BMP, TIFF, GIF, ICO | sharp (librsvg) |
| Varias imágenes y/o PDF | **UNIR**: un único PDF con todo, en orden natural de nombre | pdf-lib |
| PDF (todas las páginas) | JPG, PNG, WEBP, TIFF (páginas a imagen) y TXT (texto) | pdf.js + @napi-rs/canvas |
| PDF | Pétalo **Herramientas PDF**: REDUCIR, SEPARAR (un PDF por página), GIRAR (90° a la derecha) y UNIR | pdf-lib (+ sharp para reducir) |
| Fotos y vídeos (todos los anteriores salvo SVG) | **REDUCIR**: más ligeros para enviar por correo o mensajería (en fotos, dentro del pétalo **Herramientas**) | sharp / FFmpeg |
| Texto: TXT, LOG, MD, CSV | PDF y DOCX (Word) | pdf-lib + fontkit con la fuente DejaVu Sans Mono incluida; DOCX generado por EFC |
| Word: DOCX, DOC, RTF, ODT · Excel: XLSX, XLS, ODS · PowerPoint: PPTX, PPSX, PPT, PPS, ODP | PDF | **Microsoft Office instalado** (no se incluye): cada documento lo exporta su aplicación. Sin ella, no se ofrece |
| MP3, WAV, FLAC, OGG, OPUS, M4A, AAC, WMA, AIFF, AMR | MP3, WAV, FLAC, M4A, OGG, OPUS | FFmpeg 6.1.1 (incluido) |
| MP4, MOV, WEBM, MKV, AVI, WMV, FLV, MPEG, TS, 3GP | MP4, MOV, WEBM, MKV, GIF, y extraer el audio a MP3, M4A o WAV | FFmpeg 6.1.1 (incluido) |
| GIF | además MP4 y WEBM | FFmpeg |

Cómo se comporta cada conversión:

- **Tipo real**: el formato se detecta por el contenido, no por la extensión. Un `.png` que en
  realidad es JPEG se trata como JPEG, y la rueda lo avisa.
- **Solo se ofrece lo que funciona**: si un motor no está disponible, sus formatos no aparecen. Por
  ejemplo, sin FFmpeg no aparecen audio ni vídeo, y EFC lo explica.
- **PDF con varias páginas**:
  - una página → `informe.jpg`;
  - varias → carpeta `informe (JPG)` con `informe-01.jpg`, `informe-02.jpg`…;
  - a TIFF, las páginas del mismo tamaño forman un único TIFF multipágina.

  Resolución por defecto: 200 ppp.
- **Calidad**:
  - JPEG 90, WebP 90 (sin pérdidas si el original no las tenía), AVIF 60, TIFF LZW.
  - Se conservan el perfil de color y los datos EXIF.
- **Transparencia**: se conserva en PNG, WEBP, AVIF, GIF, TIFF, ICO y BMP. En JPG se rellena de
  blanco.
- **Audio y vídeo**: si los códecs ya valen para el contenedor de destino (por ejemplo, MOV H.264 →
  MP4), se copian sin recodificar. Si no, se usa H.264/AAC (MP4, MOV, MKV), VP9/Opus (WEBM), MP3 VBR,
  FLAC, AAC, Vorbis u Opus.
- **Verificación**: cada resultado se vuelve a abrir y se comprueba (dimensiones, páginas, pistas)
  antes de darlo por bueno. Se escribe primero en un archivo temporal oculto que se borra si algo
  falla, así que nunca queda un archivo vacío o a medias con el nombre final.
- **Herramientas de PDF** (todo en local; el texto sigue siendo seleccionable, no se rasteriza nada).
  La rueda principal de un PDF muestra solo los formatos de destino; las herramientas están dentro
  del pétalo **Herramientas PDF** («Volver» regresa a la rueda principal):
  - **UNIR**: con varios PDF (o PDF e imágenes) seleccionados, crea `primero_combinado.pdf` con todo,
    en orden natural de nombre («informe 2» antes que «informe 10»).
  - **SEPARAR**: crea la carpeta `informe (páginas)` con `informe-01.pdf`, `informe-02.pdf`…
    Si el PDF tiene una sola página, no hace nada y lo dice.
  - **GIRAR**: crea `informe_girado.pdf` con todas las páginas giradas 90° a la derecha (para 180°,
    gira el resultado otra vez).
  - **REDUCIR**: recomprime las imágenes internas (lo que hace pesar a un escaneo o a un PDF con
    fotos) a 1920 px como máximo en JPEG y crea `informe_reducido.pdf`. El texto, los vectores y las
    imágenes con transparencia no se tocan. Si el PDF solo tiene texto, no se crea copia.
  - Los PDF cifrados o con restricciones no se pueden modificar: el aviso lo explica. (Convertirlos a
    imagen o texto sí funciona.)
- **Cómo se ordena la rueda**: primero los formatos de destino (si no caben, el resto pasa a «Más»)
  y, al final de la primera vuelta, un pétalo de herramientas: **Herramientas** con imágenes (UNIR,
  REDUCIR) y **Herramientas PDF** con PDF (UNIR, REDUCIR, SEPARAR, GIRAR). En vídeo, REDUCIR sigue en la
  rueda principal.
- **Nombres en inglés**: con la interfaz en English, lo que crea EFC se llama `…_merged.pdf`,
  `…_shrunk.jpg`, `…_rotated.pdf` y `… (pages)` en lugar de `_combinado`, `_reducido`, `_girado` y
  `(páginas)`. `_converted` es igual en los dos idiomas.
- **REDUCIR (para enviar)**: crea `nombre_reducido.ext` junto al original.
  - Imágenes: el lado mayor queda en 1920 px como máximo (nunca se amplía) y se recomprimen.
    JPG, WEBP, AVIF, PNG y GIF conservan su formato (PNG prueba paleta de 256 colores y color completo
    y se queda con el más ligero; GIF y WEBP siguen animados; un TIFF de varias páginas las conserva).
    BMP y TIFF de una página, que el correo apenas muestra, se guardan como JPG (o PNG si tienen
    transparencia).
  - Vídeos: MP4 H.264/AAC con el lado mayor en 1280 px (720p), como mucho 30 fotogramas por segundo.
  - Se aplica la orientación de la cámara y se eliminan los metadatos, **incluida la ubicación GPS**.
  - El aviso muestra el ahorro («8,6 MB → 362 KB · −96 %»). Si el archivo ya es ligero y reducirlo no
    ahorraría al menos un 5 %, no se crea ninguna copia y el aviso lo dice.
  - Los límites y la calidad se cambian en la configuración (`conversion.shrink…`).
- **Texto a PDF o Word**:
  - se reconoce la codificación (UTF-8, UTF-16 o la antigua Windows-1252 del Bloc de notas);
  - el PDF es A4 con fuente monoespaciada, para que las columnas alineadas con espacios se mantengan;
    las líneas largas se parten y el salto de página del texto empieza una página nueva;
  - el DOCX tiene un párrafo por línea en Consolas y se edita normalmente en Word;
  - si el texto lleva caracteres que la fuente del PDF no tiene (emoji, chino…), se sustituyen por «?»
    y el aviso dice cuántos. En DOCX se conservan todos.
- **Word, Excel y PowerPoint a PDF** (necesita Microsoft Office; EFC no incluye ningún motor de
  documentos):
  - EFC mira al arrancar qué aplicaciones de Office hay. Cada documento solo se ofrece si está la
    suya: un DOCX necesita Word, un XLSX Excel y un PPTX PowerPoint. Si falta, la rueda no aparece y el
    aviso dice qué hace falta. «Convertir con EFC» del botón derecho tampoco aparece en esos archivos.
  - El PDF lo crea el propio Office, así que se ve igual que si lo imprimieras desde él: Word crea
    marcadores con los títulos, Excel incluye **todas las hojas visibles** (las ocultas no) con su
    área de impresión, y PowerPoint una página por diapositiva.
  - Office trabaja oculto, abre el documento **solo para lectura**, con las **macros desactivadas** y
    sin actualizar vínculos externos, y nunca lo guarda. Las conversiones con Office van de una en una
    (unos 5–10 s por documento, el aviso dice «Convirtiendo a PDF con Word»).
  - Un documento con contraseña de apertura no se puede convertir: el aviso lo dice sin mostrar ningún
    diálogo. Un libro de Excel vacío avisa de que no hay nada que pasar a PDF.
  - Si tenías Word, Excel o PowerPoint abiertos, no se tocan: EFC usa su propia copia oculta y la
    cierra al terminar (PowerPoint solo admite una copia; si ya está abierto, EFC abre la presentación
    sin ventana dentro de él y la cierra al acabar).
  - En esta versión no se pueden UNIR documentos de Office con PDF o imágenes: cada uno da su PDF.
- **No soportado**: HEIC (por patentes del códec HEVC), RAW de cámara e ICO como origen.
  `docs/ARQUITECTURA.md` explica cómo añadir formatos.

### Dependencias por formato

| Formatos | Dependencia | Licencia |
|---|---|---|
| Imágenes, ICO, imágenes a PDF | `sharp` 0.35 (libvips 8.18), `pdf-lib` 1.17 | Apache-2.0 / LGPL-3.0 (libvips) / MIT |
| Texto a PDF | `pdf-lib` 1.17, `@pdf-lib/fontkit` 1.1, fuente DejaVu Sans Mono 2.37 (`resources/fonts`) | MIT / licencia libre de Bitstream Vera y DejaVu |
| PDF a imagen y texto | `pdfjs-dist` 6.2, `@napi-rs/canvas` 1.0 | Apache-2.0 / MIT |
| Audio y vídeo | FFmpeg 6.1.1 «essentials» (gyan.dev), en `resources\ffmpeg` del programa instalado | GPL-3.0 |
| Word, Excel y PowerPoint a PDF | Microsoft Office del usuario (no se incluye ni se redistribuye), por automatización con `resources\office\efc-office.ps1` | — |

Las licencias y la procedencia exacta de FFmpeg están en `resources/licenses/THIRD-PARTY-NOTICES.md`
(y en la carpeta `licenses` y `ffmpeg` del programa instalado). También se puede usar otro FFmpeg con
`ffmpegPath` en la configuración, o compilar sin FFmpeg (`EFC_NO_FFMPEG=1`).

---

## 3. Desarrollo

Requisitos: **Node.js 22.13 o posterior** (incluye npm) y conexión a internet para `npm install`.

```powershell
npm install          # dependencias (descarga Electron y un FFmpeg para desarrollo)
npm run dev          # Vite + Electron con recarga; funciona con el Explorador real
npm test             # pruebas unitarias y de conversión con archivos reales
npm run test:e2e     # pruebas de extremo a extremo con Electron real (requiere npm run build)
npm run typecheck    # TypeScript estricto (proceso principal e interfaz)
npm run build        # compila la interfaz y el proceso principal en dist\
npm run dist         # genera release\EFC-Setup-<versión>.exe
npm run dist:dir     # versión empaquetada sin instalador (release\win-unpacked\EFC.exe)
npm run build:helper # recompila efc-helper.exe (necesita clang o mingw-w64)
npm run prepare:win  # prepara binarios de Windows y descarga FFmpeg (lo hace dist)
```

Notas:

- `resources\bin\efc-helper.exe` ya viene compilado. Si no hay compilador, `build:helper` usa ese.
- Con `npm run dev` en marcha puedes abrir `http://localhost:5174/wheel.html` en un navegador para
  trabajar la interfaz con datos simulados (`?scene=dark&scenario=pdf`, `toast.html?toast=stack`…).

### Estructura

```
electron/
  main/          proceso principal: orquestación, ventanas, colocación, desenfoque, cola, bandeja, registro
  preload/       API mínima y segura expuesta a la interfaz (window.efc)
  windows/       atajo global, comunicación con el ayudante del Explorador, validación de la selección
    helper/      efc-helper.cpp (ayudante nativo) y el respaldo en PowerShell/C#
  conversion/    motor de conversión: formatos, detección, registro modular, adaptadores, proceso aislado
src/
  components/    rueda radial, pétalos, esfera central, avisos, iconos
  animations/    muelles (curvas linear()) y coreografía de la rueda
  styles/        sistema visual (cristal neutro, temas claro y oscuro, alto contraste)
  types/         tipos compartidos (formatos, contrato IPC)
tests/           pruebas unitarias, de conversión con archivos reales y de extremo a extremo
scripts/         desarrollo, compilación, ayudante nativo, preparación de Windows
resources/       ayudante compilado, iconos, licencias y personalización del instalador
docs/            arquitectura y decisiones
```

---

## 4. Configuración

Lo habitual se cambia en **Ajustes** (sección 1). Todo lo demás está en `%APPDATA%\EFC\config.json`:
si lo editas a mano, sal de EFC y vuelve a abrirlo para que lo lea. Un valor que no sea válido se
sustituye por el predeterminado.

| Clave | Por defecto | Descripción |
|---|---|---|
| `shortcut` | `CommandOrControl+Shift+E` | Atajo global (formato de Electron) |
| `launchAtLogin` | `true` | Iniciar con Windows |
| `trayIcon` | `true` | Icono en el área de notificación |
| `backdropBlur` | `true` | Desenfocar el escritorio detrás de la rueda, los avisos y el panel de ajustes |
| `wheelTransparency` | `50` | Transparencia del cristal de la rueda (0 más opaca, 100 más transparente) |
| `language` | `"es"` | Idioma de la interfaz: `"es"` o `"en"`. En la primera ejecución, el elegido en el instalador o, sin instalador, el de Windows |
| `excludeFromScreenCapture` | `true` | Ocultar la rueda y los avisos en capturas y grabaciones de pantalla. Así el desenfoque muestra solo lo que hay detrás (ver abajo) |
| `passThroughShortcut` | `true` | Reenviar el atajo a la aplicación activa fuera del Explorador |
| `contextMenu` | `true` | Entrada «Convertir con EFC» en el menú del botón derecho del Explorador |
| `ffmpegPath` | `null` | Ruta a un `ffmpeg.exe` concreto |
| `maxConcurrentJobs` | `2` | Conversiones simultáneas (1–4) |
| `conversion.jpegQuality` / `webpQuality` / `avifQuality` | `90` / `90` / `60` | Calidad |
| `conversion.pdfDpi` | `200` | Resolución de PDF a imagen (72–600) |
| `conversion.svgMinSize` | `1024` | Lado mayor mínimo al rasterizar SVG pequeños |
| `conversion.shrinkMaxSide` | `1920` | REDUCIR: lado mayor máximo de las imágenes (px) |
| `conversion.shrinkQuality` | `80` | REDUCIR: calidad de JPG, WEBP y PNG (30–95) |
| `conversion.shrinkVideoMaxSide` | `1280` | REDUCIR: lado mayor máximo de los vídeos (1280 = 720p) |
| `conversion.shrinkVideoCrf` | `28` | REDUCIR: compresión del vídeo (23 más calidad, 32 más ligero) |
| `verboseLog` | `false` | Registro detallado |

Sobre `excludeFromScreenCapture`: el desenfoque se basa en una captura de la zona de pantalla que
queda detrás. Para que esa captura no incluya la propia rueda ni los avisos, EFC pide a Windows que
excluya sus ventanas de las capturas (Windows 10 2004 o posterior). Por eso no salen en capturas de
pantalla, grabaciones ni en programas de escritorio remoto que funcionan capturando la pantalla. Si
necesitas grabar EFC en vídeo, ponlo a `false`.

---

## 5. Privacidad y seguridad

- Todo se procesa localmente. EFC no hace peticiones de red.
- La captura para el desenfoque se hace a media resolución, solo de la zona necesaria, solo en
  memoria y solo mientras la rueda o el aviso están visibles. Nunca se guarda ni se envía.
- La interfaz está aislada:
  - `contextIsolation` activo, `nodeIntegration` desactivado, `sandbox` y CSP;
  - la API expuesta solo permite las operaciones necesarias, y el proceso principal comprueba el
    origen de cada mensaje.
- Las rutas y los nombres de archivo se validan: sin `\\?\`, `\\.\`, flujos alternativos NTFS,
  caracteres no válidos, elementos virtuales (dentro de un ZIP) ni accesos directos.
- FFmpeg se lanza con argumentos separados y sin intérprete de comandos. El contenido de los
  archivos nunca se ejecuta.
- Con Office, las macros se desactivan antes de abrir el documento (`AutomationSecurity` =
  desactivar siempre), no se actualizan vínculos externos y el documento se abre solo para lectura.
  Las rutas pasan al script por variables de entorno, nunca dentro de una orden. EFC solo cierra las
  copias de Office que ha abierto él (las que llevan `/Automation`), nunca las del usuario.
- Las conversiones se hacen en un proceso aparte (`utilityProcess`). Si falla, no se lleva consigo
  la aplicación y sus temporales se limpian.

---

## 6. Solución de problemas

El registro está en `%APPDATA%\EFC\logs\efc.log`. Con `"verboseLog": true` es más detallado.

| Síntoma | Qué hacer |
|---|---|
| Aviso «Atajo no disponible» | Otra aplicación usa la combinación. Cambia el atajo en Ajustes. |
| Aviso «Detección no disponible» | Revisa el registro. Si el antivirus bloquea `efc-helper.exe`, EFC intenta usar PowerShell; si PowerShell está restringido por la empresa, la detección no puede funcionar. |
| No aparecen audio ni vídeo en la rueda | FFmpeg no está disponible. Abajo del panel de Ajustes se indica si se encontró. |
| La rueda se ve sin desenfoque | La captura tardó demasiado o está desactivada (`backdropBlur`). En ese caso se usa un cristal más opaco. |
| La rueda no aparece en una captura de pantalla | Es intencionado (ver `excludeFromScreenCapture`). |
| Un Word, Excel o PowerPoint dice que hace falta Office | EFC no encontró esa aplicación al arrancar. Si acabas de instalar Office, sal de EFC y vuelve a abrirlo. El registro dice «Office disponible para PDF: …». |
| «No se pudo iniciar Microsoft Office» u «Office no pudo crear el PDF» | Abre ese documento con Office una vez (puede estar pendiente de activar la licencia o de aceptar un aviso) y reinténtalo. El detalle técnico está en el registro. Si la empresa bloquea los scripts de PowerShell, la conversión con Office no puede funcionar. |

---

## 7. Estado de verificación

### Probado de forma automática en Windows 10 real (1.6.0: inglés)

| Prueba | Resultado |
|---|---|
| `npm run typecheck` | Sin errores. El diccionario inglés tiene que tener exactamente la misma forma que el español: si falta un texto, no compila |
| `npm test`: 213 pruebas. Nuevas: los dos diccionarios tienen los mismos textos y ninguno vacío; en inglés no queda ningún texto en español; idioma inicial según el instalador (3082/1034 español, 1033/2057 inglés) o, si no, según Windows; tamaños y porcentajes con el formato de cada idioma («1,2 MB · 40 %» y «1.2 MB · 40%»); destinos, herramientas, explicaciones, avisos de progreso, resultado y error, teclas del atajo y mensajes de los ajustes en inglés; «Convert with EFC» en el menú contextual (y se vuelve a registrar al cambiar de idioma); archivos reales con nombres en inglés (`_rotated`, `_merged`, carpeta `(pages)`, título «page 1») y en español (`_girado`) | 212 correctas, 1 omitida (PDF cifrado: necesita `qpdf`) |
| `npm run test:e2e` (22 pasos). Nuevo: en el panel de Ajustes se elige English con un clic real; el panel pasa a «Settings» al momento, la rueda muestra «Tools» y «More», y la conversión termina con el aviso «Saved» | 22/22 |
| Instalador con el diálogo de idioma | Se genera correctamente; el diálogo y el idioma de EFC tras instalar se comprueban a mano (pasos 37 a 40) |

### Probado de forma automática en Windows 10 real (1.5.0: Ajustes)

| Prueba | Resultado |
|---|---|
| `npm run typecheck` | Sin errores |
| `npm test`: 203 pruebas. Nuevas: traducción entre config.json y el panel (niveles de calidad, valores editados a mano que se muestran como «Personalizada», rechazo de valores que no son de ninguna opción), atajos (necesitan Ctrl, Alt o Win salvo F1–F24; lo que acepta la interfaz lo acepta el proceso principal), transparencia de la rueda, config.json antiguo sin las claves nuevas, y colocación del panel con la barra de tareas abajo, arriba, a un lado y con el icono en «^» | 202 correctas, 1 omitida (PDF cifrado: necesita `qpdf`) |
| `npm run test:e2e` (21 pasos). Nuevo: el panel se abre pegado a la barra de tareas sin salirse ni necesitar desplazamiento, y con clics y teclas reales cambia el desenfoque, la calidad, el tamaño de vídeo, la transparencia y el atajo (una tecla sin Ctrl/Alt/Win se rechaza con aviso; Ctrl + Mayús + K se acepta y se ve al momento); cada cambio queda en config.json; Esc lo cierra | 21/21 (si se usa el ratón durante la prueba, el paso «pasar el cursor sobre un pétalo» puede fallar: la rueda sigue al ratón real) |

No se puede probar de forma automática: abrirlo desde el icono real de la bandeja y que se cierre al
hacer clic fuera (lista de comprobación, pasos 31 a 36).

### Probado de forma automática en Windows 10 real (1.4.0)

Windows 10 Pro 22H2 con Microsoft 365 (Office 16, 32 bits).

| Prueba | Resultado |
|---|---|
| `npm run typecheck` | Sin errores |
| `npm test`: 191 pruebas. Además de las de antes, ahora: detección por contenido de DOCX/XLSX/PPTX (ZIP), ODT/ODS/ODP (OpenDocument), DOC/XLS/PPT (CFB), RTF y documentos cifrados; registro (solo con la aplicación de Office instalada) y menú contextual por aplicación. Con el **Office real**: los 11 formatos (DOCX, DOC, RTF, ODT, XLSX, XLS, ODS, PPTX, PPSX, PPT, ODP) a PDF con su número de páginas y su texto leído de vuelta (tildes, ñ, ¿¡); Excel con todas las hojas visibles y sin la oculta; un lote mezclado de Word, Excel y PowerPoint; documentos con contraseña de Word, Excel y PowerPoint y un Excel vacío (aviso claro, sin diálogos ni archivos); cancelar a los 0,3 s, 1,5 s y 4 s sin dejar PDF, temporales ni Word abierto; rutas con espacios, ñ, `&`, `#` y paréntesis; el original no cambia | 190 correctas, 1 omitida (PDF cifrado: necesita `qpdf`, que no está en Windows) |
| `npm run test:e2e`: Electron real (20 pasos). Nuevo: un DOCX abre la rueda con un solo pétalo PDF, el aviso dice «Convirtiendo a PDF con Word» y el PDF se crea. Las peticiones del menú contextual se prueban ahora con una tubería con nombre de Windows | 20/20 |
| Office sin ventanas ni restos: con PowerShell de 64 bits y Office de 32 bits (la combinación más habitual, en la que la biblioteca de tipos de Office no carga), sin dejar procesos de Office abiertos tras un éxito, un error o una cancelación | Correcto |

Probado a mano en Windows: versiones 1.0 a 1.3.0, incluido «Convertir con EFC» del botón
derecho, y la conversión de Office a PDF de la 1.4.0.

1.4.1 corrige la rueda con un único destino (por ejemplo, un Word, que solo ofrece PDF): el anillo se
veía descuadrado, con un círculo que sobresalía por arriba. Lo comprueban una prueba de la geometría
y el paso de Word de `test:e2e`.

### Probado de forma automática (en el entorno de desarrollo anterior, Linux)

| Prueba | Resultado |
|---|---|
| `npm run typecheck` (proceso principal e interfaz) | Sin errores |
| `npm test`: 162 pruebas unitarias y de conversión que generan archivos reales y los vuelven a abrir para comprobarlos (dimensiones, páginas, pistas, transparencia, EXIF, nombres con colisión, cancelación, archivos dañados, PDF de 3 páginas, 24 MP, audio y vídeo con FFmpeg, texto en UTF-8/UTF-16/Windows-1252 a PDF y DOCX con su contenido leído de vuelta, REDUCIR fotos, PNG, GIF animados, TIFF multipágina, BMP y vídeos con eliminación de GPS y metadatos, UNIR PDF e imágenes, SEPARAR, GIRAR y REDUCIR PDF escaneados, PDF cifrados, agrupación de pétalos, registro del menú contextual y su sincronización con el desinstalador, servidor de peticiones y agrupación de archivos) | 162/162 |
| `npm run test:e2e`: Electron 44 real con ventanas transparentes, clics y teclas reales, conversión y comprobación de los archivos en disco (19 pasos: formatos ofrecidos, hover, Esc, clic fuera, «Más» y «Volver», PNG→JPG, `_converted` sin sobrescribir, nombre largo con acentos, PDF de 3 páginas → carpeta con 3 JPG, SEPARAR un PDF, UNIR dos PDF, GIRAR, UNIR imágenes en PDF, archivo dañado con «Reintentar», TXT→PDF y TXT→DOCX, REDUCIR una foto de 12 MP y un vídeo Full HD, WAV→MP3, cancelar MP4→WEBM sin dejar archivos; las herramientas de PDF se usan entrando en su pétalo; dos peticiones del menú contextual a la vez abren una sola rueda con los dos archivos) | 19/19 |
| Instalador `EFC-Setup-1.3.0.exe` ejecutado con Wine 10 (Windows 10 simulado): instala por usuario en `%LOCALAPPDATA%\Programs\efc-easy-file-converter`, crea el acceso directo del menú Inicio y el inicio con Windows; la versión instalada arranca, el ayudante nativo responde, detecta el FFmpeg 6.1.1 incluido y la autocomprobación de sharp (nativo de Windows) y pdf.js es correcta; el desinstalador borra los archivos, el acceso directo y el inicio con Windows | Correcto |
| Menú contextual con Wine: EFC registra «Convertir con EFC» por usuario (50 extensiones, orden con la ruta exacta del lanzador); dos lanzadores a la vez tardan 122 ms y EFC recibe los dos archivos juntos; si EFC no está abierto, el lanzador lo abre y le pasa el archivo; rutas con tildes, ñ y emoji intactas; al actualizar el menú se conserva y al desinstalar desaparece. (Wine no puede mostrar la ventana transparente de la rueda, ni desde el menú ni desde el atajo: eso se comprueba en Windows real) | Correcto |
| Protocolo del ayudante nativo con Wine: tiempos de 1–3 ms, captura con coordenadas negativas (monitor a la izquierda), peticiones solapadas, cierre ordenado | Correcto |

### No verificado todavía (necesita un Windows real)

No se pudo verificar porque el entorno de desarrollo no tiene un Windows real:

- leer la selección del Explorador real (pestañas de Windows 11, escritorio);
- el atajo global, el foco y el reenvío del atajo a otras aplicaciones;
- la transparencia y el desenfoque con DWM, y la exclusión de capturas;
- el escalado DPI y varios monitores;
- el instalador y SmartScreen;
- `prefers-reduced-motion` con la opción de Windows.

La lógica de cada uno de estos puntos sí está probada por separado. Cuando lo pruebes, el registro
(`efc.log`) indica qué pasó en cada pulsación del atajo.

### Lista de comprobación en Windows

Usa los archivos de la carpeta `muestras`.

| # | Prueba | Cómo | Resultado esperado |
|---|---|---|---|
| 1 | Selección en el Explorador | Selecciona `foto de prueba.png` y pulsa Ctrl+Mayús+E | La rueda aparece junto al cursor con JPG, WEBP, PDF, ICO, AVIF, TIFF, «Herramientas» y «Más» (BMP, GIF) |
| 2 | Fuera del Explorador | Pulsa el atajo en el escritorio y en el navegador | No aparece la rueda; la otra aplicación recibe el atajo |
| 3 | Sin selección | En una carpeta sin nada seleccionado, pulsa el atajo | No aparece la rueda |
| 4 | Conversión real | Elige JPG | Aparece `foto de prueba.jpg`, que se abre en el visor de fotos |
| 5 | Sin sobrescribir | Repite la conversión a JPG | Aparece `foto de prueba_converted.jpg`; el primero no cambia |
| 6 | Nombre largo y acentos | Usa `Fotografía del almacén — revisión final…ñandú.png` → WEBP | Nombre abreviado en la esfera sin deformarla; archivo creado |
| 7 | PDF multipágina | `informe trimestral.pdf` → JPG | Carpeta `informe trimestral (JPG)` con 3 imágenes |
| 8 | Varias imágenes | Selecciona dos imágenes → Herramientas → UNIR | `…_combinado.pdf` con 2 páginas |
| 9 | Archivo dañado | `dañado.png` → JPG | Aviso de error persistente con «Reintentar»; ningún archivo creado |
| 10 | Texto | `notas.txt` → PDF y → DOCX | La rueda ofrece PDF y DOCX; el PDF y el documento de Word se abren con el texto y las tildes correctas |
| 11 | Audio | `grabación.wav` → MP3 | `grabación.mp3` reproducible |
| 12 | Vídeo y progreso | `vídeo corto.mp4` → WEBM | Aviso con barra real y «0 de 1 procesados · NN %»; resultado reproducible |
| 13 | Cancelar | Durante la conversión de vídeo, pulsa × en el aviso | Se detiene y no queda ningún archivo |
| 14 | Imagen grande | `imagen grande 24 MP.jpg` → PNG | Se convierte sin bloquear la rueda ni el Explorador |
| 15 | Cerrar y colocar | Esc, clic fuera y atajo de nuevo; pruébalo cerca de un borde y en otro monitor | La rueda se cierra con animación y no deja restos; siempre se ve entera en pantalla |
| 16 | Reducir una foto | Una foto del móvil → Herramientas → REDUCIR | `…_reducido.jpg` de 1920 px; el aviso muestra el ahorro; en Propiedades → Detalles ya no hay ubicación GPS |
| 17 | Reducir un vídeo | Un vídeo del móvil → REDUCIR | `…_reducido.mp4` en 720p, con sonido y bien orientado |
| 18 | Unir PDF | Selecciona dos PDF (o PDF e imágenes) → Herramientas PDF → UNIR | `…_combinado.pdf` con todas las páginas, en orden de nombre |
| 19 | Separar y girar | Un PDF de varias páginas → Herramientas PDF → SEPARAR; luego → GIRAR | Carpeta `(páginas)` con un PDF por página; `…_girado.pdf` girado a la derecha |
| 20 | Reducir un PDF escaneado | Un PDF escaneado o con fotos → Herramientas PDF → REDUCIR | `…_reducido.pdf` mucho más ligero y legible; el texto seleccionable se conserva |
| 21 | Menú del botón derecho | Clic derecho sobre una foto → «Convertir con EFC» (en Windows 11, dentro de «Mostrar más opciones») | La rueda aparece junto al cursor |
| 22 | Menú con varios archivos | Selecciona 3 fotos → clic derecho → «Convertir con EFC» | Una sola rueda con «3 archivos» |
| 23 | Menú con EFC cerrado | Sal de EFC desde su icono y repite el paso 21 | EFC se abre solo y muestra la rueda |
| 24 | Word a PDF | Un documento de Word propio (con títulos, tablas o imágenes) → PDF | La rueda solo ofrece PDF; el aviso dice «Convirtiendo a PDF con Word»; el PDF se ve como al imprimirlo y tiene marcadores con los títulos |
| 25 | Excel a PDF | Un Excel con varias hojas → PDF | Un único PDF con todas las hojas visibles |
| 26 | PowerPoint a PDF | Una presentación → PDF, primero con PowerPoint cerrado y luego con otra presentación abierta en PowerPoint | Una página por diapositiva; tu PowerPoint abierto sigue igual y no aparece ninguna ventana nueva |
| 27 | Office abierto | Con un Word tuyo abierto y sin guardar, convierte otro documento de Word | Tu Word no se cierra ni pierde nada |
| 28 | Botón derecho en Office | Clic derecho sobre un .docx, .xlsx y .pptx | Aparece «Convertir con EFC» |
| 29 | Con contraseña | Un Word protegido con contraseña → PDF | Aviso «El documento está protegido con contraseña», sin ningún diálogo de Office |
| 30 | Varios a la vez | Selecciona un Word, un Excel y un PowerPoint → PDF | Tres PDF, uno por documento |
| 31 | Abrir Ajustes | Clic derecho en el icono de EFC junto al reloj → «Ajustes…»; luego un clic normal en el icono | El panel de cristal aparece pegado a la barra de tareas, encima del icono, con el escritorio desenfocado detrás. El menú solo tiene Ajustes, registro y Salir |
| 32 | Cerrar | Esc, la × y un clic fuera del panel | Se cierra con una animación corta en los tres casos |
| 33 | Cambiar el atajo | Pulsa el atajo en el panel y después Ctrl + Alt + C; prueba la rueda con él. Repite con una letra sola | La rueda se abre con el nuevo; la letra sola muestra «Combínala con Ctrl, Alt o Win.» y no cambia nada |
| 34 | Transparencia | Mueve la transparencia a un extremo y abre la rueda; luego al otro | La rueda se ve más transparente o más opaca; los avisos no cambian |
| 35 | Calidad y REDUCIR | Elige «Máxima» y convierte una foto a JPG; elige 480p y reduce un vídeo | JPG más pesado que con «Alta»; vídeo reducido a 480p |
| 36 | Se recuerda | Sal de EFC y vuelve a abrirlo | Los ajustes siguen como los dejaste |
| 37 | Idioma en el instalador | Ejecuta el instalador y elige **English** | El instalador sale en inglés; EFC arranca en inglés (aviso «EFC is ready», menú del icono con «Settings…», rueda con «More», «Tools»…) |
| 38 | Cambiar de idioma | Ajustes → Language → Español | El panel cambia al momento; la siguiente rueda, los avisos y el menú del icono, en español; clic derecho → «Convertir con EFC» |
| 39 | Nombres en inglés | En inglés, GIRAR (ROTATE) y SEPARAR (SPLIT) un PDF, y REDUCIR (SHRINK) una foto | `…_rotated.pdf`, carpeta `… (pages)` y `…_shrunk.jpg` |
| 40 | Actualizar | Instala de nuevo eligiendo el otro idioma | EFC arranca en el idioma elegido esta vez |

Si algo falla, el archivo `%APPDATA%\EFC\logs\efc.log` es lo más útil para corregirlo.

---

## 8. Licencia

EFC se distribuye con la licencia **GNU GPL v3.0 o posterior** (archivo `LICENSE`). Es la licencia
coherente con FFmpeg, que va incluido en el instalador con licencia GPL. Las licencias del resto de
componentes están en `resources/licenses/THIRD-PARTY-NOTICES.md`.
