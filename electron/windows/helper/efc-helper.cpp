/*
 * EFC — Ayudante nativo del Explorador de Windows (efc-helper.exe).
 *
 * Proceso pequeño y persistente que EFC inicia al arrancar. Queda bloqueado leyendo su entrada
 * estándar (cero CPU en reposo) y responde a cada petición de una línea con una línea JSON en ASCII.
 *
 * Protocolo:
 *   query <id>                            ventana activa, selección del Explorador y posiciones
 *   capture <id> <x> <y> <ancho> <alto> <pct>
 *                                         captura una zona de la pantalla (píxeles físicos) reducida al pct %
 *   passthrough <id> <vk> <mods>          reenvía el atajo a la aplicación activa (mods: 1 Ctrl, 2 Mayús, 4 Alt, 8 Win)
 *   focus <id> <hwnd>                     trae al frente la ventana indicada
 *   ping <id>
 *   exit
 * Respuesta: {"id":<id>,"result":{...}}. Los caracteres no ASCII se escapan como \uXXXX.
 *
 * Modo lanzador del menú contextual: efc-helper.exe --open "<ruta>" [más rutas]
 *   El Explorador ejecuta la orden una vez por archivo seleccionado. Cada lanzador envía su ruta a EFC
 *   por una tubería con nombre local (\\.\pipe\efc-open-<usuario>) y termina en milisegundos; EFC
 *   reúne lo que llega casi a la vez y abre una sola rueda. Si EFC no está en marcha, el primer
 *   lanzador lo inicia (los demás esperan a que la tubería exista).
 *
 * Detección (la parte crítica):
 *   1. La ventana activa (GetForegroundWindow) debe ser una ventana del Explorador (CabinetWClass del
 *      proceso explorer.exe). El escritorio (Progman/WorkerW) y cualquier otra aplicación se descartan.
 *      Nunca se consulta una ventana del Explorador que esté en segundo plano.
 *   2. Se busca esa misma ventana en ShellWindows (IWebBrowserApp::get_HWND). En Windows 11 cada pestaña
 *      aparece por separado con la misma ventana; se elige la pestaña visible comparando la ventana
 *      ShellTabWindowClass activa con la de cada IShellBrowser (IServiceProvider::QueryService).
 *      Si no se puede determinar con certeza, se informa del error en vez de adivinar.
 *   3. La selección se lee de la vista activa (IFolderView2::GetSelection) como elementos del shell
 *      (IShellItem), con su ruta real del sistema de archivos.
 *
 * Se compila sin la biblioteca de C (solo Win32 y COM): no depende de .NET, PowerShell ni de
 * bibliotecas de terceros. No lee ni ejecuta el contenido de ningún archivo.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define INITGUID
#include <windows.h>
#include <ole2.h>
#include <oleauto.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <exdisp.h>
#include <servprov.h>
#include <shlguid.h>

// ---------------------------------------------------------------------------------------------------
// Funciones que el compilador puede necesitar sin biblioteca de C. Se impide que el optimizador las
// convierta en llamadas a sí mismas.

#if defined(__clang__)
#define EFC_NO_BUILTIN __attribute__((no_builtin))
#else
#define EFC_NO_BUILTIN __attribute__((optimize("no-tree-loop-distribute-patterns")))
#endif

extern "C" {
int _fltused = 0;

EFC_NO_BUILTIN void *__cdecl memset(void *dst, int value, size_t size) {
  unsigned char *p = static_cast<unsigned char *>(dst);
  while (size--) *p++ = static_cast<unsigned char>(value);
  return dst;
}

EFC_NO_BUILTIN void *__cdecl memcpy(void *dst, const void *src, size_t size) {
  unsigned char *d = static_cast<unsigned char *>(dst);
  const unsigned char *s = static_cast<const unsigned char *>(src);
  while (size--) *d++ = *s++;
  return dst;
}

EFC_NO_BUILTIN void *__cdecl memmove(void *dst, const void *src, size_t size) {
  unsigned char *d = static_cast<unsigned char *>(dst);
  const unsigned char *s = static_cast<const unsigned char *>(src);
  if (d < s) {
    while (size--) *d++ = *s++;
  } else if (d > s) {
    d += size;
    s += size;
    while (size--) *--d = *--s;
  }
  return dst;
}

EFC_NO_BUILTIN int __cdecl memcmp(const void *a, const void *b, size_t size) {
  const unsigned char *x = static_cast<const unsigned char *>(a);
  const unsigned char *y = static_cast<const unsigned char *>(b);
  for (; size; --size, ++x, ++y) {
    if (*x != *y) return *x < *y ? -1 : 1;
  }
  return 0;
}
}

namespace {

constexpr int kProtocol = 1;
constexpr DWORD kMaxItems = 500;
constexpr int kMaxCandidates = 32;

HANDLE g_heap = nullptr;
HANDLE g_in = nullptr;
HANDLE g_out = nullptr;

void *xrealloc(void *p, size_t n) { return p ? HeapReAlloc(g_heap, 0, p, n) : HeapAlloc(g_heap, 0, n); }
void xfree(void *p) {
  if (p) HeapFree(g_heap, 0, p);
}

// ---------------------------------------------------------------------------------------------------
// Texto y JSON.

struct Buf {
  char *data;
  size_t len;
  size_t cap;

  bool reserve(size_t extra) {
    if (len + extra <= cap) return true;
    size_t next = cap ? cap : 1024;
    while (next < len + extra) next *= 2;
    void *p = xrealloc(data, next);
    if (!p) return false;
    data = static_cast<char *>(p);
    cap = next;
    return true;
  }
  void put(char c) {
    if (reserve(1)) data[len++] = c;
  }
  void putn(const char *s, size_t n) {
    if (!reserve(n)) return;
    for (size_t i = 0; i < n; ++i) data[len + i] = s[i];
    len += n;
  }
  void add(const char *s) {
    size_t n = 0;
    while (s[n]) ++n;
    putn(s, n);
  }
  void putUInt(unsigned long long v) {
    char tmp[24];
    int n = 0;
    do {
      tmp[n++] = static_cast<char>('0' + v % 10);
      v /= 10;
    } while (v);
    while (n) put(tmp[--n]);
  }
  void putInt(long long v) {
    if (v < 0) {
      put('-');
      putUInt(static_cast<unsigned long long>(-(v + 1)) + 1);
    } else {
      putUInt(static_cast<unsigned long long>(v));
    }
  }
  void putHex(unsigned long long v, int digits) {
    static const char hex[] = "0123456789abcdef";
    for (int i = digits - 1; i >= 0; --i) put(hex[(v >> (i * 4)) & 0xF]);
  }
  void putBool(bool b) { add(b ? "true" : "false"); }
  /** Cadena JSON a partir de UTF-16: solo ASCII imprimible sin escapar; el resto como \uXXXX. */
  void putJson(const wchar_t *s) {
    if (!s) {
      add("null");
      return;
    }
    put('"');
    for (; *s; ++s) {
      unsigned c = static_cast<unsigned short>(*s);
      if (c == '"') {
        add("\\\"");
      } else if (c == '\\') {
        add("\\\\");
      } else if (c >= 0x20 && c <= 0x7e) {
        put(static_cast<char>(c));
      } else {
        add("\\u");
        putHex(c, 4);
      }
    }
    put('"');
  }
  void putJsonA(const char *s) {
    put('"');
    for (; *s; ++s) {
      unsigned char c = static_cast<unsigned char>(*s);
      if (c == '"' || c == '\\') {
        put('\\');
        put(static_cast<char>(c));
      } else if (c >= 0x20 && c <= 0x7e) {
        put(static_cast<char>(c));
      } else {
        add("\\u");
        putHex(c, 4);
      }
    }
    put('"');
  }
  void putRect(const RECT &r) {
    add("{\"l\":");
    putInt(r.left);
    add(",\"t\":");
    putInt(r.top);
    add(",\"r\":");
    putInt(r.right);
    add(",\"b\":");
    putInt(r.bottom);
    put('}');
  }
  void putHr(HRESULT hr) {
    add("\"0x");
    putHex(static_cast<unsigned long>(hr), 8);
    put('"');
  }
  void append(const Buf &other) { putn(other.data, other.len); }
  void release() {
    xfree(data);
    data = nullptr;
    len = cap = 0;
  }
};

