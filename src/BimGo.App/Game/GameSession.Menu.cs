using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Game.Guns;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The Esc pause menu (immediate-mode widgets) and the in-game text box (comments and bookmark names).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private int _activeSlider = -1;

        // SHOW ALL button label, rebuilt only when the count changes
        private string _showAllLabel;
        private int _showAllCount = -1;

        private bool _editing;
        private Vector3 _editPoint;
        private long _editElement;
        private string _editLevel;
        private readonly char[] _editChars = new char[280];
        private int _editLength;
        private int _editMax = 280;
        private CommentRecord _editRecord;
        private BookmarkRecord _editBookmark;
        private bool _editBookmarkIsNew;

        // Comment issue text boxes (opened from the comment panel): a reply, or the assignee
        private CommentRecord _editReplyFor, _editAssigneeFor;

        // Any other text (Round C-B: clash test / set names, rule values, clash assignee and notes): what Enter does.
        // Cleared whenever the box closes, so the other text boxes never see it.
        private Action<string> _editCustom;
        private string _editCustomTitle;

        /// <summary>Longest assignee name.</summary>
        private const int MAX_ASSIGNEE = 60;

        private static readonly string[] COLOUR_OPTIONS = { "Whitecard", "Material", "Realistic" };
        private static readonly string[] MSAA_OPTIONS = { "Off", "2x", "4x" };

        /// <summary>Reflections: off, some (shine tiers 50 % +), or all (25 % +).</summary>
        private static readonly string[] REFLECTION_OPTIONS = { "Off", "Some", "All" };

        /// <summary>Debug colours: off, reflection tiers, reflection probe cells.</summary>
        private static readonly string[] DEBUG_OPTIONS = { "Off", "Reflection", "Probes" };

        /// <summary>The pickable quality profiles (Custom is shown as no selection).</summary>
        private static readonly string[] PROFILE_OPTIONS = { "Basic", "Medium", "Realistic" };

        /// <summary>Display units (review tools round).</summary>
        private static readonly string[] UNIT_OPTIONS = { "Metric", "Imperial" };

        /// <summary>The pause menu's settings tabs.</summary>
        private static readonly string[] RIGHT_TABS = { "DISPLAY", "REFLECTIONS", "DEBUG" };

        /// <summary>Height of the right column's card (unscaled): fits the Display tab, the tallest.</summary>
        private const float RIGHT_CARD_HEIGHT = 440f;

        // Open right-column tab: 0 display, 1 reflections, 2 debug (per session)
        private int _rightTab;

        /// <summary>Slider id of the reflection strength (unique across the menu's sliders).</summary>
        private const int SLIDER_REFLECT = 17;

        #endregion

        #region Comment editor

        /// <summary>True while the text box (comment or bookmark name) is open: it takes all keys.</summary>
        public bool IsEditingComment => _editing;

        /// <summary>Where the comment being typed will go.</summary>
        public Vector3 EditPoint => _editPoint;

        /// <summary>
        /// Opens the comment text box for a new marker.
        /// </summary>
        public void BeginCommentEdit(Vector3 point, long elementId, string level)
        {
            _editing = true;
            _editSunStudy = false;
            _editRecord = null;
            _editBookmark = null;
            _editReplyFor = _editAssigneeFor = null;
            _editMax = _editChars.Length;
            _editPoint = point;
            _editElement = elementId;
            _editLevel = level;
            _editLength = 0;
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the comment text box on an existing comment (its text ready to change).
        /// </summary>
        public void BeginCommentEdit(CommentRecord record)
        {
            if (record == null) { return; }
            _editing = true;
            _editSunStudy = false;
            _editRecord = record;
            _editBookmark = null;
            _editReplyFor = _editAssigneeFor = null;
            _editMax = _editChars.Length;
            _editPoint = record.Local;
            _editElement = record.ElementId;
            _editLevel = string.IsNullOrEmpty(record.Level) ? null : record.Level;
            _editLength = Math.Min(record.Text?.Length ?? 0, _editChars.Length);
            record.Text?.CopyTo(0, _editChars, 0, _editLength);
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the text box on a bookmark's name (selected text replaced by typing is not supported: the name is
        /// ready to extend or Backspace over).
        /// </summary>
        /// <param name="record">The bookmark.</param>
        /// <param name="isNew">True right after B: the bookmark is pending (Enter adds it, Esc throws it away).</param>
        private void BeginBookmarkRename(BookmarkRecord record, bool isNew)
        {
            if (record == null) { return; }
            _editing = true;
            _editSunStudy = false;
            _editRecord = null;
            _editBookmark = record;
            _editReplyFor = _editAssigneeFor = null;
            _editBookmarkIsNew = isNew;
            _editMax = BookmarkStore.MAX_NAME;
            _editLevel = string.IsNullOrEmpty(record.Level) ? null : record.Level;
            _editLength = Math.Min(record.Name?.Length ?? 0, _editMax);
            record.Name?.CopyTo(0, _editChars, 0, _editLength);
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the text box for a reply to a comment (from the comment panel; the menu stays open behind it).
        /// </summary>
        private void BeginCommentReply(CommentRecord record)
        {
            if (record == null) { return; }
            _editing = true;
            _editSunStudy = false;
            _editRecord = null;
            _editBookmark = null;
            _editAssigneeFor = null;
            _editReplyFor = record;
            _editMax = _editChars.Length;
            _editLevel = string.IsNullOrEmpty(record.Level) ? null : record.Level;
            _editLength = 0;
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the text box on a comment's assignee (ready to change; empty + Enter clears it).
        /// </summary>
        private void BeginCommentAssign(CommentRecord record)
        {
            if (record == null) { return; }
            _editing = true;
            _editSunStudy = false;
            _editRecord = null;
            _editBookmark = null;
            _editReplyFor = null;
            _editAssigneeFor = record;
            _editMax = MAX_ASSIGNEE;
            _editLevel = string.IsNullOrEmpty(record.Level) ? null : record.Level;
            _editLength = Math.Min(record.AssignedTo?.Length ?? 0, _editMax);
            record.AssignedTo?.CopyTo(0, _editChars, 0, _editLength);
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the text box for any short text (Round C-B): <paramref name="commit"/> gets the trimmed text on Enter;
        /// Esc leaves everything as it was.
        /// </summary>
        /// <param name="title">The box's heading ("TEST NAME").</param>
        /// <param name="initial">The text to start from.</param>
        /// <param name="max">Longest text.</param>
        /// <param name="commit">What Enter does with the text.</param>
        /// <param name="level">The second part of the heading (default: an em dash).</param>
        private void BeginTextEdit(string title, string initial, int max, Action<string> commit, string level = null)
        {
            _editing = true;
            _editSunStudy = false;
            _editRecord = null;
            _editBookmark = null;
            _editReplyFor = _editAssigneeFor = null;
            _editCustom = commit;
            _editCustomTitle = title;
            _editMax = Math.Clamp(max, 1, _editChars.Length);
            _editLevel = level;
            _editLength = Math.Min(initial?.Length ?? 0, _editMax);
            initial?.CopyTo(0, _editChars, 0, _editLength);
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Consumes typed characters: Enter saves, Esc cancels, Backspace deletes.
        /// </summary>
        private void UpdateCommentEditor(InputState input)
        {
            foreach (char c in input.Chars)
            {
                switch (c)
                {
                    case '\b':
                        if (_editLength > 0) { _editLength--; }
                        break;

                    case '\r':
                        CommitComment();
                        return;

                    case (char)27:
                        _editing = false;
                        if (_editCustom != null)
                        {
                            _editCustom = null;
                            Toast("Not changed");
                            return;
                        }
                        if (_editBookmark != null)
                        {
                            if (_editBookmarkIsNew && _thumbnailFor == _editBookmark) { _thumbnailFor = null; }
                            Toast(_editBookmarkIsNew ? "Bookmark cancelled (nothing was saved)" : "Name not changed");
                        }
                        else if (_editSunStudy)
                        {
                            Toast("Study not saved");
                        }
                        else if (_editReplyFor != null || _editAssigneeFor != null)
                        {
                            Toast(_editReplyFor != null ? "Reply cancelled" : "Assignee not changed");
                        }
                        else
                        {
                            Toast(_editRecord != null ? "Edit cancelled" : "Comment cancelled");
                        }
                        _editRecord = null;
                        _editBookmark = null;
                        _editReplyFor = _editAssigneeFor = null;
                        _editSunStudy = false;
                        return;

                    default:
                        if (c >= ' ' && _editLength < _editMax) { _editChars[_editLength++] = c; }
                        break;
                }
            }
        }

        private void CommitComment()
        {
            _editing = false;
            string text = new string(_editChars, 0, _editLength).Trim();
            if (_editCustom != null)
            {
                Action<string> commit = _editCustom;
                _editCustom = null;
                commit(text);
                return;
            }
            CommentRecord editing = _editRecord;
            BookmarkRecord bookmark = _editBookmark;
            CommentRecord replyTo = _editReplyFor, assignFor = _editAssigneeFor;
            bool sunStudy = _editSunStudy;
            _editRecord = null;
            _editBookmark = null;
            _editReplyFor = _editAssigneeFor = null;
            _editSunStudy = false;

            if (sunStudy)
            {
                SaveSunStudy(text);
                return;
            }

            if (replyTo != null)
            {
                if (text.Length == 0) { Toast("Empty reply not saved"); return; }
                Comments.AddReply(replyTo, text);
                Sound.Play(SoundId.CommentPlace);
                _commentsNotice = Comments.LastError ?? $"Reply added ({replyTo.ReplyCount} in the thread)";
                return;
            }
            if (assignFor != null)
            {
                Comments.SetIssue(assignFor, assignedTo: text);
                Sound.Play(SoundId.UiClick);
                _commentsNotice = Comments.LastError ?? (text.Length == 0 ? "Unassigned" : $"Assigned to {text}");
                return;
            }

            if (bookmark != null)
            {
                // A new bookmark joins the list only now (Esc discarded it); an existing one is renamed
                if (_editBookmarkIsNew) { Bookmarks.AddPending(bookmark, text); }
                else if (text.Length > 0) { Bookmarks.Rename(bookmark, text); }
                Sound.Play(SoundId.Commit);
                string verb = _editBookmarkIsNew ? "Bookmarked" : "Renamed to";
                Toast(Bookmarks.LastError ?? $"{verb} “{bookmark.Name}” ({BookmarkHotkey(bookmark)})", important: Bookmarks.LastError != null);
                return;
            }

            if (editing != null)
            {
                if (text.Length == 0)
                {
                    Toast("The text is empty, so the comment was not changed (RMB on the marker deletes it)");
                    return;
                }
                Comments.Update(editing, text);
                Sound.Play(SoundId.CommentPlace);
                Toast(Comments.LastError ?? "Comment updated", important: Comments.LastError != null);
                return;
            }

            if (text.Length == 0)
            {
                Toast("Empty comment not saved");
                return;
            }

            // The new comment remembers where it was made from, and a picture of that view (taken next frame: the
            // capture reads the 3D view before the UI is drawn, so the text box isn't in it)
            string uniqueId = _editElement > 0 && _elementIndexById.TryGetValue(_editElement, out int elementIndex) ? Scene.Elements[elementIndex].UniqueId : null;
            CommentRecord added = Comments.Add(_editPoint, text, _editElement, _editLevel, uniqueId);
            Comments.SetView(added, _player.Feet, _player.Yaw, _player.Pitch, _player.Flying, section: _section);
            _commentThumbnailFor = added;
            _markupAfterCapture = added; // the markup editor opens once the picture is taken
            Sound.Play(SoundId.CommentPlace);
            Toast(Comments.LastError ?? $"Comment saved to {Comments.FileName}", important: Comments.LastError != null);
        }

        /// <summary>
        /// Draws the comment text box.
        /// </summary>
        private void BuildCommentEditor()
        {
            FontAtlas f = _ui.Atlas;
            float w = S(460);
            float textHeight = MathF.Max(f.Body.LineHeight * 1.15f, _ui.TextWrapped(f.Body, 0, 0, w - S(48), _editChars.AsSpan(0, _editLength), 0, maxLines: 10, draw: false));
            float h = S(96) + textHeight;
            float x = _window.Width * 0.5f - w * 0.5f, y = _window.Height * 0.5f + S(48);

            bool naming = _editBookmark != null || _editCustom != null;
            uint frame = _editSunStudy ? UiTheme.SUN : naming ? UiTheme.BOOKMARK : UiTheme.COMMENT;
            uint label = _editSunStudy ? UiTheme.SUN_LABEL : naming ? UiTheme.BOOKMARK_LABEL : UiTheme.COMMENT_LABEL;
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, frame);
            Text.Clear().Append(_editCustom != null ? _editCustomTitle + " · "
                : _editSunStudy ? "SUN STUDY NAME (same name replaces) · "
                : naming ? "BOOKMARK NAME · "
                : _editReplyFor != null ? "REPLY · "
                : _editAssigneeFor != null ? "ASSIGN TO (empty = unassigned) · "
                : _editRecord != null ? "EDIT COMMENT · " : "NEW COMMENT · ").Append(_editLevel ?? "—");
            _ui.Text(f.Small, x + S(14), y + S(12), Text.Span, label, S(1f));

            float boxY = y + S(32);
            float boxH = textHeight + S(16);
            _ui.Panel(x + S(14), boxY, w - S(28), boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
            _ui.TextWrapped(f.Body, x + S(24), boxY + S(8), w - S(48), _editChars.AsSpan(0, _editLength), UiTheme.TEXT, maxLines: 10);

            // Caret at the end of the last line (blinking)
            if ((_clock % 1f) < 0.55f)
            {
                CaretPosition(f.Body, w - S(48), out float caretX, out float caretLine);
                float lineHeight = f.Body.LineHeight * 1.15f;
                _ui.Rect(x + S(24) + caretX + S(1), boxY + S(8) + caretLine * lineHeight + S(2), S(1.5f), f.Body.LineHeight - S(2), label);
            }

            _ui.Text(f.Body, x + S(14), y + h - S(26), naming && _editBookmarkIsNew ? "ENTER save the bookmark · ESC cancel it" : "ENTER save · ESC cancel", UiTheme.TEXT_MUTED);
            Text.Clear().Append(_editLength).Append(" / ").Append(_editMax);
            _ui.TextRight(f.Mono, x + w - S(14), y + h - S(25), Text.Span, UiTheme.TEXT_MUTED);
        }

        /// <summary>
        /// Caret location (x offset and line index) at the end of the typed text.
        /// </summary>
        private void CaretPosition(UiFont font, float maxWidth, out float caretX, out float line)
        {
            UiBatch.WrapEnd(font, maxWidth, _editChars.AsSpan(0, _editLength), 10, out int lines, out float lastWidth);
            line = Math.Max(lines - 1, 0);
            caretX = MathF.Min(lastWidth, maxWidth);
        }

        #endregion

        #region Pause menu

        /// <summary>
        /// Builds and handles the pause menu.
        /// </summary>
        private void BuildPauseMenu()
        {
            // The markup editor, the push report and the comment list take over the whole menu while open
            if (IsMarkupOpen)
            {
                BuildMarkupEditor();
                return;
            }
            if (IsPushPanelOpen)
            {
                BuildPushPanel();
                return;
            }
            if (IsCommentsPanelOpen)
            {
                BuildCommentsPanel();
                return;
            }
            if (IsBookmarksPanelOpen)
            {
                BuildBookmarksPanel();
                return;
            }
            if (IsTexturesPanelOpen)
            {
                BuildTexturesPanel();
                return;
            }
            if (IsLibraryPanelOpen)
            {
                BuildLibraryPanel();
                return;
            }
            if (IsRoomsPanelOpen)
            {
                BuildRoomsPanel();
                return;
            }
            if (IsClashesPanelOpen)
            {
                BuildClashesPanel();
                return;
            }

            if (IsGeometryPanelOpen)
            {
                BuildGeometryPanel();
                return;
            }
            if (IsControlsPanelOpen)
            {
                BuildControlsPanel();
                return;
            }

            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            if (!input.LeftDown) { _activeSlider = -1; }

            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            // Layout (review tools round, to keep the menu inside a 720 px high window): the buttons in two stacks
            // (session · review) when the window is wide enough, else one; the settings in two columns (profile, eye
            // height, units · the Display / Reflections / Debug tabs) when they fit, else stacked. The category cards
            // moved to their own panel (CATEGORIES & LINKS).
            float pad = S(48);
            float leftX = S(56), stackW = S(220), stackGap = S(24);
            float columnW = S(280), columnGap = S(24);
            float rightEdge = width - S(56);
            bool twoStacks = width >= leftX + stackW * 2f + stackGap + S(40) + columnW * 2f + columnGap + S(56);
            float stacksRight = leftX + stackW + (twoStacks ? stackGap + stackW : 0f);
            bool twoColumns = rightEdge - (columnW * 2f + columnGap) >= stacksRight + S(40);

            // ---- Buttons
            float y = pad;
            _ui.Text(f.Small, leftX, y, "BIMGO", UiTheme.TEXT_MUTED, S(2.6f));
            y += S(20);
            _ui.Text(f.Title, leftX, y, "PAUSED", UiTheme.TEXT, S(2.4f));
            y += S(64);
            float buttonsTop = y;

            // Button pitch: 54 px, tightened when a stack would run into END SESSION (small or high-DPI screens)
            float endY = height - pad - S(48);
            int hiddenThings = HiddenThingsCount();
            bool texturesButton = HasTexturePanel;
            bool libraryButton = HasLibrary;
            bool roomsButton = Scene.Rooms.Length > 0;
            int sessionButtons = 4 + (IsFileMode ? 3 : 1); // + CONTROLS (input round B2)
            int reviewButtons = 5 + (hiddenThings > 0 ? 1 : 0) + (texturesButton ? 1 : 0) + (libraryButton ? 1 : 0) + (roomsButton ? 1 : 0);
            int rows = twoStacks ? Math.Max(sessionButtons, reviewButtons) : sessionButtons + reviewButtons;
            float step = Math.Clamp((endY - S(12) - buttonsTop) / rows, S(40), S(54));
            float buttonH = step - S(6);

            // Stack 1: the session
            float x = leftX;
            if (MenuButton(f, x, y, stackW, "RESUME", primary: true, danger: false, height: buttonH)) { SetPaused(false); return; }
            y += step;
            if (MenuButton(f, x, y, stackW, "RETURN HOME", false, false, height: buttonH)) { _player.GoHome(); SetPaused(false); return; }
            y += step;
            if (MenuButton(f, x, y, stackW, _clock < _homeSetUntil ? "HOME SAVED HERE" : "SET HOME HERE", false, false, height: buttonH)) { SetHomeHere(); }
            y += step;

            // Saving: back to the open file, or (Revit) a snapshot + session journal as a new .bimgo
            if (IsFileMode)
            {
                if (MenuButton(f, x, y, stackW, IsDirty ? "SAVE *" : "SAVE", false, false, height: buttonH)) { Save(saveAs: false); return; }
                y += step;
                if (MenuButton(f, x, y, stackW, "SAVE AS…", false, false, height: buttonH)) { Save(saveAs: true); return; }
                y += step;

                // Edits made offline go into the Revit model they came from
                if (MenuButton(f, x, y, stackW, PushMenuLabel(), false, false, height: buttonH)) { OpenPush(); return; }
                y += step;
            }
            else
            {
                if (MenuButton(f, x, y, stackW, "SAVE AS .BIMGO…", false, false, height: buttonH)) { Save(saveAs: true); return; }
                y += step;
            }

            // Keys, mouse buttons and the wheel: every binding, rebindable (input round B2)
            if (MenuButton(f, x, y, stackW, "CONTROLS", false, false, height: buttonH)) { OpenControls(); return; }
            y += step;

            // Stack 2: review tools and panels (beside the first, or below it)
            if (twoStacks)
            {
                x = leftX + stackW + stackGap;
                y = buttonsTop;
            }
            if (MenuButton(f, x, y, stackW, CommentsMenuLabel(), false, false, height: buttonH)) { OpenComments(); return; }
            y += step;
            if (MenuButton(f, x, y, stackW, BookmarksMenuLabel(), false, false, height: buttonH)) { OpenBookmarks(); return; }
            y += step;
            if (texturesButton)
            {
                if (MenuButton(f, x, y, stackW, TexturesMenuLabel(), false, false, height: buttonH)) { OpenTextures(); return; }
                y += step;
            }
            if (roomsButton)
            {
                if (MenuButton(f, x, y, stackW, "FIND ROOM", false, false, height: buttonH)) { OpenRooms(); return; }
                y += step;
            }
            if (MenuButton(f, x, y, stackW, "SUN HOURS STUDY", false, false, height: buttonH)) { OpenSunHours(); return; }
            y += step;
            if (MenuButton(f, x, y, stackW, ClashesMenuLabel(), false, false, height: buttonH)) { OpenClashes(); return; }
            y += step;
            if (libraryButton)
            {
                if (MenuButton(f, x, y, stackW, LibraryMenuLabel(), false, false, height: buttonH)) { OpenLibrary(); return; }
                y += step;
            }
            if (MenuButton(f, x, y, stackW, GeometryMenuLabel(), false, false, height: buttonH)) { OpenGeometry(); return; }
            y += step;

            // Walkthrough-only hiding (Scan I / Shift+I, category and link toggles)
            if (hiddenThings > 0)
            {
                if (_showAllCount != hiddenThings)
                {
                    _showAllCount = hiddenThings;
                    _showAllLabel = $"SHOW ALL ({hiddenThings} HIDDEN)";
                }
                if (MenuButton(f, x, y, stackW, _showAllLabel, false, false, height: buttonH)) { ShowAll(); }
                y += step;
            }

            if (MenuButton(f, x, y, stackW, "CLEAR MARKERS", false, false, height: buttonH))
            {
                // Every gun's markers except comments (persistent: use X with the Comment gun)
                foreach (Gun gun in _guns)
                {
                    if (gun != _commentGun) { gun.ClearMarkers(); }
                }
                Toast("Markers cleared (comments are kept)");
            }

            if (MenuButton(f, leftX, endY, stackW, _live != null ? "LEAVE SESSION" : _options.InApp ? "CLOSE MODEL" : "END SESSION", false, danger: true)) { _endRequested = true; return; }

            // ---- Settings: quality profile, eye height and units · Display / Reflections / Debug
            float tabsX = rightEdge - columnW;
            if (twoColumns)
            {
                BuildSettingsColumn(f, input, tabsX - columnGap - columnW, pad, columnW);
                BuildSettingsTabs(f, input, tabsX, pad, columnW);
            }
            else
            {
                float used = BuildSettingsColumn(f, input, tabsX, pad, columnW);
                BuildSettingsTabs(f, input, tabsX, pad + used + S(12), columnW);
            }

            // Version / file footer
            Text.Clear().Append(DocumentName).Append(" · ").AppendGrouped(Scene.Elements.Length).Append(" elements · ").AppendGrouped(Scene.TriangleCount).Append(" tris · ")
                .Append(_journal.Count).Append(_journal.Count == 1 ? " edit" : " edits");
            _ui.TextRight(f.Small, width - S(56), height - S(28), Text.Span, UiTheme.TEXT_FAINT, S(0.5f));
        }

        /// <summary>
        /// The three group cards with per-category toggles.
        /// </summary>
        private void BuildCategoryCards(FontAtlas f, InputState input, float x, float top, float width)
        {
            _ui.Text(f.Small, x, top + S(2), "GEOMETRY", UiTheme.TEXT_MUTED, S(1.8f));
            float cardTop = top + S(26);
            float gap = S(14);
            float cardW = (width - gap * 2f) / 3f;
            float row = S(22);
            bool changed = false;
            float tallest = 0f;

            for (int g = 0; g < 3; g++)
            {
                var group = (CategoryGroup)g;
                float cx = x + g * (cardW + gap);

                int loaded = 0, visible = 0, rows = 0;
                foreach (CategoryDef def in CategoryCatalog.All)
                {
                    if (def.Group != group) { continue; }
                    rows++;
                    if (Scene.CategoryLoaded[def.Index]) { loaded++; if (_categoryVisible[def.Index]) { visible++; } }
                }

                float cardH = S(52) + rows * row;
                tallest = MathF.Max(tallest, cardH);
                _ui.Panel(cx, cardTop, cardW, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

                // Header: clicking the group name toggles every loaded category in it
                float headerY = cardTop + S(12);
                bool headerHover = loaded > 0 && Hover(input, cx, cardTop, cardW, S(40));
                _ui.Text(f.Bold, cx + S(14), headerY, CategoryCatalog.GROUP_NAMES[g].ToUpperInvariant(), headerHover ? UiTheme.ACCENT : UiTheme.TEXT, S(1.2f));
                string tag = loaded == 0 ? "NOT LOADED" : loaded == rows ? "LOADED" : "PARTIAL";
                _ui.TextRight(f.Small, cx + cardW - S(14), headerY + S(3), tag, loaded == 0 ? UiTheme.TEXT_MUTED : UiTheme.GOOD, S(0.8f));
                _ui.Rect(cx + S(14), cardTop + S(40), cardW - S(28), MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.1f));
                if (headerHover && input.LeftPressed)
                {
                    bool show = visible == 0;
                    foreach (CategoryDef def in CategoryCatalog.All)
                    {
                        if (def.Group == group && Scene.CategoryLoaded[def.Index]) { _categoryVisible[def.Index] = show; }
                    }
                    changed = true;
                }

                float ry = cardTop + S(48);
                foreach (CategoryDef def in CategoryCatalog.All)
                {
                    if (def.Group != group) { continue; }
                    bool enabled = Scene.CategoryLoaded[def.Index];
                    bool on = enabled && _categoryVisible[def.Index];
                    bool hover = enabled && Hover(input, cx + S(8), ry - S(3), cardW - S(16), row);

                    float alpha = enabled ? 1f : 0.4f;
                    float box = S(14);
                    float bx = cx + S(14), by = ry + S(1);
                    _ui.Rect(bx, by, box, box, on ? UiTheme.ACCENT : Rgba.WithAlpha(UiTheme.CONTROL, alpha));
                    _ui.Outline(bx, by, box, box, MathF.Max(1f, UiScale), Rgba.WithAlpha(on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER, alpha));
                    if (on)
                    {
                        _ui.Line(bx + box * 0.22f, by + box * 0.52f, bx + box * 0.42f, by + box * 0.72f, S(2), UiTheme.SCAN_TAG_TEXT);
                        _ui.Line(bx + box * 0.42f, by + box * 0.72f, bx + box * 0.8f, by + box * 0.28f, S(2), UiTheme.SCAN_TAG_TEXT);
                    }

                    _ui.TextWrapped(f.Body, bx + box + S(10), ry, cardW - S(90), def.Label, Rgba.WithAlpha(hover ? UiTheme.ACCENT : UiTheme.TEXT, alpha), maxLines: 1);
                    if (enabled) { Text.Clear().AppendGrouped(Scene.CategoryElementCounts[def.Index]); }
                    else { Text.Clear().Append("—"); }
                    _ui.TextRight(f.Mono, cx + cardW - S(14), ry + S(1), Text.Span, Rgba.WithAlpha(UiTheme.TEXT_FAINT, alpha));

                    if (hover && input.LeftPressed)
                    {
                        _categoryVisible[def.Index] = !_categoryVisible[def.Index];
                        changed = true;
                    }
                    ry += row;
                }
            }

            _ui.Text(f.Body, x, cardTop + tallest + S(12), IsFileMode
                ? "Categories not in this file are greyed out. Export again from Revit with them ticked to include them."
                : "Categories not loaded are greyed out. Tick them in Revit's Options and press Go again to include them.", UiTheme.TEXT_MUTED);

            if (Scene.Links.Length > 0 && BuildLinkCard(f, input, x, cardTop + tallest + S(48), width)) { changed = true; }

            if (changed)
            {
                RefreshMasks();
                VisibilityChanged();
                Sound.Play(SoundId.UiClick);
            }
        }

        /// <summary>
        /// The linked models extracted with the host, each with a show / hide toggle (drawing, picking, collision and
        /// shadows). Rows that don't fit above the bottom of the screen are summarised.
        /// </summary>
        /// <returns>True if a toggle changed.</returns>
        private bool BuildLinkCard(FontAtlas f, InputState input, float x, float top, float width)
        {
            LinkInfo[] links = Scene.Links;
            float row = S(22);
            int fit = Math.Max(1, (int)((_window.Height - S(48) - top - S(70)) / row));
            int rows = Math.Min(links.Length, fit);
            bool changed = false;

            _ui.Text(f.Small, x, top + S(2), "LINKED MODELS (READ-ONLY)", UiTheme.TEXT_MUTED, S(1.8f));
            float cardTop = top + S(26);
            float cardH = S(20) + rows * row + (rows < links.Length ? row : 0f);
            _ui.Panel(x, cardTop, width, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

            float ry = cardTop + S(10);
            for (int i = 0; i < rows; i++)
            {
                LinkInfo link = links[i];
                bool on = _linkVisible[i + 1];
                bool hover = Hover(input, x + S(8), ry - S(3), width - S(16), row);

                float box = S(14);
                float bx = x + S(14), by = ry + S(1);
                _ui.Rect(bx, by, box, box, on ? UiTheme.ACCENT : UiTheme.CONTROL);
                _ui.Outline(bx, by, box, box, MathF.Max(1f, UiScale), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
                if (on)
                {
                    _ui.Line(bx + box * 0.22f, by + box * 0.52f, bx + box * 0.42f, by + box * 0.72f, S(2), UiTheme.SCAN_TAG_TEXT);
                    _ui.Line(bx + box * 0.42f, by + box * 0.72f, bx + box * 0.8f, by + box * 0.28f, S(2), UiTheme.SCAN_TAG_TEXT);
                }

                _ui.TextWrapped(f.Body, bx + box + S(10), ry, width - S(130), link.Name, hover ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                Text.Clear().AppendGrouped(link.ElementCount);
                _ui.TextRight(f.Mono, x + width - S(14), ry + S(1), Text.Span, UiTheme.TEXT_FAINT);

                if (hover && input.LeftPressed)
                {
                    _linkVisible[i + 1] = !on;
                    changed = true;
                }
                ry += row;
            }

            if (rows < links.Length)
            {
                Text.Clear().Append('+').Append(links.Length - rows).Append(" more (make the window taller to list them)");
                _ui.Text(f.Body, x + S(14), ry, Text.Span, UiTheme.TEXT_MUTED);
            }
            return changed;
        }

        /// <summary>
        /// The first settings column: the quality profile, the eye height and the display units (always visible).
        /// </summary>
        /// <returns>Its height.</returns>
        private float BuildSettingsColumn(FontAtlas f, InputState input, float x, float top, float width)
        {
            // Quality profile: Basic / Medium / Realistic, or "Custom" once anything it sets was changed by hand
            QualityProfile profile = CurrentProfile();
            _ui.Text(f.Small, x, top + S(2), "QUALITY PROFILE", UiTheme.TEXT_MUTED, S(1.8f));
            if (profile == QualityProfile.Custom) { _ui.TextRight(f.Small, x + width, top + S(2), "CUSTOM", UiTheme.MEASURE_LABEL, S(1.2f)); }
            int shown = profile == QualityProfile.Custom ? -1 : (int)profile - 1;
            int picked = Segmented(f, input, x, top + S(22), width, PROFILE_OPTIONS, shown);
            if (picked != shown && picked >= 0) { ApplyProfile(QualityProfiles.PICKABLE[picked]); }

            // Eye height: standing / seated / child (tour round)
            float y = top + S(68);
            y += BuildEyeHeightRow(f, input, x, y, width);

            // Units (review tools round)
            y += BuildUnitsRow(f, input, x, y, width);
            return y - top;
        }

        /// <summary>
        /// The Display · Reflections · Debug tabs and the open tab's card. One fixed card height so the column doesn't
        /// jump between tabs.
        /// </summary>
        private void BuildSettingsTabs(FontAtlas f, InputState input, float x, float top, float width)
        {
            int tab = Tabs(f, input, x, top, width, RIGHT_TABS, _rightTab);
            if (tab != _rightTab)
            {
                _rightTab = tab;
                _activeSlider = -1;
            }

            float cardTop = top + S(32);
            _ui.Panel(x, cardTop, width, S(RIGHT_CARD_HEIGHT), UiTheme.CARD, UiTheme.CARD_BORDER);
            float ix = x + S(14), iw = width - S(28), y = cardTop + S(14);
            switch (_rightTab)
            {
                case 1: BuildReflectionsTab(f, input, ix, y, iw); break;
                case 2: BuildDebugTab(f, input, ix, y, iw); break;
                default: BuildDisplayTab(f, input, ix, y, iw); break;
            }
        }

        /// <summary>
        /// The units row: Metric / Imperial, and (imperial) decimal feet instead of feet-inches. Per machine.
        /// </summary>
        /// <returns>The height used.</returns>
        private float BuildUnitsRow(FontAtlas f, InputState input, float x, float y, float width)
        {
            _ui.Text(f.Small, x, y + S(2), "UNITS", UiTheme.TEXT_MUTED, S(1.8f));
            _ui.TextRight(f.Mono, x + width, y + S(1), UnitFormat.IsImperial ? (UnitFormat.DecimalFeet ? "5.63'" : "5' 7 1/2\"") : "1.715 m", Rgba.Hex(0x67E8F9));
            int current = UnitFormat.IsImperial ? 1 : 0;
            int picked = Segmented(f, input, x, y + S(22), width, UNIT_OPTIONS, current);
            if (picked != current) { SetDisplayUnits(picked == 1 ? UnitSystem.Imperial : UnitSystem.Metric, UnitFormat.DecimalFeet); }
            if (!UnitFormat.IsImperial) { return S(66); }

            bool decimalFeet = Checkbox(f, input, x, y + S(64), width, "Decimal feet (5.63' not 5' 7 1/2\")", UnitFormat.DecimalFeet);
            if (decimalFeet != UnitFormat.DecimalFeet) { SetDisplayUnits(UnitSystem.Imperial, decimalFeet); }
            return S(94);
        }

        /// <summary>
        /// Changes the display units (pause menu): labels made once (bookmark details, the room list) are rebuilt;
        /// saved with the other settings when the session ends.
        /// </summary>
        private void SetDisplayUnits(UnitSystem system, bool decimalFeet)
        {
            UnitFormat.Set(system, decimalFeet);
            Bookmarks?.RefreshLabels();
            _roomRows = null;
            _roomMatchesDirty = true;
        }

        /// <summary>
        /// Display tab: ground plane, colour, anti-aliasing, FOV, sensitivity and toggles.
        /// </summary>
        private void BuildDisplayTab(FontAtlas f, InputState input, float ix, float y, float iw)
        {
            // Ground plane (relative to the default, shown absolute)
            Text.Clear().AppendLength(_groundZ, 3);
            float ground = Slider(f, input, 0, ix, y, iw, "Ground plane", Text.Span, _groundZ, _groundDefault - 10f, _groundDefault + 10f);
            // Only while dragging (the default needn't sit on the 5 cm steps, and must not mark the file changed)
            ground = MathF.Round(ground / 0.05f) * 0.05f;
            if (_activeSlider == 0 && ground != _groundZ)
            {
                // Saved with the model (visibility.json / the live model folder), like hidden elements
                _groundZ = ground;
                VisibilityChanged();
            }
            y += S(58);

            // Colour mode
            _ui.Text(f.Body, ix, y, "Colour mode", UiTheme.TEXT);
            int current = _whitecard ? 0 : _realistic ? 2 : 1;
            int colour = Segmented(f, input, ix, y + S(22), iw, COLOUR_OPTIONS, current);
            if (colour != current)
            {
                _whitecard = colour == 0;
                _realistic = colour == 2;
                if (_realistic && !_renderer.HasMaterials) { ToastNoTextures(); }
            }
            y += S(64);

            // Anti-aliasing
            _ui.Text(f.Body, ix, y, "Anti-aliasing", UiTheme.TEXT);
            int msaaIndex = Segmented(f, input, ix, y + S(22), iw, MSAA_OPTIONS, _msaa >= 4 ? 2 : _msaa >= 2 ? 1 : 0);
            _msaa = msaaIndex == 2 ? 4 : msaaIndex == 1 ? 2 : 0;
            y += S(64);

            // FOV
            Text.Clear().Append(_fov, 0).Append('°');
            _fov = MathF.Round(Slider(f, input, 1, ix, y, iw, "Field of view", Text.Span, _fov, 60f, 120f));
            y += S(58);

            // Sensitivity
            Text.Clear().Append(_sensitivity, 2);
            _sensitivity = MathF.Round(Slider(f, input, 2, ix, y, iw, "Mouse sensitivity", Text.Span, _sensitivity, 0.1f, 3f) / 0.05f) * 0.05f;
            y += S(62);

            // Toggles
            bool vsync = Checkbox(f, input, ix, y, iw, "VSync", _vsync);
            if (vsync != _vsync)
            {
                _vsync = vsync;
                Native.Wgl.SetSwapInterval(_vsync);
            }
            y += S(28);
            _invertY = Checkbox(f, input, ix, y, iw, "Invert Y", _invertY);
            y += S(28);
            _showFps = Checkbox(f, input, ix, y, iw, "Show FPS", _showFps);
            y += S(28);
            _ambientOcclusion = Checkbox(f, input, ix, y, iw, "Ambient occlusion", _ambientOcclusion);
        }

        /// <summary>
        /// Debug tab: colour surfaces by reflection tier or by reflection probe (not saved).
        /// </summary>
        private void BuildDebugTab(FontAtlas f, InputState input, float ix, float y, float iw)
        {
            _ui.Text(f.Body, ix, y, "Debug colours", UiTheme.TEXT);
            int debug = Segmented(f, input, ix, y + S(22), iw, DEBUG_OPTIONS, _reflectDebug);
            if (debug != _reflectDebug)
            {
                _reflectDebug = debug;
                if (debug != 0 && (!_realistic || _renderer == null || !_renderer.HasMaterials))
                {
                    Toast("Debug colours need the Realistic colour mode and a snapshot with materials.", 4f);
                }
            }
            y += S(66);

            string help = _reflectDebug switch
            {
                1 => "Reflection: red 75 %+, orange 50 %, yellow 25 %, grey none, cyan glass, blue water.",
                2 => "Probes: one colour per reflection probe, blended at room edges; grey = sky. Probes bake as you look around.",
                _ => "Colours surfaces by reflection tier or by the probe they read. Needs the Realistic colour mode. Not saved."
            };
            _ui.TextWrapped(f.Body, ix, y, iw, help, UiTheme.TEXT_MUTED, maxLines: 6);
        }

        /// <summary>
        /// The toast for Realistic without textures in the snapshot.
        /// </summary>
        private void ToastNoTextures() =>
            Toast("No textures in this snapshot: tick “Extract materials and textures” at Go (or Export) to see them.", 5f);

        /// <summary>
        /// A row of tabs (text with an accent underline on the open one).
        /// </summary>
        /// <returns>The open tab (changed by a click).</returns>
        private int Tabs(FontAtlas f, InputState input, float x, float y, float w, string[] labels, int selected)
        {
            float h = S(28);
            float tab = w / labels.Length;
            _ui.Rect(x, y + h - MathF.Max(1f, UiScale), w, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.12f));
            for (int i = 0; i < labels.Length; i++)
            {
                float tx = x + i * tab;
                bool on = i == selected;
                bool hover = !on && Hover(input, tx, y, tab, h);
                uint colour = on ? UiTheme.TEXT : hover ? UiTheme.ACCENT : UiTheme.TEXT_MUTED;
                _ui.TextCentred(f.Small, tx + tab * 0.5f, y + S(7), labels[i], colour, S(1.4f));
                if (on) { _ui.Rect(tx + S(6), y + h - S(2), tab - S(12), S(2), UiTheme.ACCENT); }
                if (hover && input.LeftPressed)
                {
                    selected = i;
                    Sound.Play(SoundId.UiClick);
                }
            }
            return selected;
        }

        /// <summary>
        /// The colour mode as the status panel shows it.
        /// </summary>
        private string ColourModeLabel()
        {
            if (_whitecard) { return "Whitecard"; }
            if (!_realistic) { return "Material colour"; }
            return _renderer != null && _renderer.HasMaterials ? "Realistic" : "Realistic (no textures)";
        }

        #endregion

        #region Menu labels

        private string _pushMenuLabel;
        private int _pushMenuLabelFor = -1;
        private string _commentsMenuLabel;
        private int _commentsMenuLabelFor = -1;

        /// <summary>"PUSH TO REVIT (n)…" (rebuilt only when the count changes).</summary>
        private string PushMenuLabel()
        {
            int pending = _journal.CountNotInRevit();
            if (pending != _pushMenuLabelFor || _pushMenuLabel == null)
            {
                _pushMenuLabelFor = pending;
                _pushMenuLabel = pending == 0 ? "PUSH TO REVIT…" : $"PUSH TO REVIT ({pending})…";
            }
            return _pushMenuLabel;
        }

        /// <summary>"COMMENTS (n)" (rebuilt only when the count changes).</summary>
        private string CommentsMenuLabel()
        {
            int count = Comments?.Comments.Count ?? 0;
            if (count != _commentsMenuLabelFor || _commentsMenuLabel == null)
            {
                _commentsMenuLabelFor = count;
                _commentsMenuLabel = count == 0 ? "COMMENTS" : $"COMMENTS ({count})";
            }
            return _commentsMenuLabel;
        }

        #endregion

        #region Widgets

        private static bool Hover(InputState input, float x, float y, float w, float h)
        {
            Vector2 m = input.MousePosition;
            return m.X >= x && m.X < x + w && m.Y >= y && m.Y < y + h;
        }

        /// <summary>
        /// A full-width menu button. A disabled button is drawn faded and never reports a click.
        /// </summary>
        /// <param name="height">Button height in pixels (0 = the standard 48 px, scaled).</param>
        private bool MenuButton(FontAtlas f, float x, float y, float w, string label, bool primary, bool danger, bool enabled = true, float height = 0f)
        {
            InputState input = _window.Input;
            float h = height > 0f ? height : S(48);
            bool hover = enabled && Hover(input, x, y, w, h);
            float alpha = enabled ? 1f : 0.4f;

            if (primary)
            {
                _ui.Rect(x, y, w, h, Fade(hover ? Rgba.Hex(0x67E8F9) : UiTheme.ACCENT, alpha));
            }
            else
            {
                _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.08f) : Rgba.Hex(0xFFFFFF, 0.0f));
                _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), Fade(danger ? Rgba.Hex(0xFCA5A5, 0.45f) : Rgba.Hex(0xFFFFFF, 0.2f), alpha));
            }

            uint textColour = primary ? Rgba.Hex(0x06232A) : danger ? UiTheme.DANGER : UiTheme.TEXT;
            _ui.Text(f.Bold, x + S(16), y + h * 0.5f - f.Bold.LineHeight * 0.5f, label, primary ? textColour : Fade(textColour, alpha), S(1.3f));

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>
        /// Scales a colour's alpha (1 = unchanged).
        /// </summary>
        private static uint Fade(uint colour, float factor)
        {
            if (factor >= 1f) { return colour; }
            uint alpha = (uint)Math.Clamp((int)((colour >> 24) * factor + 0.5f), 0, 255);
            return (colour & 0x00FFFFFF) | (alpha << 24);
        }

        /// <summary>
        /// A labelled horizontal slider with a value readout.
        /// </summary>
        private float Slider(FontAtlas f, InputState input, int id, float x, float y, float w, string label, ReadOnlySpan<char> valueText, float value, float min, float max)
        {
            _ui.Text(f.Body, x, y, label, UiTheme.TEXT);
            _ui.TextRight(f.Mono, x + w, y + S(1), valueText, Rgba.Hex(0x67E8F9));

            float trackY = y + S(30);
            float knobR = S(7);
            bool hover = Hover(input, x - knobR, trackY - S(12), w + knobR * 2f, S(24));
            if (hover && input.LeftPressed) { _activeSlider = id; }

            if (_activeSlider == id && input.LeftDown)
            {
                float t = Math.Clamp((input.MousePosition.X - x) / w, 0f, 1f);
                value = min + t * (max - min);
            }

            float fraction = Math.Clamp((value - min) / (max - min), 0f, 1f);
            _ui.Rect(x, trackY - S(2), w, S(4), Rgba.Hex(0xFFFFFF, 0.15f));
            _ui.Rect(x, trackY - S(2), w * fraction, S(4), UiTheme.ACCENT);
            _ui.Circle(x + w * fraction, trackY, knobR, hover || _activeSlider == id ? Rgba.Hex(0x67E8F9) : UiTheme.ACCENT, 16);
            return value;
        }

        /// <summary>
        /// A segmented choice control.
        /// </summary>
        private int Segmented(FontAtlas f, InputState input, float x, float y, float w, string[] options, int selected)
        {
            float h = S(32);
            float segment = w / options.Length;
            for (int i = 0; i < options.Length; i++)
            {
                float sx = x + i * segment;
                bool on = i == selected;
                bool hover = Hover(input, sx, y, segment, h);
                _ui.Rect(sx, y, segment, h, on ? UiTheme.ACCENT : hover ? Rgba.Hex(0xFFFFFF, 0.08f) : UiTheme.CONTROL);
                _ui.Outline(sx, y, segment, h, MathF.Max(1f, UiScale), UiTheme.CONTROL_BORDER);
                _ui.TextCentred(f.Body, sx + segment * 0.5f, y + h * 0.5f - f.Body.LineHeight * 0.5f, options[i], on ? Rgba.Hex(0x06232A) : UiTheme.TEXT);
                if (hover && input.LeftPressed && !on)
                {
                    selected = i;
                    Sound.Play(SoundId.UiClick);
                }
            }
            return selected;
        }

        /// <summary>
        /// A checkbox row.
        /// </summary>
        private bool Checkbox(FontAtlas f, InputState input, float x, float y, float w, string label, bool value)
        {
            float box = S(16);
            bool hover = Hover(input, x, y - S(3), w, S(24));
            _ui.Rect(x, y, box, box, value ? UiTheme.ACCENT : UiTheme.CONTROL);
            _ui.Outline(x, y, box, box, MathF.Max(1f, UiScale), value ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            if (value)
            {
                _ui.Line(x + box * 0.22f, y + box * 0.52f, x + box * 0.42f, y + box * 0.72f, S(2), Rgba.Hex(0x06232A));
                _ui.Line(x + box * 0.42f, y + box * 0.72f, x + box * 0.8f, y + box * 0.28f, S(2), Rgba.Hex(0x06232A));
            }
            _ui.Text(f.Body, x + box + S(10), y - S(1), label, hover ? UiTheme.ACCENT : UiTheme.TEXT);

            if (hover && input.LeftPressed)
            {
                Sound.Play(SoundId.UiClick);
                return !value;
            }
            return value;
        }

        #endregion
    }
}
