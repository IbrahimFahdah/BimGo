using System.Numerics;
using BimGo.Audio;
using BimGo.Native;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Find room (pause menu → FIND ROOM, or Ctrl+F): every room of the snapshot (host and linked), searchable by
    /// number, name or level; GO teleports into the room, onto a clear spot of its floor near the middle, facing across it.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>One row of the list (labels made once per session).</summary>
        private sealed class RoomRow
        {
            public int Room;
            public string Title;
            public string Detail;
            public string Search;
            public float Elevation;
        }

        private const int ROOM_SEARCH_MAX = 40;

        private bool _roomsOpen;
        private readonly ScrollRegion _roomScroll = new();
        private readonly char[] _roomSearch = new char[ROOM_SEARCH_MAX];
        private int _roomSearchLength;
        private List<RoomRow> _roomRows;
        private readonly List<RoomRow> _roomMatches = new();
        private bool _roomMatchesDirty = true;

        #endregion

        #region Open / close

        /// <summary>True while the room list is showing (it replaces the pause menu).</summary>
        private bool IsRoomsPanelOpen => _roomsOpen;

        /// <summary>
        /// Opens the room list (pausing the walkthrough). Without rooms, says so.
        /// </summary>
        private void OpenRooms()
        {
            if (Scene.Rooms.Length == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("This model has no placed rooms to find", 3f);
                return;
            }
            if (!_paused) { SetPaused(true); }
            _roomsOpen = true;
            _roomScroll.Reset();
            _roomMatchesDirty = true;
        }

        /// <summary>
        /// Closes the room list.
        /// </summary>
        /// <returns>True if it was open.</returns>
        private bool CloseRooms()
        {
            if (!_roomsOpen) { return false; }
            _roomsOpen = false;
            return true;
        }

        #endregion

        #region Teleport

        /// <summary>
        /// Stands the player in a room: the clear floor spot nearest the middle of the room (at least 0.45 m from its
        /// walls), on the floor under it, facing the room's far side.
        /// </summary>
        /// <returns>False when no clear spot was found (the player stays put).</returns>
        public bool TeleportToRoom(int index)
        {
            if (index < 0 || index >= Scene.Rooms.Length || _player == null) { return false; }
            RoomInfo room = Scene.Rooms[index];
            Vector2 centre = (room.Min + room.Max) * 0.5f;

            // Candidate spots on a 0.4 m grid inside the room, nearest the middle first
            var spots = new List<Vector2>();
            for (float y = room.Min.Y + 0.2f; y <= room.Max.Y; y += 0.4f)
            {
                for (float x = room.Min.X + 0.2f; x <= room.Max.X; x += 0.4f)
                {
                    var p = new Vector2(x, y);
                    if (room.Contains(p) && room.DistanceToBoundary(p) >= 0.45f) { spots.Add(p); }
                }
            }
            if (spots.Count == 0)
            {
                // A tiny or thin room: any point inside will do
                for (float y = room.Min.Y + 0.05f; y <= room.Max.Y && spots.Count == 0; y += 0.1f)
                {
                    for (float x = room.Min.X + 0.05f; x <= room.Max.X; x += 0.1f)
                    {
                        if (room.Contains(new Vector2(x, y))) { spots.Add(new Vector2(x, y)); break; }
                    }
                }
            }
            spots.Sort((a, b) => Vector2.DistanceSquared(a, centre).CompareTo(Vector2.DistanceSquared(b, centre)));

            foreach (Vector2 spot in spots.Take(400))
            {
                Vector3 feet = FloorAt(spot, room.BottomZ);
                if (feet.Z > room.TopZ - 1f) { continue; }
                if (_player.Controller.Overlaps(feet + new Vector3(0f, 0f, 0.01f), CharacterController.STAND_HEIGHT)) { continue; }

                // Face the far side of the room (along its longer side when standing at the middle)
                Vector2 look = centre - spot;
                if (look.LengthSquared() < 0.25f)
                {
                    Vector2 size = room.Max - room.Min;
                    look = size.X >= size.Y ? new Vector2(1f, 0f) : new Vector2(0f, 1f);
                }
                if (_player.Flying) { _player.ToggleFly(); }
                _player.TeleportTo(feet, MathF.Atan2(look.Y, look.X), 0f);
                return true;
            }
            return false;
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the room list (in place of the pause menu). Typing goes into the search box.
        /// </summary>
        private void BuildRoomsPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            Text.Clear().AppendGrouped(Scene.Rooms.Length).Append(" rooms · type a number, name or level");
            PanelFrame frame = BeginPanel(PanelSize.Standard, "FIND ROOM", UiTheme.ACCENT, Text.Span);
            float ix = frame.Ix, iw = frame.Iw;
            float cy = frame.BodyTop;

            // Search box (typing anywhere in the panel goes here; Enter goes to the first match)
            bool enter = TypeIntoRoomSearch(input);
            float boxH = S(UiTheme.CONTROL_HEIGHT + 4f);
            _ui.Panel(ix, cy, iw, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
            if (_roomSearchLength == 0)
            {
                _ui.Text(f.Body, ix + S(10), cy + boxH * 0.5f - f.Body.LineHeight * 0.5f, "e.g. 2.05, kitchen, Level 2", UiTheme.TEXT_FAINT);
            }
            else
            {
                float used = _ui.Text(f.Body, ix + S(10), cy + boxH * 0.5f - f.Body.LineHeight * 0.5f, _roomSearch.AsSpan(0, _roomSearchLength), UiTheme.TEXT);
                if (((int)(_clock * 2f) & 1) == 0) { _ui.Rect(ix + S(11) + used, cy + S(8), S(2), boxH - S(16), UiTheme.TEXT_SOFT); }
            }
            cy += boxH + S(UiTheme.GAP);

            RefreshRoomMatches();
            RoomRow go = BuildRoomRows(f, input, ix, cy, iw, frame.BodyBottom);
            if (enter && _roomMatches.Count > 0) { go = _roomMatches[0]; }

            if (EndPanel(frame, null, "Click a room (or Enter for the first) to go there · Esc back") == FOOTER_LEFT) { return; }

            if (go == null) { return; }
            CloseRooms();
            SetPaused(false);
            if (TeleportToRoom(go.Room))
            {
                Sound.Play(SoundId.Teleport);
                Toast($"{go.Title} · {go.Detail}", 2.6f);
            }
            else
            {
                Sound.Play(SoundId.Error);
                Toast($"No clear spot to stand in {go.Title}", 3f, important: true);
            }
        }

        /// <summary>
        /// The matching rooms (a scroll region); a click on a row picks it.
        /// </summary>
        /// <returns>The room clicked this frame, or null.</returns>
        private RoomRow BuildRoomRows(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            if (_roomMatches.Count == 0)
            {
                _ui.Text(f.Body, x, y + S(6), "No room matches. Backspace to change the search.", UiTheme.TEXT_MUTED);
                return null;
            }

            float rowH = S(UiTheme.ROW_HEIGHT);
            float top = BeginScroll(_roomScroll, input, x, y, w, bottom - y, out float cw);
            VisibleRows(_roomScroll, rowH, _roomMatches.Count, out int first, out int last);
            RoomRow picked = null;
            for (int i = first; i < last; i++)
            {
                RoomRow row = _roomMatches[i];
                float ry = top + i * rowH;
                bool hover = Hover(input, x, ry, cw, rowH - S(4));
                bool current = row.Room == _roomIndex;
                _ui.Rect(x, ry, cw, rowH - S(4), hover ? UiTheme.HOVER : ((i & 1) == 0 ? UiTheme.ROW_STRIPE : 0u));
                _ui.TextWrapped(f.Bold, x + S(12), ry + S(10), cw * 0.55f, row.Title, current ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                _ui.TextRight(f.Body, x + cw - S(12), ry + S(11), row.Detail, UiTheme.TEXT_MUTED);
                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    picked = row;
                }
            }
            EndScroll(_roomScroll, input, top + _roomMatches.Count * rowH);
            return picked;
        }

        /// <summary>
        /// Typed characters go into the search (Backspace deletes, Ctrl+Backspace clears).
        /// </summary>
        /// <returns>True when Enter was pressed.</returns>
        private bool TypeIntoRoomSearch(InputState input)
        {
            bool enter = false;
            foreach (char c in input.Chars)
            {
                if (c == '\r') { enter = true; }
                else if (c == '\b')
                {
                    if (input.IsDown(Win32.VK_CONTROL)) { _roomSearchLength = 0; }
                    else if (_roomSearchLength > 0) { _roomSearchLength--; }
                    _roomMatchesDirty = true;
                }
                else if (c >= ' ' && c != 127 && _roomSearchLength < ROOM_SEARCH_MAX)
                {
                    _roomSearch[_roomSearchLength++] = c;
                    _roomMatchesDirty = true;
                }
            }
            if (_roomMatchesDirty) { _roomScroll.Reset(); }
            return enter;
        }

        /// <summary>
        /// The rows (built once), then the matches for the current search (every word in the number, name or level).
        /// </summary>
        private void RefreshRoomMatches()
        {
            _roomRows ??= BuildRoomRowList();
            if (!_roomMatchesDirty) { return; }
            _roomMatchesDirty = false;

            string[] words = new string(_roomSearch, 0, _roomSearchLength).Split(' ', StringSplitOptions.RemoveEmptyEntries);
            _roomMatches.Clear();
            foreach (RoomRow row in _roomRows)
            {
                bool all = true;
                foreach (string word in words)
                {
                    if (!row.Search.Contains(word, StringComparison.CurrentCultureIgnoreCase)) { all = false; break; }
                }
                if (all) { _roomMatches.Add(row); }
            }

            // An exact number match goes first (typing "2.05" then Enter goes to 2.05, not 12.05)
            if (words.Length == 1)
            {
                int exact = _roomMatches.FindIndex(r => string.Equals(Scene.Rooms[r.Room].Number, words[0], StringComparison.CurrentCultureIgnoreCase));
                if (exact > 0)
                {
                    RoomRow row = _roomMatches[exact];
                    _roomMatches.RemoveAt(exact);
                    _roomMatches.Insert(0, row);
                }
            }
        }

        /// <summary>
        /// One row per room: "2.05 · Kitchen", "Level 2 · 14.2 m²" (+ the link's name for linked rooms), sorted by level
        /// then number.
        /// </summary>
        private List<RoomRow> BuildRoomRowList()
        {
            var rows = new List<RoomRow>(Scene.Rooms.Length);
            for (int i = 0; i < Scene.Rooms.Length; i++)
            {
                RoomInfo room = Scene.Rooms[i];
                string level = LevelNameAt(room.BottomZ);
                string link = room.Link > 0 && room.Link <= Scene.Links.Length ? " · " + Scene.Links[room.Link - 1].Name : string.Empty;
                string title = string.IsNullOrWhiteSpace(room.Number) || room.Number == "—" ? room.Name : $"{room.Number} · {room.Name}";
                rows.Add(new RoomRow
                {
                    Room = i,
                    Title = title,
                    Detail = $"{level} · {UnitFormat.Area(PlanArea(room))}{link}",
                    Search = $"{room.Number} {room.Name} {level}{link}",
                    Elevation = room.BottomZ
                });
            }
            rows.Sort((a, b) =>
            {
                int byLevel = a.Elevation.CompareTo(b.Elevation);
                return byLevel != 0 ? byLevel : string.Compare(a.Title, b.Title, StringComparison.CurrentCultureIgnoreCase);
            });
            return rows;
        }

        /// <summary>
        /// The room's plan area (outer loop minus holes: the absolute sum of the loops' signed areas, largest positive).
        /// </summary>
        private static float PlanArea(RoomInfo room)
        {
            if (room.Loops == null || room.Loops.Length == 0) { return 0f; }
            float outer = 0f, holes = 0f;
            foreach (Vector2[] loop in room.Loops)
            {
                if (loop == null || loop.Length < 3) { continue; }
                float area = 0f;
                for (int i = 0, j = loop.Length - 1; i < loop.Length; j = i++) { area += loop[j].X * loop[i].Y - loop[i].X * loop[j].Y; }
                area = MathF.Abs(area) * 0.5f;
                if (area > outer) { holes += outer; outer = area; }
                else { holes += area; }
            }
            return MathF.Max(0f, outer - holes);
        }

        #endregion
    }
}
