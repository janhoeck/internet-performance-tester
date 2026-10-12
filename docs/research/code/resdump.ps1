# Read-only: dump RT_MESSAGETABLE + RT_STRING resources of PE/MUI files (to get exact localized message texts).
if (-not ('ResDump' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ResDump {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr FindResource(IntPtr m, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr m, IntPtr ri);
  [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr rd);
  public delegate bool EnumResNameProc(IntPtr m, IntPtr t, IntPtr n, IntPtr l);
  [DllImport("kernel32.dll")] static extern bool EnumResourceNames(IntPtr m, IntPtr t, EnumResNameProc cb, IntPtr l);
  public static List<string[]> Dump(string path) {
    var res = new List<string[]>();
    IntPtr h = LoadLibraryEx(path, IntPtr.Zero, 0x2 | 0x20);
    if (h == IntPtr.Zero) throw new Exception("LoadLibraryEx failed: " + Marshal.GetLastWin32Error());
    try {
      var names = new List<IntPtr>();
      EnumResNameProc cb = (m, t, n, l) => { names.Add(n); return true; };
      EnumResourceNames(h, (IntPtr)11, cb, IntPtr.Zero);
      foreach (var n in names) {
        IntPtr p = LockResource(LoadResource(h, FindResource(h, n, (IntPtr)11)));
        int blocks = Marshal.ReadInt32(p);
        for (int b = 0; b < blocks; b++) {
          int low = Marshal.ReadInt32(p, 4 + b * 12), high = Marshal.ReadInt32(p, 8 + b * 12), cur = Marshal.ReadInt32(p, 12 + b * 12);
          for (long id = (uint)low; id <= (uint)high; id++) {
            int len = (ushort)Marshal.ReadInt16(p, cur); int flags = (ushort)Marshal.ReadInt16(p, cur + 2);
            string text = (flags & 1) == 1 ? Marshal.PtrToStringUni(IntPtr.Add(p, cur + 4), (len - 4) / 2) : Marshal.PtrToStringAnsi(IntPtr.Add(p, cur + 4), len - 4);
            res.Add(new string[] { "msg", "0x" + id.ToString("X8"), (id & 0xFFFF).ToString(), text.TrimEnd('\0') });
            cur += len;
          }
        }
      }
      names.Clear();
      EnumResourceNames(h, (IntPtr)6, cb, IntPtr.Zero);
      foreach (var n in names) {
        IntPtr p = LockResource(LoadResource(h, FindResource(h, n, (IntPtr)6)));
        int baseId = ((int)n.ToInt64() - 1) * 16, cur = 0;
        for (int i = 0; i < 16; i++) {
          int len = (ushort)Marshal.ReadInt16(p, cur); cur += 2;
          if (len > 0) res.Add(new string[] { "str", (baseId + i).ToString(), (baseId + i).ToString(), Marshal.PtrToStringUni(IntPtr.Add(p, cur), len) });
          cur += len * 2;
        }
      }
    } finally { FreeLibrary(h); }
    return res;
  }
}
'@
}
function Get-ResStrings([string]$Path) {
  [ResDump]::Dump($Path) | ForEach-Object { [pscustomobject]@{ kind = $_[0]; id = $_[1]; low16 = [int]$_[2]; text = $_[3] } }
}
