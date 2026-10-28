# Arquitectura de EFC

## Visión general

```
 Explorador de Windows
        │  Ctrl + Mayús + E (RegisterHotKey vía globalShortcut)
        ▼
 ┌──────────────── Proceso principal (Electron) ─────────────────┐
 │ windows/shortcut.ts      atajo global y reenvío a otras apps   │
 │ windows/explorer-helper  ⇄ efc-helper.exe (nativo, Win32+COM)  │
 │ windows/selection.ts     validación de rutas y detección       │
 │ conversion/registry.ts   destinos disponibles según motores    │
 │ main/placement.ts        posición, pantalla y escalado         │
 │ main/backdrop.ts         captura local para el desenfoque      │
 │ main/wheel-window.ts     ventana transparente de la rueda      │
 │ main/jobs.ts             cola, duplicados, cancelación         │
 │ main/toast-window.ts     ventana de avisos                     │
 └───────────┬───────────────────────────────┬────────────────────┘
             │ IPC validado (preload)         │ postMessage
             ▼                                ▼
   Interfaz React (sandbox)         Proceso de utilidad (conversión)
   rueda radial + avisos            sharp · pdf.js · pdf-lib · FFmpeg
```

## Decisiones importantes

### Detección del archivo seleccionado
- **Ayudante nativo** (`electron/windows/helper/efc-helper.cpp` → `efc-helper.exe`, 44 KB): la
  selección del Explorador solo es accesible por COM, algo que Node no ofrece. Es un ejecutable C++
  sin biblioteca de C, que solo importa DLL de Windows (kernel32, user32, ole32, oleaut32, shell32,
  gdi32). No depende de .NET ni de PowerShell, no compila nada en el equipo del usuario y no dispara
  las alertas que suelen provocar esas técnicas en equipos de empresa. Se inicia una vez y queda
  bloqueado leyendo su entrada estándar: cero CPU en reposo y respuesta en milisegundos.
- **Alternativa**: si el ejecutable nativo no puede iniciarse (falta o lo bloquea una directiva),
  EFC carga el mismo protocolo en C# con PowerShell (`EfcHelper.cs` + `efc-helper.ps1`).
- **Ventana activa real**: `GetForegroundWindow` en el momento de pulsar el atajo; se exige la clase
  `CabinetWClass` y el proceso `explorer.exe`. El escritorio (`Progman`/`WorkerW`), los cuadros de
  diálogo y cualquier otra aplicación se descartan. Nunca se consulta una ventana del Explorador en
  segundo plano.
- **Pestañas de Windows 11**: todas las pestañas comparten la ventana. Se busca la ventana en
  `ShellWindows` (`IWebBrowserApp::get_HWND`) y, si hay varias pestañas, se elige aquella cuyo
  `IShellBrowser` (obtenido con `IServiceProvider::QueryService(SID_STopLevelBrowser)`) corresponde
  a la ventana `ShellTabWindowClass` visible. Si no se puede determinar con certeza, la rueda no se
  abre y se registra el motivo (no se adivina).
- **Selección**: `IShellBrowser::QueryActiveShellView` → `IFolderView2::GetSelection` →
  `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`. Los elementos virtuales (dentro de un ZIP, la
  Papelera…) no tienen ruta de archivo y se rechazan con un aviso.
- **Posición**: el cursor si está sobre el Explorador; si no, el centro de su ventana. Las coordenadas
  físicas se convierten a DIP con `screen.screenToDipRect` (escalado y varios monitores). El ayudante
  declara en su manifiesto «PerMonitorV2» para trabajar siempre en píxeles físicos reales.

### El atajo en otras aplicaciones
`RegisterHotKey` captura la combinación en todo el sistema. Para no romper Ctrl+Mayús+E en Word,
VS Code, etc., cuando la ventana activa no es el Explorador (o no hay ningún archivo seleccionado)
EFC libera el atajo, lo inyecta en la aplicación activa con `SendInput` (respetando las teclas que el
usuario aún mantiene pulsadas, para no dejar ninguna «atascada») y lo vuelve a registrar 80 ms después.
Registrar el atajo con `RegisterHotKey` tiene otra ventaja: Windows concede a EFC el permiso de pasar
a primer plano, así que la rueda recibe el foco (Escape y el clic fuera funcionan). Si aun así no lo
obtiene, el ayudante la trae al frente.

### Menú del botón derecho («Convertir con EFC»)
Entrada clásica del Explorador registrada por usuario (HKCU\Software\Classes\SystemFileAssociations\
.<ext>\shell\EFC.Convert) solo para las extensiones convertibles, con `MultiSelectModel = Player`
(hasta 100 archivos). Se aplica importando un .reg con reg.exe cuando cambia la versión, la ruta o la
lista de extensiones (`contextMenuApplied`), y el desinstalador la retira (salvo al actualizar).

El Explorador ejecuta la orden una vez por archivo, así que la orden no es EFC.exe (Electron tardaría en
arrancar cada vez) sino el ayudante nativo en modo lanzador: `efc-helper.exe --open "%1"`. Cada lanzador
cede el permiso de primer plano (AllowSetForegroundWindow), envía su ruta en JSON por la tubería con
nombre `\\.\pipe\efc-open-<usuario>` y termina en milisegundos. EFC reúne lo que llega en 300 ms
(máximo 2,5 s) y abre una sola rueda con todos los archivos, que pasan por la misma validación que la
selección del Explorador. Si la tubería no existe, el primer lanzador (mutex `Local\EFC-menu-launch`)
abre EFC.exe y todos esperan a la tubería. En Windows 11 la entrada aparece en «Mostrar más opciones»:
el menú compacto exige una aplicación empaquetada (MSIX) y firmada.