void writeAll(const char *data, size_t len) {
  while (len > 0) {
    DWORD chunk = len > 0x10000000 ? 0x10000000 : static_cast<DWORD>(len);
    DWORD written = 0;
    if (!WriteFile(g_out, data, chunk, &written, nullptr) || written == 0) ExitProcess(3);
    data += written;
    len -= written;
  }
}

bool eq(const wchar_t *a, const wchar_t *b) {
  while (*a && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

wchar_t lower(wchar_t c) { return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c + 32) : c; }

bool eqi(const wchar_t *a, const wchar_t *b) {
  while (*a && lower(*a) == lower(*b)) {
    ++a;
    ++b;
  }
  return lower(*a) == lower(*b);
}

const wchar_t *baseName(const wchar_t *p) {
  const wchar_t *b = p;
  for (; *p; ++p) {
    if (*p == L'\\' || *p == L'/') b = p + 1;
  }
  return b;
}

long long elapsedMs(const LARGE_INTEGER &start) {
  LARGE_INTEGER now, freq;
  QueryPerformanceCounter(&now);
  QueryPerformanceFrequency(&freq);
  if (freq.QuadPart <= 0) return 0;
  return (now.QuadPart - start.QuadPart) * 1000 / freq.QuadPart;
}

template <class T>
void releaseCom(T *&p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// ---------------------------------------------------------------------------------------------------
// Ventanas.

void processImageName(DWORD pid, wchar_t *out, DWORD cap) {
  out[0] = 0;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return;
  DWORD n = cap;
  if (!QueryFullProcessImageNameW(h, 0, out, &n)) out[0] = 0;
  CloseHandle(h);
}

/** Pestaña activa del Explorador de Windows 11: la ventana ShellTabWindowClass visible (o la primera). */
HWND activeTab(HWND top) {
  HWND first = nullptr;
  HWND child = nullptr;
  for (int guard = 0; guard < 256; ++guard) {
    child = FindWindowExW(top, child, L"ShellTabWindowClass", nullptr);
    if (!child) break;
    if (!first) first = child;
    if (IsWindowVisible(child)) return child;
  }
  return first;
}

struct Candidate {
  IShellBrowser *browser;
  HWND tab;
};

/** Ruta del sistema de archivos de la carpeta mostrada, si la tiene (memoria de CoTaskMemAlloc). */
LPWSTR currentFolder(IFolderView *view) {
  LPWSTR result = nullptr;
  IPersistFolder2 *persist = nullptr;
  if (SUCCEEDED(view->GetFolder(IID_IPersistFolder2, reinterpret_cast<void **>(&persist))) && persist) {
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (SUCCEEDED(persist->GetCurFolder(&pidl)) && pidl) {
      IShellItem *item = nullptr;
      if (SUCCEEDED(SHCreateItemFromIDList(pidl, IID_IShellItem, reinterpret_cast<void **>(&item))) && item) {
        if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &result))) result = nullptr;
        item->Release();
      }
      CoTaskMemFree(pidl);
    }
    persist->Release();
  }
  return result;
}

