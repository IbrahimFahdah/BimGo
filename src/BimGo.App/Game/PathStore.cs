using System.Numerics;
using BimGo.Format;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Round K-A: the session's keyframed camera paths, persisted like bookmarks:
    /// <list type="bullet">
    /// <item><b>Sidecar</b> (Revit sessions): <c>paths.json</c> in the model folder, saved on every change.</item>
    /// <item><b>Embedded</b> (.bimgo files): kept in memory and saved with the file (<c>paths.json</c>); changes raise
    /// <see cref="Changed"/> so the document can be marked dirty.</item>
    /// </list>
    /// Positions are kept in Revit internal metres (like bookmarks); <see cref="CameraKey.Local"/> is the scene-local copy.
    /// All IO failures are caught and reported via <see cref="LastError"/>.
    /// </summary>
    internal sealed class PathStore
    {
        /// <summary>Longest path or key name accepted.</summary>
        public const int MAX_NAME = 60;

        private readonly string _path;
        private readonly string _model;
        private readonly Vector3 _origin;

        /// <summary>All paths, in list order.</summary>
        public List<CameraPath> Paths { get; } = new();

        /// <summary>The last IO error, or null.</summary>
        public string LastError { get; private set; }

        /// <summary>True when paths live inside a .bimgo file rather than the model folder.</summary>
        public bool IsEmbedded => _path == null;

        /// <summary>Where paths are kept (for the panel's sub-line).</summary>
        public string FileName => IsEmbedded ? "this file" : Path.GetFileName(_path);

        /// <summary>Incremented on every change (dirty tracking for embedded paths; the panel's cached timings).</summary>
        public int Revision { get; private set; }

        /// <summary>Raised after any change.</summary>
        public event Action Changed;

        /// <summary>
        /// Creates the store.
        /// </summary>
        /// <param name="sidecarPath">Sidecar path, or null to keep paths embedded in the document.</param>
        /// <param name="model">Model title.</param>
        /// <param name="origin">Scene origin offset (metres).</param>
        public PathStore(string sidecarPath, string model, Vector3 origin)
        {
            _path = sidecarPath;
            _model = model;
            _origin = origin;
        }

        #region Load / save

        /// <summary>Loads the sidecar. No-op for embedded stores.</summary>
        public void Load()
        {
            if (IsEmbedded) { return; }
            CameraPathDocument document = CameraPathFiles.Read(_path, out string error);
            LastError = error;
            if (document != null) { LoadFrom(document); }
        }

        /// <summary>Loads paths from a document (a .bimgo's paths.json). Does not count as a change.</summary>
        public void LoadFrom(CameraPathDocument document)
        {
            if (document?.Paths == null) { return; }
            foreach (CameraPath path in document.Paths)
            {
                if (path == null) { continue; }
                path.Clean();
                foreach (CameraKey key in path.Keys) { Prepare(key); }
                Paths.Add(path);
            }
        }

        /// <summary>The paths as a document (for saving into a .bimgo), or null when there are none.</summary>
        public CameraPathDocument ToDocument() => Paths.Count == 0 ? null : new CameraPathDocument { Model = _model, Paths = Paths.ToList() };

        /// <summary>
        /// Records a change: writes the sidecar, or (embedded) just flags the change for the document.
        /// </summary>
        /// <returns>True on success.</returns>
        public bool Save()
        {
            Revision++;
            bool saved = true;
            if (!IsEmbedded)
            {
                saved = CameraPathFiles.Write(_path, ToDocument() ?? new CameraPathDocument { Model = _model }, out string error);
                LastError = error;
            }

            try { Changed?.Invoke(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Path change handler failed: {ex.Message}"); }
            return saved;
        }

        #endregion

        #region Paths

        /// <summary>The next free default path name: "Path 1", "Path 2"…</summary>
        public string NextPathName()
        {
            for (int n = Paths.Count + 1; n < Paths.Count + 1000; n++)
            {
                string name = $"Path {n}";
                if (!Paths.Exists(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))) { return name; }
            }
            return "Path";
        }

        /// <summary>Adds an empty path and saves.</summary>
        public CameraPath AddPath()
        {
            var path = new CameraPath { Name = NextPathName() };
            Paths.Add(path);
            Save();
            return path;
        }

        /// <summary>
        /// Round K-C: adds a path built elsewhere (CONVERT TO PATH) at the end and saves. Its keys' stored positions are
        /// set from their scene-local ones; its name is made unique ("… 2", "… 3"…).
        /// </summary>
        /// <returns>The path, or null when it is null or already in the store.</returns>
        public CameraPath AddPath(CameraPath path)
        {
            if (path == null || Paths.Contains(path)) { return null; }
            path.Keys ??= new List<CameraKey>();
            foreach (CameraKey key in path.Keys)
            {
                if (key == null) { continue; }
                SetPosition(key, key.Local);
                if (key.TargetLocal is Vector3 target)
                {
                    key.TargetX = Math.Round(target.X + (double)_origin.X, 4);
                    key.TargetY = Math.Round(target.Y + (double)_origin.Y, 4);
                    key.TargetZ = Math.Round(target.Z + (double)_origin.Z, 4);
                }
            }
            path.Clean();
            foreach (CameraKey key in path.Keys) { Prepare(key); }
            path.Name = UniqueName(CleanName(path.Name) ?? NextPathName());
            Paths.Add(path);
            Save();
            return path;
        }

        /// <summary>K-C: a name no other path has: the name itself, else "name 2", "name 3"…</summary>
        public string UniqueName(string name)
        {
            bool Taken(string candidate) => Paths.Exists(p => string.Equals(p.Name, candidate, StringComparison.OrdinalIgnoreCase));
            if (!Taken(name)) { return name; }
            for (int n = 2; n < 1000; n++)
            {
                string candidate = CleanName($"{name} {n}") ?? name;
                if (!Taken(candidate)) { return candidate; }
            }
            return name;
        }

        /// <summary>Adds a copy of a path (" copy" on its name) after it and saves.</summary>
        public CameraPath Duplicate(CameraPath path)
        {
            int index = Paths.IndexOf(path);
            if (index < 0) { return null; }
            CameraPath copy = path.Copy();
            copy.Name = CleanName(path.Name + " copy") ?? path.Name;
            foreach (CameraKey key in copy.Keys) { Prepare(key); }
            Paths.Insert(index + 1, copy);
            Save();
            return copy;
        }

        /// <summary>Renames a path and saves.</summary>
        /// <returns>False if the path is not in this store or the name is empty.</returns>
        public bool Rename(CameraPath path, string name)
        {
            string clean = CleanName(name);
            if (path == null || !Paths.Contains(path) || clean == null) { return false; }
            if (clean == path.Name) { return true; }
            path.Name = clean;
            Save();
            return true;
        }

        /// <summary>Removes a path and saves.</summary>
        public void Remove(CameraPath path)
        {
            if (Paths.Remove(path)) { Save(); }
        }

        /// <summary>Moves a path one place up (-1) or down (+1) and saves.</summary>
        public bool Move(CameraPath path, int direction)
        {
            int index = Paths.IndexOf(path);
            int target = index + Math.Sign(direction);
            if (index < 0 || target < 0 || target >= Paths.Count) { return false; }
            Paths.RemoveAt(index);
            Paths.Insert(target, path);
            Save();
            return true;
        }

        #endregion

        #region Keys

        /// <summary>The next free default key name in a path: "Key 1", "Key 2"…</summary>
        public static string NextKeyName(CameraPath path)
        {
            int count = path?.Keys.Count ?? 0;
            for (int n = count + 1; n < count + 1000; n++)
            {
                string name = $"Key {n}";
                if (path == null || !path.Keys.Exists(k => string.Equals(k.Name, name, StringComparison.OrdinalIgnoreCase))) { return name; }
            }
            return "Key";
        }

        /// <summary>
        /// Adds a key at a scene-local eye position and view, at <paramref name="index"/> (or the end), and saves.
        /// </summary>
        /// <returns>The key, or null when the path is full or not in this store.</returns>
        public CameraKey AddKey(CameraPath path, int index, Vector3 localEye, float yaw, float pitch)
        {
            if (path == null || !Paths.Contains(path) || path.Keys.Count >= CameraPath.MAX_KEYS) { return null; }
            var key = new CameraKey { Name = NextKeyName(path), Yaw = yaw, Pitch = Math.Clamp(pitch, -1.5f, 1.5f) };
            SetPosition(key, localEye);
            Prepare(key);
            path.Keys.Insert(Math.Clamp(index < 0 ? path.Keys.Count : index, 0, path.Keys.Count), key);
            Save();
            return key;
        }

        /// <summary>Moves a key to a new scene-local eye position and view (SET TO THIS VIEW) and saves.</summary>
        /// <param name="save">False while a handle is being dragged (K-B): the change is counted (the path redraws) but
        /// not written until <see cref="Touch"/> at the end of the drag.</param>
        public bool SetKeyView(CameraPath path, CameraKey key, Vector3 localEye, float yaw, float pitch, bool save = true)
        {
            if (!Owns(path, key)) { return false; }
            SetPosition(key, localEye);
            key.Yaw = yaw;
            key.Pitch = Math.Clamp(pitch, -1.5f, 1.5f);
            Prepare(key);
            if (save) { Save(); }
            else { Revision++; }
            return true;
        }

        /// <summary>Sets (or with null clears) a key's look-at target from a scene-local point and saves.</summary>
        /// <param name="save">False while a handle is being dragged (see <see cref="SetKeyView"/>).</param>
        public bool SetKeyTarget(CameraPath path, CameraKey key, Vector3? localTarget, bool save = true)
        {
            if (!Owns(path, key)) { return false; }
            if (localTarget is Vector3 target)
            {
                key.TargetX = Math.Round(target.X + (double)_origin.X, 4);
                key.TargetY = Math.Round(target.Y + (double)_origin.Y, 4);
                key.TargetZ = Math.Round(target.Z + (double)_origin.Z, 4);
            }
            else
            {
                key.TargetX = key.TargetY = key.TargetZ = null;
            }
            Prepare(key);
            if (save) { Save(); }
            else { Revision++; }
            return true;
        }

        /// <summary>
        /// Round K-B: undo: puts a path back as a snapshot had it (the same instance; its keys are fresh copies) and saves.
        /// </summary>
        public bool Restore(CameraPath path, CameraPath snapshot)
        {
            if (path == null || snapshot == null || !Paths.Contains(path)) { return false; }
            path.CopyFrom(snapshot);
            foreach (CameraKey key in path.Keys) { Prepare(key); }
            Save();
            return true;
        }

        /// <summary>Renames a key and saves.</summary>
        public bool RenameKey(CameraPath path, CameraKey key, string name)
        {
            string clean = CleanName(name);
            if (!Owns(path, key) || clean == null) { return false; }
            if (clean == key.Name) { return true; }
            key.Name = clean;
            Save();
            return true;
        }

        /// <summary>Moves a key one place up (-1) or down (+1) and saves.</summary>
        public bool MoveKey(CameraPath path, CameraKey key, int direction)
        {
            if (!Owns(path, key)) { return false; }
            int index = path.Keys.IndexOf(key);
            int target = index + Math.Sign(direction);
            if (target < 0 || target >= path.Keys.Count) { return false; }
            path.Keys.RemoveAt(index);
            path.Keys.Insert(target, key);
            Save();
            return true;
        }

        /// <summary>Removes a key and saves.</summary>
        public void RemoveKey(CameraPath path, CameraKey key)
        {
            if (Owns(path, key) && path.Keys.Remove(key)) { Save(); }
        }

        /// <summary>
        /// A field of a path or key changed (the panel edits them in place): re-cleans the path and records the change.
        /// </summary>
        public void Touch(CameraPath path)
        {
            if (path == null || !Paths.Contains(path)) { return; }
            path.Clean();
            Save();
        }

        private bool Owns(CameraPath path, CameraKey key) => path != null && key != null && Paths.Contains(path) && path.Keys.Contains(key);

        #endregion

        #region Helpers

        /// <summary>A trimmed name limited to <see cref="MAX_NAME"/> characters, or null if empty.</summary>
        public static string CleanName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) { return null; }
            name = name.Trim();
            return name.Length > MAX_NAME ? name[..MAX_NAME].TrimEnd() : name;
        }

        private void SetPosition(CameraKey key, Vector3 localEye)
        {
            key.X = Math.Round(localEye.X + (double)_origin.X, 4);
            key.Y = Math.Round(localEye.Y + (double)_origin.Y, 4);
            key.Z = Math.Round(localEye.Z + (double)_origin.Z, 4);
        }

        /// <summary>Fills a key's scene-local positions from its stored (Revit internal) ones.</summary>
        private void Prepare(CameraKey key)
        {
            key.Local = new Vector3((float)(key.X - _origin.X), (float)(key.Y - _origin.Y), (float)(key.Z - _origin.Z));
            key.TargetLocal = key.HasTarget
                ? new Vector3((float)(key.TargetX.Value - _origin.X), (float)(key.TargetY.Value - _origin.Y), (float)(key.TargetZ.Value - _origin.Z))
                : null;
        }

        #endregion
    }
}
