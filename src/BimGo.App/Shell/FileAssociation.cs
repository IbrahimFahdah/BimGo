using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Microsoft.Win32;
using BimGo.Format;

// The class belongs to the Shell namespace
namespace BimGo.Shell
{
    /// <summary>
    /// Registers BimGo for the current user, no admin rights needed: the .bimgo file association (double-click opens
    /// in BimGo, with the ">>" icon) under HKCU\Software\Classes, and a Start-menu shortcut.
    ///
    /// <c>BimGo.exe --register</c> / <c>--unregister</c> do it on demand. Otherwise the installed copy
    /// (%LocalAppData%\Programs\BimGo\BimGo.exe, where the build and the add-ins put it) registers itself quietly on
    /// start when the association is missing or points elsewhere, unless the user unregistered. Copies run from
    /// elsewhere (a dev build) never register themselves. Never throws.
    /// </summary>
    internal static class FileAssociation
    {
        #region Constants

        /// <summary>The ProgID .bimgo points to.</summary>
        public const string PROG_ID = "BimGo.Model";

        private const string CLASSES = @"Software\Classes";
        private const string TYPE_NAME = "BimGo model";

        #endregion

        #region Paths

        /// <summary>The shared install folder (%LocalAppData%\Programs\BimGo).</summary>
        public static string InstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BimGo");

        /// <summary>The Start-menu shortcut (per user).</summary>
        public static string ShortcutPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "BimGo.lnk");

        /// <summary>Present after --unregister: the installed copy then leaves the association alone.</summary>
        private static string OptOutMarker => Path.Combine(AppInstance.AppFolder, "no-file-association");