void putError(Buf &out, const char *code, HRESULT hr) {
  out.add("{\"ok\":false,\"error\":");
  out.putJsonA(code);
  out.add(",\"detail\":");
  out.putHr(hr);
  out.put('}');
}

/** Escribe los elementos seleccionados en `items`. Devuelve S_OK o el error de la vista. */
HRESULT readSelection(IShellBrowser *browser, Buf &items, DWORD &count, bool &truncated, LPWSTR &folder) {
  count = 0;
  truncated = false;
  folder = nullptr;
  IShellView *shellView = nullptr;
  HRESULT hr = browser->QueryActiveShellView(&shellView);
  if (FAILED(hr) || !shellView) return FAILED(hr) ? hr : E_FAIL;

  IFolderView *view = nullptr;
  hr = shellView->QueryInterface(IID_IFolderView, reinterpret_cast<void **>(&view));
  if (FAILED(hr) || !view) {
    shellView->Release();
    return FAILED(hr) ? hr : E_NOINTERFACE;
  }
  folder = currentFolder(view);

  int selected = 0;
  hr = view->ItemCount(SVGIO_SELECTION, &selected);
  if (SUCCEEDED(hr) && selected == 0) {
    view->Release();
    shellView->Release();
    return S_OK;
  }

  IShellItemArray *array = nullptr;
  IFolderView2 *view2 = nullptr;
  if (SUCCEEDED(shellView->QueryInterface(IID_IFolderView2, reinterpret_cast<void **>(&view2))) && view2) {
    if (FAILED(view2->GetSelection(FALSE, &array))) array = nullptr;
    view2->Release();
  }
  if (!array) {
    hr = view->Items(SVGIO_SELECTION, IID_IShellItemArray, reinterpret_cast<void **>(&array));
    if (FAILED(hr)) array = nullptr;
  }
  view->Release();
  shellView->Release();
  if (!array) return FAILED(hr) ? hr : E_FAIL;

  DWORD total = 0;
  if (FAILED(array->GetCount(&total))) total = 0;
  for (DWORD i = 0; i < total; ++i) {
    if (count >= kMaxItems) {
      truncated = true;
      break;
    }
    IShellItem *item = nullptr;
    if (FAILED(array->GetItemAt(i, &item)) || !item) continue;
    SFGAOF attrs = 0;
    if (FAILED(item->GetAttributes(SFGAO_FOLDER | SFGAO_FILESYSTEM | SFGAO_LINK | SFGAO_STREAM, &attrs))) attrs = 0;
    LPWSTR path = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) path = nullptr;
    LPWSTR display = nullptr;
    if (!path || !*path) {
      if (FAILED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &display))) display = nullptr;
    }
    // Un .zip es carpeta y flujo a la vez: para EFC cuenta como archivo (y se rechazará por formato).
    bool isFolder = (attrs & SFGAO_FOLDER) && !(attrs & SFGAO_STREAM);
    bool isFileSystem = (attrs & SFGAO_FILESYSTEM) && path && *path;
    if (count > 0) items.put(',');
    items.add("{\"path\":");
    items.putJson(path ? path : L"");
    items.add(",\"name\":");
    items.putJson(path && *path ? baseName(path) : (display ? display : L""));
    items.add(",\"isFolder\":");
    items.putBool(isFolder);
    items.add(",\"isFileSystem\":");
    items.putBool(isFileSystem);
    items.add(",\"isLink\":");
    items.putBool((attrs & SFGAO_LINK) != 0);
    items.put('}');
    ++count;
    if (path) CoTaskMemFree(path);
    if (display) CoTaskMemFree(display);
    item->Release();
  }
  array->Release();
  return S_OK;
}