### Desenfoque real
`backdrop-filter` no puede desenfocar otras ventanas. Justo antes de mostrar la rueda, el ayudante
captura con GDI solo la zona que quedará detrás (a media resolución, en memoria, ~10 ms) y la interfaz
la desenfoca dentro del círculo, ligeramente ampliada como una lente. La captura va en cola justo
detrás de la consulta al Explorador, por lo que no añade espera. La misma captura sirve para los
avisos que aparecen en ese lugar. Si el ayudante no puede capturar, se usa `desktopCapturer` (sin
Windows.Graphics.Capture, para evitar el marco amarillo de Windows 11) con un tiempo máximo; si
tampoco llega a tiempo, el cristal es algo más opaco. La luminosidad media de la zona decide si el
cristal es claro (texto oscuro) u oscuro (texto claro), para mantener el contraste sobre cualquier
fondo. Nada se guarda ni se envía. Se puede desactivar (`backdropBlur`).

Para que la captura nunca contenga las propias ventanas de EFC (avisos aún visibles, la rueda
anterior), en Windows 10 2004 o posterior la rueda y los avisos se excluyen de las capturas
(`setContentProtection` → `WDA_EXCLUDEFROMCAPTURE`; `excludeFromScreenCapture` en la configuración).
Sin esa función (Windows más antiguo o la opción desactivada), los avisos que siguen en pantalla
conservan su captura anterior en vez de desenfocarse a sí mismos.

### Animaciones
Los muelles se simulan una vez y se convierten en curvas CSS `linear()`; las animaciones se lanzan
con la Web Animations API sobre `transform`, `opacity`, `filter` y `clip-path`, por lo que corren en
el hilo de composición y no dependen de React ni de bibliotecas. Con «Efectos de animación»
desactivado en Windows (`prefers-reduced-motion`) todo se reduce a fundidos breves. Cada salida de la
rueda pertenece a su apertura (identificador `token`), de modo que volver a abrirla mientras termina la
animación anterior no la cierra por error.

### Conversión aislada
Las conversiones se ejecutan en un `utilityProcess` de Electron con prioridad baja: si una biblioteca
nativa fallase con un archivo malicioso o dañado, solo se cierra ese proceso. Se inicia bajo demanda y
se cierra tras 45 s sin trabajo. Concurrencia máxima configurable (2 por defecto); los trabajos
idénticos en curso no se duplican. pdf.js descarta los procesos de Electron que no son el principal
al decidir si está en Node.js; durante su carga el proceso de utilidad se presenta como tal (ver
`adapters/pdf.ts`), y su «worker» se ejecuta en el mismo proceso.

### Escritura segura
1. Se valida el origen (existe, es un archivo, no está vacío y su contenido sigue siendo el formato
   detectado al abrir la rueda).
2. Se escribe un temporal `.~efc-<trabajo>-<n>.part` en la misma carpeta.
3. Se verifica el resultado (se vuelve a leer: dimensiones, número de páginas, pistas…).
4. Se publica con un enlace duro (falla si el nombre existe: imposible sobrescribir) o, en unidades
   sin enlaces (FAT32/exFAT), comprobando y renombrando. Si falla algo, el temporal se elimina.

### Seguridad de Electron
`contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP estricta en producción, navegación y
ventanas nuevas bloqueadas, permisos denegados, IPC validado por remitente y por contenido. La
interfaz nunca recibe ni envía rutas: solo identificadores de destino que el proceso principal
comprueba contra los que él mismo ofreció. FFmpeg se ejecuta sin intérprete de comandos, con los
argumentos en lista y las rutas con prefijo `file:`. El ayudante solo acepta órdenes con argumentos
numéricos.

## Compilación y empaquetado

- Interfaz: Vite + React (`vite.config.mts`). Proceso principal, precarga y proceso de conversión:
  esbuild (`scripts/build-electron.mjs`).
- `scripts/prepare-win.mjs` deja listos los binarios de Windows de sharp y del lienzo de pdf.js (si
  se compila desde Linux o macOS los descarga del registro de npm con la misma versión) y FFmpeg
  (el ejecutable que distribuye ffmpeg-static, con su licencia).
- `electron-builder` crea el instalador NSIS de un clic, por usuario y sin permisos de administrador
  (`electron-builder.yml`, `resources/build/installer.nsh`). Desde Linux necesita Wine para generar el
  desinstalador.
- El ayudante nativo se compila con `npm run build:helper` (clang + lld con las cabeceras de mingw-w64,
  o MinGW-w64 GCC) y el ejecutable resultante forma parte del proyecto (`resources/bin`).

## Añadir un formato

1. Declararlo en `electron/conversion/formats.ts` (y su firma en `detect.ts`).
2. Añadir la regla en `registry.ts` (qué orígenes, qué destinos, qué motor y qué necesita).
3. Implementar o ampliar el adaptador en `electron/conversion/adapters/`.
4. Añadir una prueba con archivos reales en `tests/conversion/`.