        /// <summary>This process's exe.</summary>
        private static string CurrentExe => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "BimGo.exe");

        #endregion

        #region Public API

        /// <summary>
        /// Startup: the installed copy (re)registers itself if needed. Quick (a few registry reads).
        /// </summary>
        public static void EnsureRegistered()
        {
            try
            {
                string exe = CurrentExe;
                if (!IsInstalledCopy(exe) || File.Exists(OptOutMarker) || IsRegisteredTo(exe)) { return; }
                if (Register(exe, out string error)) { Utilities.Log_Utils.Write($"Registered .bimgo files and the Start-menu shortcut for {exe}."); }
                else { Utilities.Log_Utils.Write($"Automatic registration failed: {error}"); }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Registration check failed: {ex.Message}");
            }
        }

        /// <summary>
        /// --register: associates .bimgo with this exe and adds the Start-menu shortcut.
        /// </summary>
        /// <returns>True on success.</returns>
        public static bool Register(string exe, out string error)
        {
            error = null;
            try
            {
                exe = Path.GetFullPath(exe);
                string command = $"\"{exe}\" \"%1\"";
                string icon = $"\"{exe}\",0";

                // .bimgo → BimGo.Model
                using (RegistryKey extension = Registry.CurrentUser.CreateSubKey($@"{CLASSES}\{BimGoFormat.EXTENSION}"))
                {
                    extension.SetValue(string.Empty, PROG_ID);
                    extension.SetValue("Content Type", "application/x-bimgo");
                    using RegistryKey openWith = extension.CreateSubKey("OpenWithProgids");
                    openWith.SetValue(PROG_ID, string.Empty);
                }

                // BimGo.Model: name, icon, open command
                using (RegistryKey progId = Registry.CurrentUser.CreateSubKey($@"{CLASSES}\{PROG_ID}"))
                {
                    progId.SetValue(string.Empty, TYPE_NAME);
                    progId.SetValue("FriendlyTypeName", TYPE_NAME);
                    using (RegistryKey defaultIcon = progId.CreateSubKey("DefaultIcon")) { defaultIcon.SetValue(string.Empty, icon); }
                    using (RegistryKey open = progId.CreateSubKey(@"shell\open")) { open.SetValue(string.Empty, "Open in BimGo"); }
                    using (RegistryKey openCommand = progId.CreateSubKey(@"shell\open\command")) { openCommand.SetValue(string.Empty, command); }
                }

                // "Open with" list entry for the exe itself
                using (RegistryKey application = Registry.CurrentUser.CreateSubKey($@"{CLASSES}\Applications\BimGo.exe"))
                {
                    application.SetValue("FriendlyAppName", "BimGo");
                    using (RegistryKey appCommand = application.CreateSubKey(@"shell\open\command")) { appCommand.SetValue(string.Empty, command); }
                    using (RegistryKey types = application.CreateSubKey("SupportedTypes")) { types.SetValue(BimGoFormat.EXTENSION, string.Empty); }
                }

                string shortcutError = CreateShortcut(exe);
                if (shortcutError != null) { Utilities.Log_Utils.Write($"Start-menu shortcut not created: {shortcutError}"); }

                TryDelete(OptOutMarker);
                NotifyShell();
                return true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Registration failed: {ex}");
                error = ex.Message;
                return false;
            }
        }

        /// <summary>
        /// --unregister: removes the association (only if it is BimGo's) and the shortcut, and stops the installed
        /// copy re-registering itself.
        /// </summary>
        /// <returns>True on success.</returns>
        public static bool Unregister(out string error)
        {
            error = null;
            try
            {
                using (RegistryKey extension = Registry.CurrentUser.OpenSubKey($@"{CLASSES}\{BimGoFormat.EXTENSION}", writable: false))
                {
                    if (extension != null && string.Equals(extension.GetValue(string.Empty) as string, PROG_ID, StringComparison.OrdinalIgnoreCase))
                    {
                        Registry.CurrentUser.DeleteSubKeyTree($@"{CLASSES}\{BimGoFormat.EXTENSION}", throwOnMissingSubKey: false);
                    }
                }
                Registry.CurrentUser.DeleteSubKeyTree($@"{CLASSES}\{PROG_ID}", throwOnMissingSubKey: false);
                Registry.CurrentUser.DeleteSubKeyTree($@"{CLASSES}\Applications\BimGo.exe", throwOnMissingSubKey: false);
                TryDelete(ShortcutPath);

                Directory.CreateDirectory(Path.GetDirectoryName(OptOutMarker));
                File.WriteAllText(OptOutMarker, "Remove this file (or run BimGo.exe --register) to let BimGo register .bimgo files again.");
                NotifyShell();
                return true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Unregistration failed: {ex}");
                error = ex.Message;
                return false;
            }
        }

        /// <summary>
        /// True if .bimgo opens with this exe and the Start-menu shortcut exists.
        /// </summary>
        public static bool IsRegisteredTo(string exe)
        {
            try
            {
                using RegistryKey extension = Registry.CurrentUser.OpenSubKey($@"{CLASSES}\{BimGoFormat.EXTENSION}");
                if (!string.Equals(extension?.GetValue(string.Empty) as string, PROG_ID, StringComparison.OrdinalIgnoreCase)) { return false; }

                using RegistryKey command = Registry.CurrentUser.OpenSubKey($@"{CLASSES}\{PROG_ID}\shell\open\command");
                string value = command?.GetValue(string.Empty) as string;
                if (value == null || value.IndexOf(Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase) < 0) { return false; }

                return File.Exists(ShortcutPath);
            }
            catch
            {
                return false;
            }
        }

        #endregion

        #region Helpers

        /// <summary>
        /// True if the exe is the shared installed copy.
        /// </summary>
        private static bool IsInstalledCopy(string exe)
        {
            try
            {
                string folder = Path.GetFullPath(Path.GetDirectoryName(exe) ?? string.Empty).TrimEnd(Path.DirectorySeparatorChar);
                return string.Equals(folder, Path.GetFullPath(InstallDir).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Creates (or replaces) the Start-menu shortcut.
        /// </summary>
        /// <returns>Null on success, else a reason.</returns>
        private static string CreateShortcut(string exe)
        {
            object link = null;
            try
            {
                link = new ShellLinkCoClass();
                var shellLink = (IShellLinkW)link;
                shellLink.SetPath(exe);
                shellLink.SetWorkingDirectory(Path.GetDirectoryName(exe));
                shellLink.SetDescription("BimGo: walk through BIM models");
                shellLink.SetIconLocation(exe, 0);

                Directory.CreateDirectory(Path.GetDirectoryName(ShortcutPath));
                ((IPersistFile)link).Save(ShortcutPath, true);
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            finally
            {
                if (link != null && Marshal.IsComObject(link)) { Marshal.ReleaseComObject(link); }
            }
        }

        /// <summary>
        /// Tells Explorer the associations changed (icons refresh without a restart).
        /// </summary>
        private static void NotifyShell()
        {
            try { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0); }
            catch { /* icons refresh later */ }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) { File.Delete(path); } }
            catch { /* best effort */ }
        }

        #endregion

        #region Native

        private const int SHCNE_ASSOCCHANGED = 0x08000000;
        private const uint SHCNF_IDLIST = 0x0000;

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(int eventId, uint flags, nint item1, nint item2);

        /// <summary>CLSID_ShellLink.</summary>
        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkCoClass
        {
        }

        /// <summary>IShellLinkW (only the setters are used; the vtable order must match the SDK).</summary>
        [ComImport]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, nint findData, int flags);
            void GetIDList(out nint idList);
            void SetIDList(nint idList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int maxPath);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int maxPath);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out short hotkey);
            void SetHotkey(short hotkey);
            void GetShowCmd(out int showCmd);
            void SetShowCmd(int showCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxIconPath, out int icon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int icon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, int reserved);
            void Resolve(nint hwnd, int flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        #endregion
    }
}