void doQuery(Buf &out) {
  LARGE_INTEGER start;
  QueryPerformanceCounter(&start);

  HWND fg = GetForegroundWindow();
  if (!fg) {
    out.add("{\"ok\":true,\"kind\":\"none\"}");
    return;
  }
  HWND top = GetAncestor(fg, GA_ROOT);
  if (!top) top = fg;

  wchar_t cls[256];
  if (GetClassNameW(top, cls, 256) <= 0) cls[0] = 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(top, &pid);
  wchar_t image[300];
  processImageName(pid, image, 300);

  if (eq(cls, L"Progman") || eq(cls, L"WorkerW")) {
    out.add("{\"ok\":true,\"kind\":\"desktop\",\"class\":");
    out.putJson(cls);
    out.put('}');
    return;
  }
  bool explorerClass = eq(cls, L"CabinetWClass") || eq(cls, L"ExploreWClass");
  if (!explorerClass || !eqi(baseName(image), L"explorer.exe")) {
    out.add("{\"ok\":true,\"kind\":\"other\",\"class\":");
    out.putJson(cls);
    out.add(",\"process\":");
    out.putJson(baseName(image));
    out.put('}');
    return;
  }

  RECT windowRect = {0, 0, 0, 0};
  GetWindowRect(top, &windowRect);

  IShellWindows *windows = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_ALL, IID_IShellWindows, reinterpret_cast<void **>(&windows));
  if (FAILED(hr) || !windows) {
    putError(out, "shell_unavailable", FAILED(hr) ? hr : E_FAIL);
    return;
  }

  Candidate candidates[kMaxCandidates];
  int found = 0;
  long count = 0;
  if (FAILED(windows->get_Count(&count))) count = 0;
  for (long i = 0; i < count && i < 1024; ++i) {
    VARIANT index;
    VariantInit(&index);
    index.vt = VT_I4;
    index.lVal = i;
    IDispatch *dispatch = nullptr;
    if (windows->Item(index, &dispatch) != S_OK || !dispatch) continue;

    HWND appHwnd = nullptr;
    IWebBrowserApp *app = nullptr;
    if (SUCCEEDED(dispatch->QueryInterface(IID_IWebBrowserApp, reinterpret_cast<void **>(&app))) && app) {
      SHANDLE_PTR h = 0;
      if (SUCCEEDED(app->get_HWND(&h))) appHwnd = reinterpret_cast<HWND>(h);
      app->Release();
    }
    IShellBrowser *browser = nullptr;
    IServiceProvider *provider = nullptr;
    if (SUCCEEDED(dispatch->QueryInterface(__uuidof(IServiceProvider), reinterpret_cast<void **>(&provider))) && provider) {
      if (FAILED(provider->QueryService(SID_STopLevelBrowser, IID_IShellBrowser, reinterpret_cast<void **>(&browser)))) browser = nullptr;
      provider->Release();
    }
    dispatch->Release();
    if (!browser) continue;

    HWND tab = nullptr;
    if (FAILED(browser->GetWindow(&tab))) tab = nullptr;
    HWND root = appHwnd ? appHwnd : (tab ? GetAncestor(tab, GA_ROOT) : nullptr);
    if (root == top && found < kMaxCandidates) {
      candidates[found].browser = browser;
      candidates[found].tab = tab;
      ++found;
    } else {
      browser->Release();
    }
  }
  windows->Release();

  int chosen = -1;
  bool tabMatched = false;
  if (found == 1) {
    chosen = 0;
  } else if (found > 1) {
    // Varias pestañas en la misma ventana: la activa es la ShellTabWindowClass visible.
    HWND active = activeTab(top);
    int matches = 0;
    for (int k = 0; k < found; ++k) {
      if (active && candidates[k].tab == active) {
        chosen = k;
        ++matches;
      }
    }
    if (matches != 1) {
      chosen = -1;
      int visible = 0;
      for (int k = 0; k < found; ++k) {
        if (candidates[k].tab && IsWindowVisible(candidates[k].tab)) {
          chosen = k;
          ++visible;
        }
      }
      if (visible != 1) chosen = -1;
    }
    tabMatched = chosen >= 0;
  }

  if (chosen < 0) {
    for (int k = 0; k < found; ++k) releaseCom(candidates[k].browser);
    out.add("{\"ok\":false,\"error\":");
    out.putJsonA(found == 0 ? "window_not_found" : "ambiguous_tab");
    out.add(",\"candidates\":");
    out.putInt(found);
    out.put('}');
    return;
  }

  Buf items = {nullptr, 0, 0};
  DWORD itemCount = 0;
  bool truncated = false;
  LPWSTR folder = nullptr;
  hr = readSelection(candidates[chosen].browser, items, itemCount, truncated, folder);
  for (int k = 0; k < found; ++k) releaseCom(candidates[k].browser);
  if (FAILED(hr)) {
    items.release();
    if (folder) CoTaskMemFree(folder);
    putError(out, "selection_unavailable", hr);
    return;
  }

  POINT cursor = {0, 0};
  bool haveCursor = GetCursorPos(&cursor) != FALSE;

  out.add("{\"ok\":true,\"kind\":\"explorer\",\"hwnd\":");
  out.putUInt(static_cast<unsigned long long>(reinterpret_cast<ULONG_PTR>(top)));
  out.add(",\"pid\":");
  out.putUInt(pid);
  out.add(",\"tabs\":");
  out.putInt(found);
  out.add(",\"tabMatched\":");
  out.putBool(tabMatched);
  out.add(",\"folder\":");
  out.putJson(folder);
  out.add(",\"items\":[");
  out.append(items);
  out.add("],\"truncated\":");
  out.putBool(truncated);
  out.add(",\"cursor\":");
  if (haveCursor) {
    out.add("{\"x\":");
    out.putInt(cursor.x);
    out.add(",\"y\":");
    out.putInt(cursor.y);
    out.put('}');
  } else {
    out.add("null");
  }
  out.add(",\"window\":");
  out.putRect(windowRect);
  out.add(",\"item\":null,\"ms\":");
  out.putInt(elapsedMs(start));
  out.put('}');

  items.release();
  if (folder) CoTaskMemFree(folder);
}

