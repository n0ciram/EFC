// EFC — Ayudante de integración con el Explorador de Windows.
//
// Se compila con el compilador de C# de .NET Framework 4.x incluido en Windows 10/11
// (C# 5: sin interpolación de cadenas, sin «?.», sin «out var»…). Si no se pudo compilar el
// ejecutable, EFC carga este mismo código con PowerShell (Add-Type).
//
// Protocolo (una línea por petición, solo ASCII):
//   query <id>                       → ventana activa, selección del Explorador y posiciones
//   passthrough <id> <vk> <mods>     → reenvía el atajo a la aplicación activa (mods: 1 Ctrl, 2 Mayús, 4 Alt, 8 Win)
//   focus <id> <hwnd>                → trae al frente la ventana indicada (respaldo si Electron no obtiene el foco)
//   ping <id>
//   exit
// Respuesta: {"id":<id>,"result":{...}} en una línea. Todo carácter no ASCII se escapa como \uXXXX.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if EFC_UIA
using System.Windows.Automation;
#endif

namespace EfcHelper
{
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint GA_ROOT = 2;

        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDPIAware();
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleServiceProvider
    {
        [PreserveSig]
        int QueryService(ref Guid guidService, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppvObject);
    }

    // Solo se declaran los dos primeros métodos (los de IOleWindow): GetWindow ocupa la posición 3 de la vtable.
    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellBrowser
    {
        [PreserveSig]
        int GetWindow(out IntPtr phwnd);
        [PreserveSig]
        int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool fEnterMode);
    }

    internal static class Json
    {
        public static string Str(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder(value.Length + 8);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7e)
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4"));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Bool(bool b) { return b ? "true" : "false"; }

        public static string Rect(Native.RECT r)
        {
            return "{\"l\":" + r.Left + ",\"t\":" + r.Top + ",\"r\":" + r.Right + ",\"b\":" + r.Bottom + "}";
        }
    }

    internal static class Com
    {
        public static object Get(object target, string name)
        {
            return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
        }

        public static object Call(object target, string name, params object[] args)
        {
            return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, args);
        }

        public static void Release(object o)
        {
            if (o != null && Marshal.IsComObject(o))
            {
                try { Marshal.FinalReleaseComObject(o); } catch { }
            }
        }
    }

    internal static class Explorer
    {
        private static readonly Guid SID_STopLevelBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
        private static readonly Guid IID_IShellBrowser = new Guid("000214E2-0000-0000-C000-000000000046");
        private const int MaxItems = 500;

        public static string ClassName(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            Native.GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static string ProcessName(uint pid)
        {
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    return p.ProcessName;
                }
            }
            catch
            {
                return "";
            }
        }

        // En Windows 11 cada pestaña tiene su propia ventana «ShellTabWindowClass»; la visible es la activa.
        private static IntPtr ActiveTab(IntPtr top)
        {
            IntPtr child = IntPtr.Zero;
            IntPtr first = IntPtr.Zero;
            while (true)
            {
                child = Native.FindWindowEx(top, child, "ShellTabWindowClass", null);
                if (child == IntPtr.Zero) break;
                if (first == IntPtr.Zero) first = child;
                if (Native.IsWindowVisible(child)) return child;
            }
            return first;
        }

        private static IntPtr TabOf(object shellWindow)
        {
            IOleServiceProvider sp = shellWindow as IOleServiceProvider;
            if (sp == null) return IntPtr.Zero;
            Guid[] services = new Guid[] { SID_STopLevelBrowser, IID_IShellBrowser };
            foreach (Guid service in services)
            {
                Guid sid = service;
                Guid iid = IID_IShellBrowser;
                object result = null;
                try
                {
                    if (sp.QueryService(ref sid, ref iid, out result) == 0 && result != null)
                    {
                        IShellBrowser browser = result as IShellBrowser;
                        if (browser != null)
                        {
                            IntPtr tab;
                            if (browser.GetWindow(out tab) == 0 && tab != IntPtr.Zero) return tab;
                        }
                    }
                }
                catch
                {
                }
                finally
                {
                    Com.Release(result);
                }
            }
            return IntPtr.Zero;
        }

        private static string Cursor()
        {
            Native.POINT pt;
            if (!Native.GetCursorPos(out pt)) return "null";
            return "{\"x\":" + pt.X + ",\"y\":" + pt.Y + "}";
        }

        public static string Query()
        {
            Stopwatch watch = Stopwatch.StartNew();
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return "{\"ok\":true,\"kind\":\"none\"}";
            IntPtr top = Native.GetAncestor(fg, Native.GA_ROOT);
            if (top == IntPtr.Zero) top = fg;
            string cls = ClassName(top);
            uint pid;
            Native.GetWindowThreadProcessId(top, out pid);
            string proc = ProcessName(pid);

            if (cls == "Progman" || cls == "WorkerW")
            {
                return "{\"ok\":true,\"kind\":\"desktop\",\"class\":" + Json.Str(cls) + "}";
            }
            bool isExplorerClass = cls == "CabinetWClass" || cls == "ExploreWClass";
            if (!isExplorerClass || !string.Equals(proc, "explorer", StringComparison.OrdinalIgnoreCase))
            {
                return "{\"ok\":true,\"kind\":\"other\",\"class\":" + Json.Str(cls) + ",\"process\":" + Json.Str(proc) + "}";
            }

            Native.RECT winRect;
            Native.GetWindowRect(top, out winRect);
            IntPtr activeTab = ActiveTab(top);

            object shell = null;
            object windows = null;
            List<object> candidates = new List<object>();
            try
            {
                Type shellType = Type.GetTypeFromProgID("Shell.Application");
                if (shellType == null) return "{\"ok\":false,\"error\":\"shell_unavailable\"}";
                shell = Activator.CreateInstance(shellType);
                windows = Com.Call(shell, "Windows");
                int count = Convert.ToInt32(Com.Get(windows, "Count"));
                for (int i = 0; i < count; i++)
                {
                    object w = null;
                    try
                    {
                        w = Com.Call(windows, "Item", i);
                        if (w == null) continue;
                        long hwnd = Convert.ToInt64(Com.Get(w, "HWND"));
                        if (hwnd == top.ToInt64())
                        {
                            candidates.Add(w);
                            w = null;
                        }
                    }
                    catch
                    {
                    }
                    finally
                    {
                        Com.Release(w);
                    }
                }

                object chosen = null;
                bool tabMatched = false;
                if (candidates.Count == 1)
                {
                    chosen = candidates[0];
                }
                else if (candidates.Count > 1 && activeTab != IntPtr.Zero)
                {
                    // Varias pestañas en la misma ventana: se elige la que corresponde a la pestaña visible.
                    foreach (object c in candidates)
                    {
                        if (TabOf(c) == activeTab)
                        {
                            if (chosen != null)
                            {
                                chosen = null;
                                break;
                            }
                            chosen = c;
                            tabMatched = true;
                        }
                    }
                }

                if (chosen == null)
                {
                    string reason = candidates.Count == 0 ? "window_not_found" : "ambiguous_tab";
                    return "{\"ok\":false,\"error\":" + Json.Str(reason) + ",\"candidates\":" + candidates.Count + "}";
                }

                StringBuilder items = new StringBuilder();
                int itemCount = 0;
                bool truncated = false;
                string folder = null;
                object doc = null;
                object selected = null;
                try
                {
                    doc = Com.Get(chosen, "Document");
                    try
                    {
                        object folderObj = Com.Get(doc, "Folder");
                        object self = Com.Get(folderObj, "Self");
                        folder = Convert.ToString(Com.Get(self, "Path"));
                        Com.Release(self);
                        Com.Release(folderObj);
                    }
                    catch
                    {
                    }
                    selected = Com.Call(doc, "SelectedItems");
                    int n = Convert.ToInt32(Com.Get(selected, "Count"));
                    for (int j = 0; j < n; j++)
                    {
                        if (itemCount >= MaxItems)
                        {
                            truncated = true;
                            break;
                        }
                        object item = null;
                        try
                        {
                            item = Com.Call(selected, "Item", j);
                            if (item == null) continue;
                            string path = Convert.ToString(Com.Get(item, "Path"));
                            string name = Convert.ToString(Com.Get(item, "Name"));
                            bool isFolder = Convert.ToBoolean(Com.Get(item, "IsFolder"));
                            bool isFs = Convert.ToBoolean(Com.Get(item, "IsFileSystem"));
                            bool isLink = Convert.ToBoolean(Com.Get(item, "IsLink"));
                            if (itemCount > 0) items.Append(',');
                            items.Append("{\"path\":").Append(Json.Str(path))
                                 .Append(",\"name\":").Append(Json.Str(name))
                                 .Append(",\"isFolder\":").Append(Json.Bool(isFolder))
                                 .Append(",\"isFileSystem\":").Append(Json.Bool(isFs))
                                 .Append(",\"isLink\":").Append(Json.Bool(isLink))
                                 .Append('}');
                            itemCount++;
                        }
                        catch
                        {
                        }
                        finally
                        {
                            Com.Release(item);
                        }
                    }
                }
                catch (Exception ex)
                {
                    return "{\"ok\":false,\"error\":\"selection_unavailable\",\"detail\":" + Json.Str(ex.GetType().Name + ": " + ex.Message) + "}";
                }
                finally
                {
                    Com.Release(selected);
                    Com.Release(doc);
                }

                string itemRect = "null";
                Native.POINT cursor;
                bool cursorInside = Native.GetCursorPos(out cursor) &&
                    cursor.X >= winRect.Left && cursor.X < winRect.Right && cursor.Y >= winRect.Top && cursor.Y < winRect.Bottom;
                if (!cursorInside && itemCount > 0)
                {
                    itemRect = Uia.FocusedItemRect(pid, winRect);
                }

                return "{\"ok\":true,\"kind\":\"explorer\"" +
                    ",\"hwnd\":" + top.ToInt64() +
                    ",\"pid\":" + pid +
                    ",\"tabs\":" + candidates.Count +
                    ",\"tabMatched\":" + Json.Bool(tabMatched) +
                    ",\"folder\":" + Json.Str(folder) +
                    ",\"items\":[" + items + "]" +
                    ",\"truncated\":" + Json.Bool(truncated) +
                    ",\"cursor\":" + Cursor() +
                    ",\"window\":" + Json.Rect(winRect) +
                    ",\"item\":" + itemRect +
                    ",\"ms\":" + watch.ElapsedMilliseconds + "}";
            }
            finally
            {
                foreach (object c in candidates) Com.Release(c);
                Com.Release(windows);
                Com.Release(shell);
            }
        }
    }

    internal static class Uia
    {
        public static bool Enabled
        {
            get
            {
#if EFC_UIA
                return true;
#else
                return false;
#endif
            }
        }

        // Rectángulo del elemento enfocado del Explorador (el archivo seleccionado), con un tiempo máximo.
        public static string FocusedItemRect(uint explorerPid, Native.RECT win)
        {
#if EFC_UIA
            string result = "null";
            Thread worker = new Thread(delegate ()
            {
                try
                {
                    AutomationElement el = AutomationElement.FocusedElement;
                    if (el == null) return;
                    if (el.Current.ProcessId != (int)explorerPid) return;
                    System.Windows.Rect r = el.Current.BoundingRectangle;
                    if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return;
                    int l = (int)r.Left, t = (int)r.Top, rr = (int)r.Right, b = (int)r.Bottom;
                    if (rr <= win.Left || l >= win.Right || b <= win.Top || t >= win.Bottom) return;
                    result = "{\"l\":" + l + ",\"t\":" + t + ",\"r\":" + rr + ",\"b\":" + b + "}";
                }
                catch
                {
                }
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            worker.Join(200);
            return result;
#else
            return "null";
#endif
        }
    }

    internal static class Keys
    {
        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;
        private const int VK_LSHIFT = 0xA0;
        private const int VK_LCONTROL = 0xA2;
        private const int VK_LMENU = 0xA4;

        private static bool IsDown(int vk)
        {
            return (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        private static Native.INPUT Key(int vk, bool up)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = Native.INPUT_KEYBOARD;
            input.U.ki.wVk = (ushort)vk;
            input.U.ki.wScan = (ushort)Native.MapVirtualKey((uint)vk, 0);
            input.U.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0;
            if (vk == VK_LWIN || vk == VK_RWIN) input.U.ki.dwFlags |= Native.KEYEVENTF_EXTENDEDKEY;
            input.U.ki.time = 0;
            input.U.ki.dwExtraInfo = IntPtr.Zero;
            return input;
        }

        // Reenvía el atajo a la aplicación activa respetando las teclas modificadoras que el usuario aún mantiene.
        public static string PassThrough(int vk, int mods)
        {
            if (vk <= 0 || vk > 0xFE) return "{\"ok\":false,\"error\":\"bad_key\"}";
            List<Native.INPUT> inputs = new List<Native.INPUT>();
            List<int> pressed = new List<int>();
            int[][] modifiers = new int[][]
            {
                new int[] { 1, VK_CONTROL, VK_LCONTROL },
                new int[] { 2, VK_SHIFT, VK_LSHIFT },
                new int[] { 4, VK_MENU, VK_LMENU },
                new int[] { 8, VK_LWIN, VK_LWIN },
            };
            foreach (int[] m in modifiers)
            {
                if ((mods & m[0]) != 0 && !IsDown(m[1]) && !(m[0] == 8 && IsDown(VK_RWIN)))
                {
                    inputs.Add(Key(m[2], false));
                    pressed.Add(m[2]);
                }
            }
            inputs.Add(Key(vk, false));
            inputs.Add(Key(vk, true));
            for (int i = pressed.Count - 1; i >= 0; i--) inputs.Add(Key(pressed[i], true));
            Native.INPUT[] array = inputs.ToArray();
            uint sent = Native.SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(Native.INPUT)));
            return "{\"ok\":" + Json.Bool(sent == array.Length) + ",\"sent\":" + sent + ",\"expected\":" + array.Length + "}";
        }
    }

    internal static class Focus
    {
        public static string Bring(long hwndValue)
        {
            IntPtr hwnd = new IntPtr(hwndValue);
            if (!Native.IsWindow(hwnd)) return "{\"ok\":false,\"error\":\"not_a_window\"}";
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == hwnd) return "{\"ok\":true,\"already\":true}";
            uint ignored;
            uint fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out ignored);
            uint me = Native.GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (fgThread != 0 && fgThread != me) attached = Native.AttachThreadInput(me, fgThread, true);
                Native.BringWindowToTop(hwnd);
                Native.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(me, fgThread, false);
            }
            return "{\"ok\":" + Json.Bool(Native.GetForegroundWindow() == hwnd) + "}";
        }
    }

    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            return Run();
        }

        private static void InitDpi()
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4: coordenadas físicas reales en todos los monitores.
            try
            {
                if (Native.SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
            }
            catch
            {
            }
            try { Native.SetProcessDPIAware(); } catch { }
        }

        private static bool IsNumber(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length > 20) return false;
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] < '0' || s[i] > '9') return false;
            }
            return true;
        }

        public static int Run()
        {
            InitDpi();
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            output.NewLine = "\n";
            output.WriteLine("{\"type\":\"ready\",\"protocol\":1,\"uia\":" + Json.Bool(Uia.Enabled) +
                ",\"pid\":" + Process.GetCurrentProcess().Id + ",\"clr\":" + Json.Str(Environment.Version.ToString()) + "}");

            string line;
            while ((line = input.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                string command = parts[0];
                if (command == "exit") return 0;
                string id = parts.Length > 1 && IsNumber(parts[1]) ? parts[1] : "0";
                string result;
                try
                {
                    switch (command)
                    {
                        case "query":
                            result = Explorer.Query();
                            break;
                        case "passthrough":
                            if (parts.Length < 4 || !IsNumber(parts[2]) || !IsNumber(parts[3]))
                            {
                                result = "{\"ok\":false,\"error\":\"bad_arguments\"}";
                            }
                            else
                            {
                                result = Keys.PassThrough(int.Parse(parts[2]), int.Parse(parts[3]));
                            }
                            break;
                        case "focus":
                            if (parts.Length < 3 || !IsNumber(parts[2]))
                            {
                                result = "{\"ok\":false,\"error\":\"bad_arguments\"}";
                            }
                            else
                            {
                                result = Focus.Bring(long.Parse(parts[2]));
                            }
                            break;
                        case "ping":
                            result = "{\"ok\":true}";
                            break;
                        default:
                            result = "{\"ok\":false,\"error\":\"unknown_command\"}";
                            break;
                    }
                }
                catch (Exception ex)
                {
                    result = "{\"ok\":false,\"error\":\"exception\",\"detail\":" + Json.Str(ex.GetType().Name + ": " + ex.Message) + "}";
                }
                output.WriteLine("{\"id\":" + id + ",\"result\":" + result + "}");
            }
            return 0;
        }
    }
}
