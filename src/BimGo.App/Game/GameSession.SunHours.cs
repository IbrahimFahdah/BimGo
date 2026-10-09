using System.Globalization;
using System.Numerics;
using BimGo.Audio;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Direct sun hours study (sun hours round). J (or pause menu → SUN HOURS) opens the study panel: the player
    /// stands still, the cursor is free, RMB-drag looks around. The walls and floors of the room you stand in are
    /// selected; clicking a surface adds or removes it. RUN casts a ray towards the sun from every grid cell every
    /// <see cref="SunHoursSettings.StepMinutes"/> minutes over the chosen time range and colours the cells on
    /// Ladybug's 0–7 h legend. Results stay (also with the panel closed) until CLEAR or the session ends; EXPORT CSV
    /// and SCREENSHOT (with the legend) keep them.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private static readonly string[] GRID_OPTIONS = { "0.1", "0.25", "0.5", "1 m" };
        private static readonly string[] STEP_OPTIONS = { "5 min", "10 min", "15 min" };

        /// <summary>Ray casting time per frame while a study runs (ms).</summary>
        private const double SUN_BUDGET_MS = 10.0;

        private bool _sunHoursOpen;
        private SunHoursSettings _sunHours = new();
        private readonly SunHoursStudy _sunStudy = new();
        private readonly List<SunHoursFace> _sunFaces = new();
        private int _sunFacesRoom = -1;
        private bool _sunGridDirty = true;
        private Overlay3D _sunOverlay;
        private int _sunOverlayRevision = -1;
        private bool _sunOpaqueOnly = true;
        private Func<Vector3, Vector3, float, bool> _sunBlocked;
        private Vector4 _sunPanelRect;
        private bool _sunShotRequested;
        private string _sunNotice;
        private string _sunSummary;
        private string _sunLegendTitle;
        private bool _sunStale;

        #endregion

        #region Open / close

        /// <summary>True while the study panel is open (cursor free, player still).</summary>
        private bool IsSunHoursOpen => _sunHoursOpen;

        /// <summary>
        /// Opens the study panel. The first time (or when the selection is empty) it selects the room you stand in.
        /// </summary>
        private void OpenSunHours()
        {
            if (_sunHoursOpen) { return; }
            if (_paused) { SetPaused(false); }
            CloseSunPanel();
            ShowUi();
            _sunHoursOpen = true;
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            Sound.Play(SoundId.UiClick);
            _sunBlocked ??= SunRayBlocked;
            _sunHours.DaylightSaving = _sun?.Time?.DaylightSaving ?? _sunHours.DaylightSaving;
            if (_sunFaces.Count == 0) { SelectRoomFaces(_roomIndex); }
        }

        /// <summary>
        /// Closes the panel (a finished study stays on screen with its legend; a running one keeps running).
        /// </summary>
        private void CloseSunHours()
        {
            if (!_sunHoursOpen) { return; }
            _sunHoursOpen = false;
            _window.Input.ReleaseAll();
            if (!_paused && _window.IsActive) { _window.SetCaptured(true); }
        }

        /// <summary>
        /// Keys and mouse while the panel is open: Esc / J close, RMB-drag looks, a click on the model (outside the
        /// panel) adds or removes that surface.
        /// </summary>
        private void UpdateSunHoursMode(InputState input)
        {
            if (input.IsPressed(Vk.VK_ESCAPE) || input.IsPressed('J'))
            {
                CloseSunHours();
                return;
            }
            if (input.IsPressed(Vk.VK_F11)) { _window.ToggleFullscreen(); }
            if (input.IsPressed(Vk.VK_F12)) { RequestScreenshot(); }
            if (input.RightDown) { _player.Look(input.MouseDeltaX, input.MouseDeltaY, _sensitivity, _invertY); }

            Vector2 m = input.MousePosition;
            bool overPanel = m.X >= _sunPanelRect.X && m.X < _sunPanelRect.X + _sunPanelRect.Z && m.Y >= _sunPanelRect.Y && m.Y < _sunPanelRect.Y + _sunPanelRect.W;
            if (input.LeftPressed && !overPanel && !_sunStudy.Running)
            {
                input.ConsumeClicks();
                PickSunFace(m);
            }
        }

        /// <summary>
        /// Per frame: rebuilds the grid after a change, runs the study a few milliseconds, reports the end.
        /// </summary>
        private void UpdateSunStudy()
        {
            if (_sunGridDirty)
            {
                _sunGridDirty = false;
                _sunStudy.Build(_sunFaces, _sunHours.Clean(DateTime.Today.Year), Scene.Rooms);
                _sunSummary = null;
                _sunStale = false;
                if (_sunStudy.Truncated) { _sunNotice = $"Over {SunHoursStudy.MAX_CELLS:N0} cells: pick a larger grid or fewer surfaces"; }
            }
            if (!_sunStudy.Running) { return; }

            _sunStudy.Step(_sunBlocked, SUN_BUDGET_MS);
            if (_sunStudy.Finished)
            {
                (float average, float min, float max, float two, float three) = _sunStudy.Statistics();
                _sunSummary = $"Average {average:0.0} h · min {min:0.0} · max {max:0.0} · {two:P0} ≥ 2 h · {three:P0} ≥ 3 h";
                Utilities.Log_Utils.Write($"Sun hours: {_sunStudy.CellCount:N0} cells × {_sunStudy.SunSamples} sun samples in {_sunStudy.Elapsed.TotalSeconds:0.0} s. {_sunSummary}.");
                Sound.Play(SoundId.Commit);
                Toast("Sun hours study done: " + _sunSummary, 4f);
            }
        }

        /// <summary>
        /// True when a ray from a test point towards the sun hits visible geometry (glass passes unless it blocks).
        /// </summary>
        private bool SunRayBlocked(Vector3 origin, Vector3 direction, float distance)
        {
            if (_bvh.Raycast(origin, direction, distance, _pickMask, out RayHit _, _sunOpaqueOnly)) { return true; }
            return Dynamics != null && Dynamics.Raycast(origin, direction, distance, out RayHit _, null, _sunOpaqueOnly);
        }

        #endregion

        #region Targets

        /// <summary>
        /// Selects the walls and floors of a room (replacing the selection): every opaque wall or floor triangle near
        /// the room, grouped into faces by element and plane; the grid keeps only the cells inside the room.
        /// </summary>
        private void SelectRoomFaces(int roomIndex)
        {
            _sunFaces.Clear();
            _sunFacesRoom = roomIndex;
            _sunGridDirty = true;
            if (roomIndex < 0 || roomIndex >= Scene.Rooms.Length)
            {
                _sunNotice = "You are not in a room: click walls or floors to test them";
                return;
            }

            RoomInfo room = Scene.Rooms[roomIndex];
            int walls = CategoryCatalog.Find("walls")?.Index ?? -1, floors = CategoryCatalog.Find("floors")?.Index ?? -1;
            var box = new Aabb(new Vector3(room.Min - new Vector2(0.6f), room.BottomZ - 0.5f), new Vector3(room.Max + new Vector2(0.6f), room.TopZ + 0.5f));
            var byKey = new Dictionary<(int, int, int, int, int), SunHoursFace>();
            ElementRecord[] elements = Scene.Elements;
            SceneVertex[] vertices = Scene.Vertices;
            uint[] indices = Scene.Indices;

            for (int e = 0; e < elements.Length; e++)
            {
                ElementRecord record = elements[e];
                bool isWall = record.CategoryIndex == walls, isFloor = record.CategoryIndex == floors;
                if ((!isWall && !isFloor) || !_pickMask[e] || !record.Bounds.Overlaps(box)) { continue; }

                for (int i = record.OpaqueStart; i + 2 < record.OpaqueStart + record.OpaqueCount; i += 3)
                {
                    Vector3 a = vertices[indices[i]].Position, b = vertices[indices[i + 1]].Position, c = vertices[indices[i + 2]].Position;
                    Vector3 cross = Vector3.Cross(b - a, c - a);
                    if (cross.LengthSquared() < 1e-10f) { continue; }
                    Vector3 n = Vector3.Normalize(cross);
                    Vector3 centre = (a + b + c) / 3f;

                    bool horizontal = MathF.Abs(n.Z) > 0.9f;
                    if (horizontal)
                    {
                        // Floor tops at the room's floor (the slab's underside belongs to the room below)
                        if (MathF.Abs(centre.Z - room.BottomZ) > 0.15f) { continue; }
                        n = Vector3.UnitZ;
                    }
                    else if (MathF.Abs(n.Z) < 0.2f)
                    {
                        // Walls: one sign per plane (each cell then faces into the room)
                        if (n.X < -1e-4f || (MathF.Abs(n.X) <= 1e-4f && n.Y < 0f)) { n = -n; }
                    }
                    else { continue; }

                    float offset = Vector3.Dot(n, centre);
                    var key = (e, (int)MathF.Round(n.X * 50f), (int)MathF.Round(n.Y * 50f), (int)MathF.Round(n.Z * 50f), (int)MathF.Round(offset / 0.02f));
                    if (!byKey.TryGetValue(key, out SunHoursFace face))
                    {
                        face = new SunHoursFace { Element = e, Normal = n, Offset = offset, Room = roomIndex, BothSides = !horizontal };
                        byKey[key] = face;
                        _sunFaces.Add(face);
                    }
                    face.Triangles.Add((a, b, c));
                }
            }
            _sunNotice = _sunFaces.Count == 0 ? "No walls or floors found around this room: click surfaces to test them" : null;
        }

        /// <summary>
        /// A click on the model: removes the surface under the cursor when it is selected, else adds it (the element's
        /// triangles in that plane, tested on the side facing you, clipped to the room on that side if there is one).
        /// </summary>
        private void PickSunFace(Vector2 mouse)
        {
            ScreenRay(mouse, out Vector3 origin, out Vector3 direction);
            bool hitStatic = _bvh.Raycast(origin, direction, 300f, _pickMask, out RayHit hit);
            if (Dynamics != null && Dynamics.Raycast(origin, direction, hitStatic ? hit.Distance : 300f, out RayHit _))
            {
                Sound.Play(SoundId.Error);
                _sunNotice = "Moved or placed elements can't be tested (they still cast shade)";
                return;
            }
            if (!hitStatic)
            {
                Sound.Play(SoundId.Error);
                return;
            }

            Vector3 n = hit.Normal;
            float offset = Vector3.Dot(n, hit.Point);
            for (int i = 0; i < _sunFaces.Count; i++)
            {
                if (_sunFaces[i].SamePlane(hit.Element, n, offset))
                {
                    _sunFaces.RemoveAt(i);
                    _sunGridDirty = true;
                    Sound.Play(SoundId.Remove);
                    _sunNotice = "Surface removed";
                    return;
                }
            }

            // The element's triangles in the clicked plane
            ElementRecord record = Scene.Elements[hit.Element];
            var face = new SunHoursFace { Element = hit.Element, Normal = n, Offset = offset, Picked = true };
            SceneVertex[] vertices = Scene.Vertices;
            uint[] indices = Scene.Indices;
            for (int i = record.OpaqueStart; i + 2 < record.OpaqueStart + record.OpaqueCount; i += 3)
            {
                Vector3 a = vertices[indices[i]].Position, b = vertices[indices[i + 1]].Position, c = vertices[indices[i + 2]].Position;
                if (MathF.Abs(Vector3.Dot(n, a) - offset) > 0.02f || MathF.Abs(Vector3.Dot(n, b) - offset) > 0.02f || MathF.Abs(Vector3.Dot(n, c) - offset) > 0.02f) { continue; }
                face.Triangles.Add((a, b, c));
            }
            if (face.Triangles.Count == 0)
            {
                Sound.Play(SoundId.Error);
                _sunNotice = "That surface isn't flat enough to test (pick a wall, floor or bench top)";
                return;
            }

            // Clipped to the room it faces (a slab or a long wall otherwise covers the whole level)
            face.Room = FindRoom(hit.Point + n * 0.15f);
            _sunFaces.Add(face);
            _sunGridDirty = true;
            Sound.Play(SoundId.Click);
            _sunNotice = $"Added: {record.Name}{(face.Room >= 0 ? " (in " + RoomLabel(face.Room) + ")" : string.Empty)}";
        }

        /// <summary>The world ray under a window pixel.</summary>
        private void ScreenRay(Vector2 pixel, out Vector3 origin, out Vector3 direction)
        {
            float x = pixel.X / Math.Max(1, _window.Width) * 2f - 1f;
            float y = 1f - pixel.Y / Math.Max(1, _window.Height) * 2f;
            Matrix4x4 inverse = Camera.InverseViewProjection;
            Vector4 near = Vector4.Transform(new Vector4(x, y, -1f, 1f), inverse);
            Vector4 far = Vector4.Transform(new Vector4(x, y, 1f, 1f), inverse);
            Vector3 a = new Vector3(near.X, near.Y, near.Z) / near.W;
            Vector3 b = new Vector3(far.X, far.Y, far.Z) / far.W;
            origin = Camera.Position;
            direction = Vector3.Normalize(b - a);
        }

        /// <summary>"2.05 Kitchen" (number and name).</summary>
        private string RoomLabel(int room)
        {
            if (room < 0 || room >= Scene.Rooms.Length) { return "no room"; }
            RoomInfo r = Scene.Rooms[room];
            return string.IsNullOrWhiteSpace(r.Number) || r.Number == "—" ? r.Name : $"{r.Number} {r.Name}";
        }

        #endregion

        #region Run, clear, export

        /// <summary>
        /// RUN: the sun positions over the range (above the horizon), then the time-sliced ray casting.
        /// </summary>
        private void RunSunStudy()
        {
            if (_sunGridDirty) { UpdateSunStudy(); }
            if (_sunStudy.CellCount == 0)
            {
                Sound.Play(SoundId.Error);
                _sunNotice = "Nothing to test: select a room (THIS ROOM) or click surfaces";
                return;
            }

            SunHoursSettings settings = _sunHours.Clean(DateTime.Today.Year);
            List<Vector3> directions = SunHours.SunDirections(Scene.Site, DateTime.Today.Year, settings, out int total, out bool known);
            _sunOpaqueOnly = !settings.GlassBlocks;
            _sunStudy.Start(directions, total, settings);
            _sunSummary = null;
            _sunStale = false;
            _sunLegendTitle = $"DIRECT SUN HOURS · {settings.Day} {MONTHS[settings.Month - 1]} {Clock(settings.StartMinutes)}–{Clock(settings.EndMinutes)}" +
                $" · {settings.StepMinutes} min{(settings.GlassBlocks ? " · glass blocks" : string.Empty)}";
            _sunNotice = directions.Count == 0 ? "The sun is below the horizon for the whole range: every cell gets 0 h"
                : known ? null : "No site location in this model: Sydney assumed (set Revit's Location)";
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>CLEAR RESULTS: the grid stays selected, the colours go.</summary>
        private void ClearSunResults()
        {
            _sunStudy.Cancel();
            _sunGridDirty = true;
            _sunSummary = null;
            _sunNotice = "Results cleared";
        }

        /// <summary>
        /// Writes the study to a CSV file: the settings, then one row per cell (surface, element, point and normal in
        /// Revit internal metres, hours).
        /// </summary>
        private void ExportSunHours()
        {
            if (_sunStudy.Hours == null || _sunStudy.Done == 0) { return; }
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = Path.GetFileNameWithoutExtension(DocumentName) + " sun hours.csv";
            string path = FileDialogs.ShowSave(_window.Handle, "Export sun hours", "CSV file (*.csv)|*.csv|All files (*.*)|*.*", SuggestedFolder(), name, ".csv");
            if (path == null) { return; }

            try
            {
                SunHoursSettings s = _sunStudy.RunSettings;
                CultureInfo inv = CultureInfo.InvariantCulture;
                var lines = new List<string>
                {
                    "BimGo direct sun hours",
                    $"Model,{Csv(Scene.ModelTitle)}",
                    $"Date,{s.Day} {MONTHS[s.Month - 1]}",
                    $"From,{Clock(s.StartMinutes)}",
                    $"To,{Clock(s.EndMinutes)}",
                    $"Step (min),{s.StepMinutes}",
                    $"Daylight saving,{(s.DaylightSaving ? "yes" : "no")}",
                    $"Glass,{(s.GlassBlocks ? "blocks sun" : "lets sun through")}",
                    $"Grid (m),{_sunStudy.Settings.GridSize.ToString(inv)}",
                    $"Floor offset (m),{_sunStudy.Settings.FloorOffset.ToString(inv)}",
                    $"Wall offset (m),{_sunStudy.Settings.WallOffset.ToString(inv)}",
                    $"Sun samples above the horizon,{_sunStudy.SunSamples} of {_sunStudy.TotalSamples}",
                    $"Summary,{Csv(_sunSummary ?? "incomplete")}",
                    string.Empty,
                    "Cell,Surface,Element id,Element,Room,X (m),Y (m),Z (m),Normal X,Normal Y,Normal Z,Sun hours"
                };
                for (int i = 0; i < _sunStudy.Done; i++)
                {
                    _sunStudy.Cell(i, out Vector3 p, out Vector3 n, out _, out _, out int f);
                    SunHoursFace face = _sunStudy.Faces[f];
                    ElementRecord record = Scene.Elements[face.Element];
                    Vector3 world = ToRevit(p);
                    lines.Add(string.Join(",",
                        (i + 1).ToString(inv),
                        face.Horizontal ? "Floor" : "Wall",
                        record.ElementId.ToString(inv),
                        Csv(record.Name),
                        Csv(face.Room >= 0 ? RoomLabel(face.Room) : string.Empty),
                        world.X.ToString("0.###", inv), world.Y.ToString("0.###", inv), world.Z.ToString("0.###", inv),
                        n.X.ToString("0.###", inv), n.Y.ToString("0.###", inv), n.Z.ToString("0.###", inv),
                        _sunStudy.Hours[i].ToString("0.###", inv)));
                }
                File.WriteAllLines(path, lines, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
                _sunNotice = $"Exported {_sunStudy.Done:N0} cells to {Path.GetFileName(path)}";
                Sound.Play(SoundId.Commit);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Sun hours export failed: {ex}");
                _sunNotice = "Export failed: " + ex.Message;
                Sound.Play(SoundId.Error);
            }

            static string Csv(string value)
            {
                value ??= string.Empty;
                return value.IndexOfAny(new[] { ',', '"', '\n', '\r' }) >= 0 ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
            }
        }

        /// <summary>"09:00".</summary>
        private static string Clock(int minutes) => $"{minutes / 60:00}:{minutes % 60:00}";

        #endregion

        #region Drawing

        /// <summary>
        /// The grid in the 3D pass: computed cells in their legend colour, the rest grey (a preview while the panel is
        /// open, "not yet" while running). Rebuilt only when the study changes. Nothing when closed without results.
        /// </summary>
        private void DrawSunHoursCells()
        {
            if (_sunStudy.CellCount == 0 || (!_sunHoursOpen && _sunStudy.Hours == null)) { return; }
            if (_sunOverlay == null)
            {
                _sunOverlay = new Overlay3D();
                _sunOverlay.Initialise();
            }

            if (_sunOverlayRevision != _sunStudy.Revision)
            {
                _sunOverlayRevision = _sunStudy.Revision;
                _sunOverlay.Begin(Camera);
                float half = _sunStudy.Settings.GridSize * 0.47f;
                uint pending = Rgba.Hex(0xE5E7EB, _sunStudy.Running ? 0.25f : 0.45f);
                for (int i = 0; i < _sunStudy.CellCount; i++)
                {
                    _sunStudy.Cell(i, out Vector3 p, out _, out Vector3 u, out Vector3 v, out _);
                    uint colour = pending;
                    if (_sunStudy.Hours != null && i < _sunStudy.Done)
                    {
                        Vector3 c = SunHours.LegendColour(_sunStudy.Hours[i]);
                        colour = Rgba.FromFloat(c.X, c.Y, c.Z, 0.92f);
                    }
                    Vector3 du = u * half, dv = v * half;
                    _sunOverlay.Quad(p - du - dv, p + du - dv, p + du + dv, p - du + dv, colour);
                }
            }
            _sunOverlay.Draw(Camera, depthTest: true, alpha: 1f, additive: false);
        }

        /// <summary>
        /// The legend (bottom left, also in the study screenshot): Ladybug's colours from 0 to 7+ h with whole-hour
        /// ticks, and the study's date and times.
        /// </summary>
        private void BuildSunLegend(FontAtlas f, float x, float y)
        {
            if (_sunStudy.Hours == null || _sunLegendTitle == null) { return; }
            float w = S(360), h = S(78);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
            _ui.Text(f.Small, x + S(12), y + S(8), _sunLegendTitle, UiTheme.SUN, S(0.5f));

            float barX = x + S(12), barY = y + S(30), barW = w - S(24), barH = S(14);
            const int STEPS = 56;
            for (int i = 0; i < STEPS; i++)
            {
                Vector3 c = SunHours.LegendColour((i + 0.5f) / STEPS * SunHours.LEGEND_MAX);
                _ui.Rect(barX + barW * i / STEPS, barY, barW / STEPS + 0.5f, barH, Rgba.FromFloat(c.X, c.Y, c.Z, 1f));
            }
            for (int hour = 0; hour <= (int)SunHours.LEGEND_MAX; hour++)
            {
                float tx = barX + barW * hour / SunHours.LEGEND_MAX;
                _ui.Rect(tx - S(0.5f), barY + barH, S(1), S(4), UiTheme.TEXT_SOFT);
                Text.Clear().Append(hour);
                if (hour == (int)SunHours.LEGEND_MAX) { Text.Append("+ h"); }
                _ui.TextCentred(f.Small, tx, barY + barH + S(6), Text.Span, UiTheme.TEXT_SOFT);
            }
        }

        /// <summary>
        /// The study panel (right side): date, time range and step, DST, grid size, offsets, glass, the surfaces,
        /// RUN / progress, results and exports.
        /// </summary>
        private void BuildSunHoursPanel(FontAtlas f, InputState input)
        {
            float w = S(380), x = _window.Width - S(20) - w, y = S(20);
            float h = MathF.Min(_window.Height - S(40), S(700));
            _sunPanelRect = new Vector4(x, y, w, h);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.SUN);
            float ix = x + S(16), iw = w - S(32), cy = y + S(14);
            _ui.Text(f.Small, ix, cy, "SUN HOURS STUDY", UiTheme.SUN, S(1.4f));
            cy += S(28);

            bool shift = input.IsDown(Vk.VK_SHIFT);
            bool locked = _sunStudy.Running;
            SunHoursSettings s = _sunHours;
            int year = DateTime.Today.Year;

            // Date: « month » ‹ day ›
            _ui.Text(f.Body, ix, cy + S(7), "Date", UiTheme.TEXT_SOFT);
            float fx = ix + S(110);
            if (SmallButton(f, input, fx, cy, S(30), S(30), "«") && !locked) { s.Month = (s.Month + 10) % 12 + 1; SunSettingChanged(false); }
            if (SmallButton(f, input, fx + S(34), cy, S(30), S(30), "‹") && !locked) { StepDay(s, -1, year); SunSettingChanged(false); }
            Text.Clear().Append(Math.Min(s.Day, DateTime.DaysInMonth(year, s.Month))).Append(' ').Append(MONTHS[s.Month - 1]);
            _ui.TextCentred(f.Bold, fx + S(68) + S(50), cy + S(6), Text.Span, UiTheme.TEXT);
            if (SmallButton(f, input, fx + S(172), cy, S(30), S(30), "›") && !locked) { StepDay(s, +1, year); SunSettingChanged(false); }
            if (SmallButton(f, input, fx + S(206), cy, S(30), S(30), "»") && !locked) { s.Month = s.Month % 12 + 1; SunSettingChanged(false); }
            cy += S(38);

            // From / to (15 min steps; Shift: 1 h)
            int stepMinutes = shift ? 60 : 15;
            cy = TimeRow(f, input, ix, cy, "From", s, true, stepMinutes, locked);
            cy = TimeRow(f, input, ix, cy, "To", s, false, stepMinutes, locked);

            _ui.Text(f.Body, ix, cy + S(7), "Sample every", UiTheme.TEXT_SOFT);
            int stepIndex = Math.Max(0, Array.IndexOf(SunHoursSettings.STEPS, s.StepMinutes));
            int newStep = Segmented(f, input, ix + S(110), cy, iw - S(110), STEP_OPTIONS, stepIndex);
            if (newStep != stepIndex && !locked) { s.StepMinutes = SunHoursSettings.STEPS[newStep]; SunSettingChanged(false); }
            cy += S(40);

            bool dst = Checkbox(f, input, ix, cy + S(4), iw, "Daylight saving (+1 h)", s.DaylightSaving);
            if (dst != s.DaylightSaving && !locked) { s.DaylightSaving = dst; SunSettingChanged(false); }
            cy += S(28);
            bool glass = Checkbox(f, input, ix, cy + S(4), iw, "Glass blocks sun (off: sun passes through)", s.GlassBlocks);
            if (glass != s.GlassBlocks && !locked) { s.GlassBlocks = glass; SunSettingChanged(false); }
            cy += S(34);

            // Grid and offsets (these rebuild the grid)
            _ui.Text(f.Body, ix, cy + S(7), "Grid", UiTheme.TEXT_SOFT);
            int gridIndex = Math.Max(0, Array.IndexOf(SunHoursSettings.GRID_SIZES, s.GridSize));
            int newGrid = Segmented(f, input, ix + S(110), cy, iw - S(110), GRID_OPTIONS, gridIndex);
            if (newGrid != gridIndex && !locked) { s.GridSize = SunHoursSettings.GRID_SIZES[newGrid]; SunSettingChanged(true); }
            cy += S(40);
            float floorOffset = OffsetRow(f, input, ix, cy, "Floor offset", s.FloorOffset, 2f);
            cy += S(38);
            float wallOffset = OffsetRow(f, input, ix, cy, "Wall offset", s.WallOffset, 1f);
            cy += S(38);
            if (!locked && (floorOffset != s.FloorOffset || wallOffset != s.WallOffset))
            {
                s.FloorOffset = floorOffset;
                s.WallOffset = wallOffset;
                SunSettingChanged(true);
            }

            // Surfaces
            cy += S(4);
            _ui.Rect(ix, cy, iw, S(1), UiTheme.PANEL_BORDER);
            cy += S(10);
            Text.Clear().AppendGrouped(_sunFaces.Count).Append(_sunFaces.Count == 1 ? " surface · " : " surfaces · ").AppendGrouped(_sunStudy.CellCount).Append(" cells");
            _ui.Text(f.Body, ix, cy, Text.Span, UiTheme.TEXT);
            cy += S(22);
            _ui.TextWrapped(f.Small, ix, cy, iw, "Click a wall or floor to add / remove it · RMB-drag to look", UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(22);
            if (SmallButton(f, input, ix, cy, S(170), S(30), "THIS ROOM") && !locked)
            {
                SelectRoomFaces(_roomIndex);
                if (_roomIndex >= 0) { _sunNotice = "Selected: " + RoomLabel(_roomIndex); }
            }
            if (SmallButton(f, input, ix + S(178), cy, S(170), S(30), "CLEAR SURFACES") && !locked)
            {
                _sunFaces.Clear();
                _sunGridDirty = true;
            }
            cy += S(42);

            // Run / progress
            if (_sunStudy.Running)
            {
                float fraction = _sunStudy.CellCount == 0 ? 1f : (float)_sunStudy.Done / _sunStudy.CellCount;
                _ui.Rect(ix, cy + S(8), iw - S(110), S(12), UiTheme.CONTROL);
                _ui.Rect(ix, cy + S(8), (iw - S(110)) * fraction, S(12), UiTheme.SUN);
                if (SmallButton(f, input, ix + iw - S(100), cy, S(100), S(30), "CANCEL"))
                {
                    _sunStudy.Cancel();
                    _sunNotice = "Cancelled: the cells done so far keep their colour";
                }
            }
            else if (MenuButton(f, ix, cy, iw, _sunStale ? "RUN (settings changed)" : "RUN", true, false, _sunStudy.CellCount > 0, S(40)))
            {
                RunSunStudy();
            }
            cy += S(50);

            // Results and exports
            if (_sunSummary != null) { cy += S(2) + _ui.TextWrapped(f.Small, ix, cy, iw, _sunSummary, UiTheme.TEXT, maxLines: 2) + S(6); }
            bool results = _sunStudy.Hours != null && _sunStudy.Done > 0 && !_sunStudy.Running;
            float third = (iw - S(16)) / 3f;
            if (SmallButton(f, input, ix, cy, third, S(30), "EXPORT CSV") && results) { ExportSunHours(); }
            if (SmallButton(f, input, ix + third + S(8), cy, third, S(30), "SCREENSHOT") && results) { _sunShotRequested = true; }
            if (SmallButton(f, input, ix + (third + S(8)) * 2, cy, third, S(30), "CLEAR") && _sunStudy.Hours != null) { ClearSunResults(); }
            cy += S(40);

            if (_sunNotice != null) { _ui.TextWrapped(f.Small, ix, cy, iw, _sunNotice, UiTheme.MEASURE_TEXT, maxLines: 2); }
            if (SmallButton(f, input, ix, y + h - S(44), iw, S(30), "CLOSE (J / ESC) · results stay")) { CloseSunHours(); }
        }

        /// <summary>A "From" / "To" row with − / + buttons.</summary>
        private float TimeRow(FontAtlas f, InputState input, float x, float y, string label, SunHoursSettings s, bool start, int step, bool locked)
        {
            _ui.Text(f.Body, x, y + S(7), label, UiTheme.TEXT_SOFT);
            float fx = x + S(110);
            int value = start ? s.StartMinutes : s.EndMinutes;
            int changed = value;
            if (SmallButton(f, input, fx, y, S(40), S(30), "−")) { changed = value - step; }
            Text.Clear().Append(value / 60).Append(':');
            if (value % 60 < 10) { Text.Append('0'); }
            Text.Append(value % 60);
            _ui.TextCentred(f.Bold, fx + S(44) + S(55), y + S(6), Text.Span, UiTheme.TEXT);
            if (SmallButton(f, input, fx + S(158), y, S(40), S(30), "+")) { changed = value + step; }
            if (changed != value && !locked)
            {
                if (start) { s.StartMinutes = Math.Clamp(changed, 0, s.EndMinutes - 5); }
                else { s.EndMinutes = Math.Clamp(changed, s.StartMinutes + 5, 24 * 60); }
                SunSettingChanged(false);
            }
            return y + S(38);
        }

        /// <summary>An offset row (0.05 m steps) with − / +.</summary>
        /// <returns>The value after this frame's clicks.</returns>
        private float OffsetRow(FontAtlas f, InputState input, float x, float y, string label, float value, float max)
        {
            _ui.Text(f.Body, x, y + S(7), label, UiTheme.TEXT_SOFT);
            float fx = x + S(110);
            float changed = value;
            if (SmallButton(f, input, fx, y, S(40), S(30), "−")) { changed = value - 0.05f; }
            Text.Clear().Append(value, 2).Append(" m");
            _ui.TextCentred(f.Bold, fx + S(44) + S(55), y + S(6), Text.Span, UiTheme.TEXT);
            if (SmallButton(f, input, fx + S(158), y, S(40), S(30), "+")) { changed = value + 0.05f; }
            return changed == value ? value : MathF.Round(Math.Clamp(changed, 0f, max) * 20f) / 20f;
        }

        /// <summary>
        /// A setting changed: grid settings rebuild the grid (results go); time settings only mark results stale.
        /// </summary>
        private void SunSettingChanged(bool rebuildGrid)
        {
            if (rebuildGrid) { _sunGridDirty = true; }
            else if (_sunStudy.Hours != null) { _sunStale = true; }
        }

        private static void StepDay(SunHoursSettings s, int delta, int year)
        {
            var date = new DateTime(year, s.Month, Math.Clamp(s.Day, 1, DateTime.DaysInMonth(year, s.Month))).AddDays(delta);
            s.Month = date.Month;
            s.Day = date.Day;
        }

        #endregion
    }
}