// ---------------------------------------------------------------------------------------------------
// Captura de una zona de la pantalla para el cristal desenfocado (solo en memoria).

void putBase64(Buf &out, const unsigned char *data, size_t len) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (!out.reserve((len + 2) / 3 * 4 + 2)) return;
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    unsigned v = (static_cast<unsigned>(data[i]) << 16) | (static_cast<unsigned>(data[i + 1]) << 8) | data[i + 2];
    out.data[out.len++] = table[(v >> 18) & 63];
    out.data[out.len++] = table[(v >> 12) & 63];
    out.data[out.len++] = table[(v >> 6) & 63];
    out.data[out.len++] = table[v & 63];
  }
  if (i < len) {
    unsigned v = static_cast<unsigned>(data[i]) << 16;
    if (i + 1 < len) v |= static_cast<unsigned>(data[i + 1]) << 8;
    out.data[out.len++] = table[(v >> 18) & 63];
    out.data[out.len++] = table[(v >> 12) & 63];
    out.data[out.len++] = i + 1 < len ? table[(v >> 6) & 63] : '=';
    out.data[out.len++] = '=';
  }
}

void doCapture(Buf &out, long long x, long long y, long long w, long long h, long long pct) {
  if (w < 1 || h < 1 || w > 16384 || h > 16384 || pct < 5 || pct > 100) {
    out.add("{\"ok\":false,\"error\":\"bad_arguments\"}");
    return;
  }
  int dw = static_cast<int>(w * pct / 100);
  int dh = static_cast<int>(h * pct / 100);
  if (dw < 1) dw = 1;
  if (dh < 1) dh = 1;

  HDC screen = GetDC(nullptr);
  if (!screen) {
    out.add("{\"ok\":false,\"error\":\"no_screen\"}");
    return;
  }
  HDC memory = CreateCompatibleDC(screen);
  BITMAPINFO info;
  memset(&info, 0, sizeof(info));
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = dw;
  info.bmiHeader.biHeight = -dh;  // de arriba abajo
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void *bits = nullptr;
  HBITMAP bitmap = memory ? CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
  bool ok = false;
  if (bitmap && bits) {
    HGDIOBJ previous = SelectObject(memory, bitmap);
    SetStretchBltMode(memory, HALFTONE);
    SetBrushOrgEx(memory, 0, 0, nullptr);
    // Sin CAPTUREBLT: evita el parpadeo del cursor que provoca en algunos equipos.
    ok = StretchBlt(memory, 0, 0, dw, dh, screen, static_cast<int>(x), static_cast<int>(y), static_cast<int>(w), static_cast<int>(h), SRCCOPY) != FALSE;
    GdiFlush();
    SelectObject(memory, previous);
  }
  if (ok) {
    unsigned char *pixels = static_cast<unsigned char *>(bits);
    size_t size = static_cast<size_t>(dw) * static_cast<size_t>(dh) * 4;
    for (size_t i = 3; i < size; i += 4) pixels[i] = 255;
    out.add("{\"ok\":true,\"width\":");
    out.putInt(dw);
    out.add(",\"height\":");
    out.putInt(dh);
    out.add(",\"format\":\"bgra\",\"data\":\"");
    putBase64(out, pixels, size);
    out.add("\"}");
  } else {
    out.add("{\"ok\":false,\"error\":\"capture_failed\"}");
  }
  if (bitmap) DeleteObject(bitmap);
  if (memory) DeleteDC(memory);
  ReleaseDC(nullptr, screen);
}

// ---------------------------------------------------------------------------------------------------
// Reenvío del atajo a la aplicación activa.

bool keyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

void keyInput(INPUT &input, WORD vk, bool up) {
  memset(&input, 0, sizeof(input));
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = vk;
  input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
  input.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  if (vk == VK_LWIN || vk == VK_RWIN) input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
}

