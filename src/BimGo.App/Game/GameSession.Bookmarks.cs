using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Viewpoint bookmarks: B saves where the player stands and looks (then asks for a name), Shift+1..9 (by default) jump to the
    /// first nine, and the pause menu's BOOKMARKS list has Go, Rename, Set here (update), reorder and Delete.
    /// Bookmarks are saved inside a .bimgo (bookmarks.json) or, in a live Revit session, beside the model.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private bool _bookmarksOpen;
        private readonly ScrollRegion _bookmarkScroll = new();
        private BookmarkRecord _bookmarkDeleteArmed;
        private float _bookmarkDeleteArmedUntil;
        private string _bookmarksNotice;

        private string _bookmarksMenuLabel;
        private int _bookmarksMenuLabelFor = -1;

        #endregion

        /// <summary>Saved viewpoints.</summary>
        public BookmarkStore Bookmarks { get; private set; }

        #region Setup

        /// <summary>
        /// Creates the bookmark store: embedded in a .bimgo, else a sidecar beside the Revit model's comments sidecar.
        /// </summary>
        private void InitialiseBookmarks()
        {
            if (IsFileMode)
            {
                Bookmarks = new BookmarkStore(null, Scene.ModelTitle, Scene.OriginOffset);
                Bookmarks.LoadFrom(_options.Document?.Bookmarks);
            }
            else
            {
                Bookmarks = new BookmarkStore(BookmarkFiles.SidecarFor(Scene.CommentsPath), Scene.ModelTitle, Scene.OriginOffset);
                Bookmarks.Load();
            }
            Bookmarks.Changed += UpdateTitle;
            Bookmarks.Stamp = StampBookmark; // P-C: crouching and the colour profile
            Bookmarks.ProfileName = id => _appearance.Find(id)?.Name;
        }

        /// <summary>
        /// Polish round P-C: what a new or re-pointed bookmark keeps beyond the store's fields: crouching (walking) and the
        /// colour profile showing (its id, or "" when none shows).
        /// </summary>
        private void StampBookmark(BookmarkRecord record)
        {
            record.Crouched = _player != null && !_player.Flying && _player.Controller.Crouching;
            record.ColourProfile = ProfileShowing ? _appearance.Active : string.Empty;
        }

        /// <summary>
        /// Polish round P-C: a bookmark's colour profile (null: leave it; "": off; an id: that profile on). Recorded (saved
        /// with the model) unless <paramref name="quiet"/> (the tour, which puts it back at the end).
        /// </summary>
        private void ApplyBookmarkProfile(string id, bool quiet)
        {
            if (id == null) { return; }
            bool on = id.Length > 0 && _appearance.Find(id) != null;
            string active = on ? id : _appearance.Active;
            if (_appearance.On == on && _appearance.Active == active) { return; }
            _appearance.Active = active;
            _appearance.On = on;
            _profileFailure = null;
            if (quiet) { _profileDirty = true; }
            else { ProfilesChanged(); }
        }

        #endregion

        #region Actions

        /// <summary>
        /// B: prepares a bookmark of the current viewpoint (default name, thumbnail taken next frame) and opens the name
        /// box: Enter adds it to the list, Esc throws it away.
        /// </summary>
        private void AddBookmarkHere()
        {
            if (_player == null) { return; }
            BookmarkRecord record = Bookmarks.CreatePending(null, _player.Feet, _player.Yaw, _player.Pitch, _player.Flying, CurrentLevelName, BookmarkSunTime(), _section,
                CurrentStandingEye, BookmarkVisibility());
            _thumbnailFor = record;
            Sound.Play(SoundId.CommentPlace);
            BeginBookmarkRename(record, isNew: true);
        }

        /// <summary>
        /// Shift+1..9 (by default): jumps to the bookmark at that place in the list.
        /// </summary>
        /// <param name="index">0-based list index.</param>
        private void GoToBookmarkAt(int index)
        {
            if (index < 0 || index >= Bookmarks.Bookmarks.Count)
            {
                Toast(Bookmarks.Bookmarks.Count == 0
                    ? $"No bookmarks yet: press {Key(InputAction.AddBookmark)} to save this viewpoint"
                    : $"Only {Bookmarks.Bookmarks.Count} bookmark{(Bookmarks.Bookmarks.Count == 1 ? string.Empty : "s")} (Esc → BOOKMARKS lists them)");
                return;
            }
            GoToBookmark(Bookmarks.Bookmarks[index]);
        }

        /// <summary>
        /// How to get back to a bookmark, for toasts: "Ctrl+3", or the list past the ninth (allocates; not per frame).
        /// </summary>
        private string BookmarkHotkey(BookmarkRecord record)
        {
            int index = Bookmarks.Bookmarks.IndexOf(record);
            return index >= 0 && index < 9 && !Hotkeys.Map.IsUnbound(InputCatalog.BookmarkAction(index)) ? Key(InputCatalog.BookmarkAction(index)) : "Esc → BOOKMARKS";
        }

        /// <summary>
        /// The sun time a bookmark should keep: the current date / time when shadows are on, else null.
        /// </summary>
        private SunTime BookmarkSunTime()
        {
            if (!ShadowsOn) { return null; }
            SunTime time = _sun.Time.Copy();
            if (_sunPlaying) { time.Minutes = Math.Clamp((int)_playMinutes, 0, 1439); }
            return time;
        }

        /// <summary>
        /// Puts the player at a bookmark (walk / fly mode as saved) and restores what it kept: the sun time (shadows on),
        /// the section cut, the hidden categories / links / elements and the eye height. Older bookmarks without a field
        /// leave that part as it is.
        /// </summary>
        private void GoToBookmark(BookmarkRecord record)
        {
            if (record == null || _player == null) { return; }
            if (record.Sun != null) { ApplySunTime(record.Sun); }
            if (record.Section != null) { ApplySection(record.Section, announce: false); }
            if (record.Visibility != null) { ApplyVisibility(record.Visibility, record: true); }
            if (record.EyeHeight is float eye) { ApplyEyeHeight(eye); }
            if (record.Flying != _player.Flying) { _player.ToggleFly(); }
            ApplyBookmarkProfile(record.ColourProfile, quiet: false); // P-C
            _player.TeleportTo(record.Local, record.Yaw, Math.Clamp(record.Pitch, -1.5f, 1.5f));
            _player.Controller.HoldCrouch = record.Crouched && !record.Flying; // P-C: arrive crouched (crouch or jump stands)
            Sound.Play(SoundId.Teleport);
            Flash(UiTheme.BOOKMARK, 0.25f);
            Toast(record.Name);
        }

        #endregion

        #region Open / close

        /// <summary>True while the bookmark list is showing (it replaces the pause menu).</summary>
        private bool IsBookmarksPanelOpen => _bookmarksOpen;

        private void OpenBookmarks()
        {
            _bookmarksOpen = true;
            _bookmarkScroll.Reset();
            _bookmarkDeleteArmed = null;
            _bookmarksNotice = null;
        }

        /// <summary>
        /// One level back: the list closes (Round K-A: the tour settings moved to MEDIA → TOUR).
        /// </summary>
        /// <returns>True if it was open.</returns>
        private bool CloseBookmarks()
        {
            if (!_bookmarksOpen) { return false; }
            CloseBookmarksPanel();
            return true;
        }

        /// <summary>Closes the list (a tour starting, CLOSE).</summary>
        private void CloseBookmarksPanel()
        {
            if (!_bookmarksOpen) { return; }
            _bookmarksOpen = false;
            _bookmarkDeleteArmed = null;
        }

        /// <summary>"BOOKMARKS (n)" (rebuilt only when the count changes).</summary>
        private string BookmarksMenuLabel()
        {
            int count = Bookmarks?.Bookmarks.Count ?? 0;
            if (count != _bookmarksMenuLabelFor || _bookmarksMenuLabel == null)
            {
                _bookmarksMenuLabelFor = count;
                _bookmarksMenuLabel = count == 0 ? "BOOKMARKS" : $"BOOKMARKS ({count})";
            }
            return _bookmarksMenuLabel;
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the bookmark list (in place of the pause menu).
        /// </summary>
        private void BuildBookmarksPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            Text.Clear().AppendGrouped(Bookmarks.Bookmarks.Count).Append(Bookmarks.Bookmarks.Count == 1 ? " viewpoint · saved to " : " viewpoints · saved to ").Append(Bookmarks.FileName);
            const string ADD = "ADD THIS VIEW";
            PanelFrame frame = BeginPanel(PanelSize.Standard, "BOOKMARKS", UiTheme.BOOKMARK_LABEL, Text.Span, headerControls: ShellButtonWidth(f, ADD));

            if (HeaderButton(ref frame, ADD))
            {
                BookmarkRecord added = Bookmarks.Add(null, _player.Feet, _player.Yaw, _player.Pitch, _player.Flying, CurrentLevelName, BookmarkSunTime(), _section,
                    CurrentStandingEye, BookmarkVisibility());
                _thumbnailFor = added;
                _bookmarksNotice = Bookmarks.LastError ?? $"Added “{added.Name}” (RENAME to change it)";
                _bookmarkScroll.ScrollToEnd();
            }

            BuildBookmarkRows(f, input, frame.Ix, frame.BodyTop, frame.Iw, frame.BodyBottom);
            if (!_bookmarksOpen) { return; } // GO / RENAME left the panel

            int settings = FooterAction("TOUR SETTINGS"); // Round K-A: MEDIA → TOUR
            int play = FooterAction("PLAY TOUR", ShellStyle.Primary);
            int pressed = EndPanel(frame, _bookmarksNotice, HINT_BOOKMARKS_KEYS.Text);
            if (pressed == settings)
            {
                CloseBookmarksPanel();
                OpenMedia(MEDIA_TOUR);
            }
            else if (pressed == play) { StartTour(); }
        }

        /// <summary>
        /// The rows (a clipped scroll region): number, name, details and Go / Rename / Set here / ↑ / ↓ / Delete.
        /// </summary>
        private void BuildBookmarkRows(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            List<BookmarkRecord> list = Bookmarks.Bookmarks;
            float rowH = S(74);

            if (list.Count == 0)
            {
                _ui.TextWrapped(f.Body, x, y + S(8), w, HINT_BOOKMARKS_EMPTY.Text, UiTheme.TEXT_MUTED, maxLines: 2);
                return;
            }
            if (_bookmarkDeleteArmed != null && _clock > _bookmarkDeleteArmedUntil) { _bookmarkDeleteArmed = null; }

            // Polish round P-A1: a clipped, pixel-scrolled list (rows drawn from 4 px inside, so the stripe fits)
            float top = BeginScroll(_bookmarkScroll, input, x, y, w, bottom - y, out float cw);
            VisibleRows(_bookmarkScroll, rowH, list.Count, out int first, out int last);
            float listX = x;
            x += S(8);
            w = cw - S(16);

            BookmarkRecord go = null, rename = null, here = null, up = null, down = null, delete = null;
            float small = S(34), wide = S(84), gap = S(6);
            float buttonsW = wide * 4 + small * 2 + gap * 5;
            for (int i = first; i < last; i++)
            {
                BookmarkRecord record = list[i];
                float ry = top + i * rowH + S(4);
                if ((i & 1) == 0) { _ui.Rect(listX, ry - S(4), cw, rowH - S(4), UiTheme.ROW_STRIPE); }

                // Number (Ctrl+n for the first nine), thumbnail, name, then "Level · author · date"
                Text.Clear().Append(i + 1);
                _ui.Text(f.Mono, x, ry + S(4), Text.Span, i < 9 ? UiTheme.BOOKMARK_LABEL : UiTheme.TEXT_FAINT);
                float thumbX = x + S(30), thumbY = ry, thumbW = S(110), thumbH = S(62);
                uint thumbnail = ThumbnailTexture(record);
                if (thumbnail != 0)
                {
                    _ui.Image(thumbnail, thumbX, thumbY, thumbW, thumbH, _window.Width, _window.Height);
                    _ui.Outline(thumbX, thumbY, thumbW, thumbH, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.15f));
                }
                else
                {
                    _ui.Panel(thumbX, thumbY, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
                    _ui.TextCentred(f.Small, thumbX + thumbW * 0.5f, thumbY + thumbH * 0.5f - S(7), "NO PICTURE", UiTheme.TEXT_FAINT, S(0.4f));
                }
                float textX = thumbX + thumbW + S(14);
                float textW = w - buttonsW - S(46) - thumbW - S(14);
                _ui.TextWrapped(f.Bold, textX, ry + S(10), textW, record.Name, UiTheme.TEXT, maxLines: 1);
                _ui.TextWrapped(f.Small, textX, ry + S(34), textW, record.Detail, UiTheme.TEXT_MUTED, maxLines: 1);

                float bx = x + w - buttonsW, by = ry + S(14), bh = S(30);
                if (SmallButton(f, input, bx, by, wide, bh, "GO")) { go = record; }
                bx += wide + gap;
                if (SmallButton(f, input, bx, by, wide, bh, "RENAME")) { rename = record; }
                bx += wide + gap;
                if (SmallButton(f, input, bx, by, wide, bh, "SET HERE")) { here = record; }
                bx += wide + gap;
                if (SmallButton(f, input, bx, by, small, bh, "↑") && i > 0) { up = record; }
                bx += small + gap;
                if (SmallButton(f, input, bx, by, small, bh, "↓") && i < list.Count - 1) { down = record; }
                bx += small + gap;
                bool armed = ReferenceEquals(_bookmarkDeleteArmed, record);
                if (SmallButton(f, input, bx, by, wide, bh, armed ? "SURE?" : "DELETE", danger: true)) { delete = record; }
            }

            EndScroll(_bookmarkScroll, input, top + list.Count * rowH);

            // Act after drawing (the list must not change while it is being walked)
            if (go != null)
            {
                CloseBookmarks();
                SetPaused(false);
                GoToBookmark(go);
            }
            else if (rename != null)
            {
                CloseBookmarks();
                SetPaused(false);
                BeginBookmarkRename(rename, isNew: false);
            }
            else if (here != null)
            {
                Bookmarks.Update(here, _player.Feet, _player.Yaw, _player.Pitch, _player.Flying, CurrentLevelName, BookmarkSunTime(), _section,
                    CurrentStandingEye, BookmarkVisibility());
                _thumbnailFor = here;
                _bookmarksNotice = Bookmarks.LastError ?? $"“{here.Name}” now points at where you are";
                Sound.Play(SoundId.Commit);
            }
            else if (up != null || down != null)
            {
                Bookmarks.Move(up ?? down, up != null ? -1 : +1);
                _bookmarksNotice = Bookmarks.LastError;
            }
            else if (delete != null)
            {
                if (ReferenceEquals(_bookmarkDeleteArmed, delete))
                {
                    Bookmarks.Remove(delete);
                    _bookmarkDeleteArmed = null;
                    _bookmarksNotice = Bookmarks.LastError ?? $"Deleted “{delete.Name}”";
                    Sound.Play(SoundId.Remove);
                }
                else
                {
                    _bookmarkDeleteArmed = delete;
                    _bookmarkDeleteArmedUntil = _clock + 3f;
                }
            }
        }

        #endregion
    }
}
