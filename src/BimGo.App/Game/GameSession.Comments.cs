using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The comment list (pause menu → COMMENTS): every comment with its author, date and level, filtered by level,
    /// with Go to (teleport in front of the marker), Edit, Delete and a CSV export.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private bool _commentsOpen;
        private int _commentLevelFilter = -1;
        private int _commentScroll;
        private CommentRecord _commentDeleteArmed;
        private float _commentDeleteArmedUntil;
        private string _commentsNotice;

        // Cached labels (rebuilt when the filter or the count changes)
        private string _commentFilterLabel;
        private int _commentFilterLabelFor = int.MinValue;

        #endregion

        #region Open / close

        /// <summary>True while the comment list is showing (it replaces the pause menu).</summary>
        private bool IsCommentsPanelOpen => _commentsOpen;

        /// <summary>
        /// Opens the list, filtered to the player's level when it has comments there.
        /// </summary>
        private void OpenComments()
        {
            _commentsOpen = true;
            _commentScroll = 0;
            _commentDeleteArmed = null;
            _commentsNotice = null;

            int level = Scene.Levels.Length > 0 ? LevelIndexAt(_player.Feet.Z) : -1;
            _commentLevelFilter = level >= 0 && CountCommentsOn(level) > 0 ? level : -1;
        }

        /// <summary>
        /// Closes the list.
        /// </summary>
        /// <returns>True if it was open.</returns>
        private bool CloseComments()
        {
            if (!_commentsOpen) { return false; }
            _commentsOpen = false;
            _commentDeleteArmed = null;
            return true;
        }

        #endregion

        #region Actions

        /// <summary>
        /// Stands the player 1.6 m in front of a comment marker, on its level, looking at it.
        /// </summary>
        public void TeleportToComment(CommentRecord record)
        {
            if (record == null || _player == null) { return; }
            Vector3 marker = record.Local;

            // Approach from the player's side (so we don't end up on the far side of a wall)
            var toMarker = new Vector2(marker.X - _player.Feet.X, marker.Y - _player.Feet.Y);
            Vector2 direction = toMarker.LengthSquared() > 0.01f ? Vector2.Normalize(toMarker) : new Vector2(1f, 0f);
            Vector2 standXY = new Vector2(marker.X, marker.Y) - direction * 1.6f;

            float floorZ = Scene.Levels.Length > 0 ? Scene.Levels[LevelIndexAt(marker.Z)].Elevation : marker.Z - 1.2f;
            Vector3 feet = FloorAt(standXY, floorZ);

            // Blocked (inside a wall or furniture)? Stand under the marker instead
            if (_player.Controller.Overlaps(feet + new Vector3(0f, 0f, 0.01f), CharacterController.STAND_HEIGHT))
            {
                feet = FloorAt(new Vector2(marker.X, marker.Y), floorZ);
            }

            Vector3 eye = feet + new Vector3(0f, 0f, CharacterController.STAND_EYE);
            Vector3 look = marker - eye;
            float yaw = MathF.Atan2(look.Y, look.X);
            float pitch = MathF.Atan2(look.Z, MathF.Max(0.01f, new Vector2(look.X, look.Y).Length()));
            if (_player.Flying) { _player.ToggleFly(); }
            _player.TeleportTo(feet, yaw, Math.Clamp(pitch, -1.2f, 1.2f));
        }

        /// <summary>
        /// The floor under a plan point near an elevation (picked from 1.7 m above), else the elevation itself.
        /// </summary>
        private Vector3 FloorAt(Vector2 xy, float floorZ)
        {
            var feet = new Vector3(xy.X, xy.Y, floorZ + 0.02f);
            if (Pick(new Vector3(xy.X, xy.Y, floorZ + 1.7f), -Vector3.UnitZ, 2.4f, out RayHit hit) && hit.Normal.Z > 0.7f)
            {
                feet.Z = hit.Point.Z + 0.02f;
            }
            return feet;
        }

        /// <summary>
        /// Saves every comment to a CSV file.
        /// </summary>
        private void ExportComments()
        {
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = Path.GetFileNameWithoutExtension(DocumentName) + " comments.csv";
            string path = FileDialogs.ShowSave(_window.Handle, "Export comments", "CSV file (*.csv)|*.csv|All files (*.*)|*.*", SuggestedFolder(), name, ".csv");
            if (path == null) { return; }

            string error = Comments.ExportCsv(path);
            _commentsNotice = error == null ? $"Exported {Comments.Comments.Count} comments to {Path.GetFileName(path)}" : $"Export failed: {error}";
            Sound.Play(error == null ? SoundId.Commit : SoundId.Error);
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the comment list (in place of the pause menu).
        /// </summary>
        private void BuildCommentsPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float w = MathF.Min(S(920), width - S(80));
            float h = height - S(96);
            float x = (width - w) * 0.5f, y = S(48);
            _ui.Panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);

            float ix = x + S(24), iw = w - S(48);
            float cy = y + S(20);
            _ui.Text(f.Small, ix, cy, "COMMENTS", UiTheme.COMMENT_LABEL, S(2f));
            Text.Clear().AppendGrouped(Comments.Comments.Count).Append(Comments.Comments.Count == 1 ? " comment · saved to " : " comments · saved to ").Append(Comments.FileName);
            _ui.TextRight(f.Small, ix + iw, cy, Text.Span, UiTheme.TEXT_MUTED, S(0.6f));
            cy += S(30);

            // Level filter: ‹ All levels / Level name ›
            if (Scene.Levels.Length > 0)
            {
                if (SmallButton(f, input, ix, cy, S(32), S(28), "←")) { StepCommentFilter(-1); }
                _ui.Panel(ix + S(38), cy, S(260), S(28), UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
                _ui.TextCentred(f.Body, ix + S(38) + S(130), cy + S(14) - f.Body.LineHeight * 0.5f, CommentFilterLabel(), UiTheme.TEXT);
                if (SmallButton(f, input, ix + S(304), cy, S(32), S(28), "→")) { StepCommentFilter(+1); }
                cy += S(40);
            }

            float buttonsY = y + h - S(24) - S(48);
            BuildCommentRows(f, input, ix, cy, iw, buttonsY - S(16));

            if (_commentsNotice != null) { _ui.TextWrapped(f.Body, ix, buttonsY - S(30), iw, _commentsNotice, UiTheme.MEASURE_TEXT, maxLines: 1); }
            if (MenuButton(f, ix, buttonsY, S(200), "EXPORT CSV…", false, false, enabled: Comments.Comments.Count > 0)) { ExportComments(); }
            if (MenuButton(f, ix + S(216), buttonsY, S(160), "CLOSE", false, false)) { CloseComments(); }
        }

        /// <summary>
        /// The scrolling rows: header, text and Go / Edit / Delete.
        /// </summary>
        private void BuildCommentRows(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            float rowH = S(64);
            int visible = Math.Max(1, (int)((bottom - y) / rowH));

            // Count the filtered rows (no list is built: the filter is applied while drawing)
            int total = 0;
            foreach (CommentRecord record in Comments.Comments)
            {
                if (MatchesCommentFilter(record)) { total++; }
            }

            if (total == 0)
            {
                _ui.TextWrapped(f.Body, x, y + S(8), w, Comments.Comments.Count == 0
                    ? "No comments yet. Use the Comment gun (4): LMB places a marker and opens a text box."
                    : "No comments on this level. Use ← → to pick another level or all levels.", UiTheme.TEXT_MUTED, maxLines: 2);
                return;
            }

            int maxScroll = Math.Max(0, total - visible);
            if (input.Wheel != 0) { _commentScroll -= input.Wheel * 2; }
            _commentScroll = Math.Clamp(_commentScroll, 0, maxScroll);
            if (_commentDeleteArmed != null && _clock > _commentDeleteArmedUntil) { _commentDeleteArmed = null; }

            CommentRecord go = null, edit = null, delete = null;
            int index = -1, drawn = 0;
            float buttonsW = S(66) * 3 + S(12);
            foreach (CommentRecord record in Comments.Comments)
            {
                if (!MatchesCommentFilter(record)) { continue; }
                index++;
                if (index < _commentScroll) { continue; }
                if (drawn >= visible) { break; }

                float ry = y + drawn * rowH;
                drawn++;
                if ((drawn & 1) == 1) { _ui.Rect(x - S(8), ry - S(4), w + S(16), rowH - S(4), Rgba.Hex(0xFFFFFF, 0.03f)); }

                float textW = w - buttonsW - S(16);
                Text.Clear().Append(record.Header);
                if (!string.IsNullOrEmpty(record.Level)) { Text.Append(" · ").Append(record.Level); }
                _ui.TextWrapped(f.Small, x, ry + S(2), textW, Text.Span, UiTheme.COMMENT_LABEL, maxLines: 1);
                _ui.TextWrapped(f.Body, x, ry + S(20), textW, record.Text, UiTheme.TEXT, maxLines: 2);

                float bx = x + w - buttonsW;
                if (SmallButton(f, input, bx, ry + S(8), S(66), S(30), "GO")) { go = record; }
                if (SmallButton(f, input, bx + S(72), ry + S(8), S(66), S(30), "EDIT")) { edit = record; }
                bool armed = ReferenceEquals(_commentDeleteArmed, record);
                if (SmallButton(f, input, bx + S(144), ry + S(8), S(66), S(30), armed ? "SURE?" : "DELETE", danger: true)) { delete = record; }
            }

            if (maxScroll > 0)
            {
                Text.Clear().Append(_commentScroll + 1).Append('–').Append(Math.Min(total, _commentScroll + visible)).Append(" of ").Append(total).Append(" · wheel to scroll");
                _ui.TextRight(f.Small, x + w, bottom + S(2), Text.Span, UiTheme.TEXT_FAINT);
            }

            // Act after drawing (the list must not change while it is being walked)
            if (go != null)
            {
                CloseComments();
                SetPaused(false);
                TeleportToComment(go);
                SelectGun(Array.IndexOf(_guns, _commentGun));
                Toast(go.Text.Length > 60 ? go.Text[..57] + "…" : go.Text, 3f);
            }
            else if (edit != null)
            {
                CloseComments();
                SetPaused(false);
                TeleportToComment(edit);
                BeginCommentEdit(edit);
            }
            else if (delete != null)
            {
                if (ReferenceEquals(_commentDeleteArmed, delete))
                {
                    Comments.Remove(delete);
                    _commentDeleteArmed = null;
                    _commentsNotice = Comments.LastError ?? "Comment deleted";
                    Sound.Play(SoundId.Remove);
                }
                else
                {
                    _commentDeleteArmed = delete;
                    _commentDeleteArmedUntil = _clock + 3f;
                }
            }
        }

        /// <summary>
        /// A compact button (list rows, filter arrows).
        /// </summary>
        private bool SmallButton(FontAtlas f, InputState input, float x, float y, float w, float h, string label, bool danger = false)
        {
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), danger ? Rgba.Hex(0xFCA5A5, 0.45f) : UiTheme.CONTROL_BORDER);
            _ui.TextCentred(f.Small, x + w * 0.5f, y + h * 0.5f - f.Small.LineHeight * 0.5f, label, danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, S(0.8f));

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        #endregion

        #region Filter

        /// <summary>
        /// Cycles the level filter: all levels, then each level in order.
        /// </summary>
        private void StepCommentFilter(int direction)
        {
            int count = Scene.Levels.Length + 1; // + "all"
            int current = _commentLevelFilter + 1;
            _commentLevelFilter = ((current + direction) % count + count) % count - 1;
            _commentScroll = 0;
            _commentDeleteArmed = null;
        }

        private bool MatchesCommentFilter(CommentRecord record)
        {
            if (_commentLevelFilter < 0 || _commentLevelFilter >= Scene.Levels.Length) { return true; }
            return string.Equals(record.Level, Scene.Levels[_commentLevelFilter].Name, StringComparison.Ordinal);
        }

        private int CountCommentsOn(int level)
        {
            int count = 0;
            string name = Scene.Levels[level].Name;
            foreach (CommentRecord record in Comments.Comments)
            {
                if (string.Equals(record.Level, name, StringComparison.Ordinal)) { count++; }
            }
            return count;
        }

        /// <summary>
        /// "All levels (12)" or "Level 1 (3)", rebuilt only when the filter or the count changes.
        /// </summary>
        private string CommentFilterLabel()
        {
            int key = (_commentLevelFilter + 1) * 100_000 + Comments.Comments.Count;
            if (key == _commentFilterLabelFor && _commentFilterLabel != null) { return _commentFilterLabel; }
            _commentFilterLabelFor = key;
            _commentFilterLabel = _commentLevelFilter < 0
                ? $"All levels ({Comments.Comments.Count})"
                : $"{Scene.Levels[_commentLevelFilter].Name} ({CountCommentsOn(_commentLevelFilter)})";
            return _commentFilterLabel;
        }

        #endregion
    }
}