void doPassThrough(Buf &out, long long vk, long long mods) {
  if (vk <= 0 || vk > 0xFE || mods < 0 || mods > 15) {
    out.add("{\"ok\":false,\"error\":\"bad_key\"}");
    return;
  }
  struct Modifier {
    int flag;
    int check;
    WORD inject;
  };
  static const Modifier modifiers[] = {
      {1, VK_CONTROL, VK_LCONTROL},
      {2, VK_SHIFT, VK_LSHIFT},
      {4, VK_MENU, VK_LMENU},
      {8, VK_LWIN, VK_LWIN},
  };
  INPUT inputs[10];
  WORD pressed[4];
  int n = 0;
  int p = 0;
  for (const Modifier &m : modifiers) {
    if (!(mods & m.flag)) continue;
    bool held = keyDown(m.check) || (m.flag == 8 && keyDown(VK_RWIN));
    // Solo se pulsan las teclas que el usuario ya no mantiene: así no quedan teclas «atascadas».
    if (!held) {
      keyInput(inputs[n++], m.inject, false);
      pressed[p++] = m.inject;
    }
  }
  keyInput(inputs[n++], static_cast<WORD>(vk), false);
  keyInput(inputs[n++], static_cast<WORD>(vk), true);
  while (p > 0) keyInput(inputs[n++], pressed[--p], true);
  UINT sent = SendInput(static_cast<UINT>(n), inputs, sizeof(INPUT));
  out.add("{\"ok\":");
  out.putBool(sent == static_cast<UINT>(n));
  out.add(",\"sent\":");
  out.putUInt(sent);
  out.add(",\"expected\":");
  out.putInt(n);
  out.put('}');
}

// ---------------------------------------------------------------------------------------------------
// Foco (respaldo si Windows no concede el primer plano a la rueda).

void doFocus(Buf &out, unsigned long long value) {
  HWND hwnd = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(value));
  if (!IsWindow(hwnd)) {
    out.add("{\"ok\":false,\"error\":\"not_a_window\"}");
    return;
  }
  HWND fg = GetForegroundWindow();
  if (fg == hwnd) {
    out.add("{\"ok\":true,\"already\":true}");
    return;
  }
  DWORD ignored = 0;
  DWORD fgThread = fg ? GetWindowThreadProcessId(fg, &ignored) : 0;
  DWORD me = GetCurrentThreadId();
  bool attached = false;
  if (fgThread && fgThread != me) attached = AttachThreadInput(me, fgThread, TRUE) != FALSE;
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  if (attached) AttachThreadInput(me, fgThread, FALSE);
  out.add("{\"ok\":");
  out.putBool(GetForegroundWindow() == hwnd);
  out.put('}');
}

// ---------------------------------------------------------------------------------------------------
// Bucle de peticiones.

char g_pending[16384];
size_t g_pendingLen = 0;
char g_line[4096];

/** Lee una línea de la entrada estándar (sin el salto). Devuelve false al cerrarse la entrada. */
bool readLine() {
  for (;;) {
    for (size_t i = 0; i < g_pendingLen; ++i) {
      if (g_pending[i] != '\n') continue;
      size_t n = i < sizeof(g_line) - 1 ? i : sizeof(g_line) - 1;
      for (size_t k = 0; k < n; ++k) g_line[k] = g_pending[k];
      g_line[n] = 0;
      size_t rest = g_pendingLen - (i + 1);
      memmove(g_pending, g_pending + i + 1, rest);
      g_pendingLen = rest;
      return true;
    }
    if (g_pendingLen == sizeof(g_pending)) g_pendingLen = 0;  // línea absurdamente larga: se descarta
    DWORD got = 0;
    if (!ReadFile(g_in, g_pending + g_pendingLen, static_cast<DWORD>(sizeof(g_pending) - g_pendingLen), &got, nullptr) || got == 0) {
      return false;
    }
    g_pendingLen += got;
  }
}

struct Tokens {
  const char *items[10];
  int count;
};

void tokenize(char *line, Tokens &t) {
  t.count = 0;
  char *p = line;
  while (*p && t.count < 10) {
    while (*p == ' ' || *p == '\t' || *p == '\r') *p++ = 0;
    if (!*p) break;
    t.items[t.count++] = p;
    while (*p && *p != ' ' && *p != '\t' && *p != '\r') ++p;
  }
  while (*p) {
    if (*p == '\r') *p = 0;
    ++p;
  }
}

bool parseInt(const char *s, long long &value) {
  bool negative = false;
  if (*s == '-') {
    negative = true;
    ++s;
  }
  if (!*s) return false;
  unsigned long long v = 0;
  int digits = 0;
  for (; *s; ++s) {
    if (*s < '0' || *s > '9' || ++digits > 18) return false;
    v = v * 10 + static_cast<unsigned>(*s - '0');
  }
  value = negative ? -static_cast<long long>(v) : static_cast<long long>(v);
  return true;
}

bool same(const char *a, const char *b) {
  while (*a && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

void handle(Buf &out, Tokens &t) {
  const char *command = t.items[0];
  long long id = 0;
  if (t.count > 1 && !parseInt(t.items[1], id)) id = 0;
  if (id < 0) id = 0;

  Buf result = {nullptr, 0, 0};
  long long a[5] = {0, 0, 0, 0, 0};
  bool argsOk = true;
  for (int i = 2; i < t.count && i < 7; ++i) {
    if (!parseInt(t.items[i], a[i - 2])) argsOk = false;
  }

  if (same(command, "query")) {
    doQuery(result);
  } else if (same(command, "capture")) {
    if (!argsOk || t.count < 7) result.add("{\"ok\":false,\"error\":\"bad_arguments\"}");
    else doCapture(result, a[0], a[1], a[2], a[3], a[4]);
  } else if (same(command, "passthrough")) {
    if (!argsOk || t.count < 4) result.add("{\"ok\":false,\"error\":\"bad_arguments\"}");
    else doPassThrough(result, a[0], a[1]);
  } else if (same(command, "focus")) {
    if (!argsOk || t.count < 3 || a[0] < 0) result.add("{\"ok\":false,\"error\":\"bad_arguments\"}");
    else doFocus(result, static_cast<unsigned long long>(a[0]));
  } else if (same(command, "ping")) {
    result.add("{\"ok\":true}");
  } else {
    result.add("{\"ok\":false,\"error\":\"unknown_command\"}");
  }

  out.add("{\"id\":");
  out.putInt(id);
  out.add(",\"result\":");
  out.append(result);
  out.add("}\n");
  result.release();
}

// ---------------------------------------------------------------------------------------------------
// Hilo lector y cola de líneas.
//
// El hilo principal es un apartamento COM monohilo (STA) y debe procesar mensajes de Windows mientras
// espera: si se quedase bloqueado leyendo la entrada estándar, podría retrasar a otras aplicaciones
// que envían mensajes a todas las ventanas. Por eso la lectura se hace en un hilo aparte, que deja
// cada línea en una cola y avisa con un evento; el hilo principal espera con
// MsgWaitForMultipleObjectsEx atendiendo a la vez la cola y sus mensajes.

struct LineNode {
  LineNode *next;
  char text[1];
};

CRITICAL_SECTION g_lock;
LineNode *g_head = nullptr;
LineNode *g_tail = nullptr;
HANDLE g_lineEvent = nullptr;
volatile LONG g_eof = 0;

DWORD WINAPI readerThread(LPVOID) {
  while (readLine()) {
    size_t n = 0;
    while (g_line[n]) ++n;
    LineNode *node = static_cast<LineNode *>(HeapAlloc(g_heap, 0, sizeof(LineNode) + n));
    if (!node) continue;
    node->next = nullptr;
    memcpy(node->text, g_line, n + 1);
    EnterCriticalSection(&g_lock);
    if (g_tail) g_tail->next = node;
    else g_head = node;
    g_tail = node;
    LeaveCriticalSection(&g_lock);
    SetEvent(g_lineEvent);
  }
  InterlockedExchange(&g_eof, 1);
  SetEvent(g_lineEvent);
  return 0;
}

LineNode *popLine() {
  EnterCriticalSection(&g_lock);
  LineNode *node = g_head;
  if (node) {
    g_head = node->next;
    if (!g_head) g_tail = nullptr;
  }
  LeaveCriticalSection(&g_lock);
  return node;
}

/** Procesa las líneas pendientes. Devuelve false si se pidió salir. */
bool drainLines(Buf &out) {
  for (LineNode *node = popLine(); node; node = popLine()) {
    Tokens tokens;
    tokenize(node->text, tokens);
    bool exit = tokens.count > 0 && same(tokens.items[0], "exit");
    if (tokens.count > 0 && !exit) {
      handle(out, tokens);
      writeAll(out.data, out.len);
      out.len = 0;
      if (out.cap > (1u << 20)) out.release();  // no se retiene memoria tras una captura grande
    }
    HeapFree(g_heap, 0, node);
    if (exit) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Modo lanzador del menú contextual.

bool pipeName(wchar_t *name, DWORD cap) {
  static const wchar_t prefix[] = L"\\\\.\\pipe\\efc-open-";
  DWORD n = 0;
  for (; prefix[n]; ++n) name[n] = prefix[n];
  DWORD got = GetEnvironmentVariableW(L"USERNAME", name + n, cap - n);
  return got > 0 && got < cap - n;
}

/**
 * Envía el mensaje a EFC. Si la tubería todavía no existe, la espera hasta `waitServerMs`; si está
 * ocupada (muchos lanzadores a la vez), reintenta durante unos segundos.
 */
bool sendToPipe(const wchar_t *name, const char *data, DWORD len, DWORD waitServerMs) {
  ULONGLONG start = GetTickCount64();
  for (;;) {
    HANDLE h = CreateFileW(name, GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      DWORD written = 0;
      BOOL ok = WriteFile(h, data, len, &written, nullptr) && written == len;
      CloseHandle(h);
      return ok != FALSE;
    }
    DWORD err = GetLastError();
    ULONGLONG elapsed = GetTickCount64() - start;
    if (err == ERROR_PIPE_BUSY) {
      if (elapsed > 10000) return false;
      WaitNamedPipeW(name, 500);
      continue;
    }
    if (elapsed >= waitServerMs) return false;
    Sleep(150);
  }
}

/** Inicia EFC.exe, que está dos carpetas por encima del ayudante (EFC\resources\helper). */
bool launchEfc() {
  // Estáticos: sin biblioteca de C no hay sondeo de pila (__chkstk) para marcos de más de 4 KB.
  static wchar_t path[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH * 4);
  if (n == 0 || n >= MAX_PATH * 4 - 32) return false;
  for (int level = 0; level < 3; ++level) {
    while (n > 0 && path[n - 1] != L'\\') --n;
    if (n == 0) return false;
    --n;  // quita la barra
  }
  static const wchar_t exe[] = L"\\EFC.exe";
  for (DWORD i = 0; exe[i]; ++i) path[n++] = exe[i];
  path[n] = 0;
  static wchar_t cmd[MAX_PATH * 4 + 32];
  DWORD c = 0;
  cmd[c++] = L'"';
  for (DWORD i = 0; path[i]; ++i) cmd[c++] = path[i];
  static const wchar_t args[] = L"\" --from-menu";
  for (DWORD i = 0; args[i]; ++i) cmd[c++] = args[i];
  cmd[c] = 0;
  STARTUPINFOW si;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(path, cmd, nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) return false;
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

UINT openMode(int argc, wchar_t **argv) {
  // El Explorador concede a este proceso permiso para traer ventanas al frente: se cede a EFC.
  AllowSetForegroundWindow(ASFW_ANY);
  POINT cursor = {0, 0};
  GetCursorPos(&cursor);

  Buf msg = {nullptr, 0, 0};
  msg.add("{\"v\":1,\"paths\":[");
  int count = 0;
  for (int i = 2; i < argc && count < static_cast<int>(kMaxItems); ++i) {
    if (!argv[i] || !argv[i][0]) continue;
    if (count++) msg.put(',');
    msg.putJson(argv[i]);
  }
  msg.add("],\"x\":");
  msg.putInt(cursor.x);
  msg.add(",\"y\":");
  msg.putInt(cursor.y);
  msg.add("}\n");
  if (count == 0) return 3;

  wchar_t name[256];
  if (!pipeName(name, 256)) return 4;
  if (sendToPipe(name, msg.data, static_cast<DWORD>(msg.len), 0)) return 0;

  // EFC no está en marcha: lo inicia solo el primer lanzador; el resto espera a la tubería.
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\EFC-menu-launch");
  bool first = mutex && GetLastError() != ERROR_ALREADY_EXISTS;
  if (first && !launchEfc()) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return 5;
  }
  bool ok = sendToPipe(name, msg.data, static_cast<DWORD>(msg.len), 45000);
  if (mutex) {
    if (first) ReleaseMutex(mutex);
    CloseHandle(mutex);
  }
  return ok ? 0 : 6;
}

}  // namespace

extern "C" void __stdcall EfcEntry() {
  g_heap = GetProcessHeap();

  // Lanzador del menú contextual (sin entrada ni salida estándar).
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv && argc >= 2) {
    const wchar_t *flag = argv[1];
    const wchar_t open[] = L"--open";
    bool isOpen = true;
    for (int i = 0; open[i] || flag[i]; ++i) {
      if (open[i] != flag[i]) {
        isOpen = false;
        break;
      }
    }
    if (isOpen) ExitProcess(openMode(argc, argv));
  }
  if (argv) LocalFree(argv);

  g_in = GetStdHandle(STD_INPUT_HANDLE);
  g_out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!g_in || g_in == INVALID_HANDLE_VALUE || !g_out || g_out == INVALID_HANDLE_VALUE) ExitProcess(2);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

  InitializeCriticalSection(&g_lock);
  g_lineEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE reader = g_lineEvent ? CreateThread(nullptr, 64 * 1024, readerThread, nullptr, 0, nullptr) : nullptr;
  if (!reader) ExitProcess(4);

  Buf out = {nullptr, 0, 0};
  out.add("{\"type\":\"ready\",\"protocol\":");
  out.putInt(kProtocol);
  out.add(",\"impl\":\"native\",\"uia\":false,\"capture\":true,\"pid\":");
  out.putUInt(GetCurrentProcessId());
  out.add(",\"com\":");
  out.putHr(hr);
  out.add("}\n");
  writeAll(out.data, out.len);
  out.len = 0;

  bool running = true;
  while (running) {
    DWORD wait = MsgWaitForMultipleObjectsEx(1, &g_lineEvent, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (wait == WAIT_OBJECT_0) {
      running = drainLines(out);
      if (running && g_eof) {
        // Se cerró la entrada estándar (EFC terminó): se atiende lo pendiente y se sale.
        drainLines(out);
        running = false;
      }
    } else if (wait == WAIT_OBJECT_0 + 1) {
      MSG msg;
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (msg.message == WM_QUIT) {
          running = false;
          break;
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
    } else {
      running = false;
    }
  }

  out.release();
  if (SUCCEEDED(hr)) CoUninitialize();
  // El hilo lector puede seguir bloqueado en ReadFile: ExitProcess lo termina.
  ExitProcess(0);
}
