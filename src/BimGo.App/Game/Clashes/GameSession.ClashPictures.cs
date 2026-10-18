using System.Diagnostics;
using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Gl = BimGo.Native.Gl;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash pictures (Round C, build C-B2). Every picture is the clash view as clash mode draws it: the current G view
    /// (ghost / wireframe / real / hidden) and the section box round the clash when it is on (B), rendered off-screen
    /// from the clash's framing (no HUD, markers or gizmos).
    /// <list type="bullet">
    /// <item><b>Row pictures</b> in the docked list (PICTURES on / off, per machine): 160 × 90, rendered for the rows on
    /// screen, a couple per frame at the start of the next frame, cached for the session (G and B make them stale: the
    /// old picture shows until its new one is ready; the clash GO visits is taken again).</item>
    /// <item><b>TO COMMENT</b>: the current clash → a comment (what you see: the camera and cut as they are), with the
    /// picture, the view and section, the clash's summary and notes, its status mapped (new / active → open, reviewed →
    /// in progress, approved / resolved → closed), its assignee, and high priority for a hard clash deeper than 50 mm.
    /// <see cref="ClashRecord.CommentId"/> and <see cref="CommentRecord.ClashId"/> link them; a clash that has a comment
    /// updates it (picture, view, section, status; a marked-up picture is replaced only after a confirm).</item>
    /// <item><b>Several selected</b> (C-B3, Ctrl / Shift click): a comment each (at most
    /// <see cref="ClashCommentRules.BATCH_LIMIT"/>), from each clash's own framing, a few per frame with progress and CANCEL
    /// (the ones made stay). Clashes that already have a comment are only updated after UPDATE THEM (NEW ONLY skips
    /// them); marked-up pictures are replaced only with the tick. LIST TO COMMENTS (the whole list) is gone: you pick.</item>
    /// <item><b>MARKUP</b> / the pencil on a row picture (C-B3): the markup editor on the clash's comment picture,
    /// back to clash mode when it closes.</item>
    /// <item>The comment's status follows the clash's (1–5, runs and imported reports update it; one way).</item>
    /// </list>
    /// EXPORT BCF then carries the clashes as "Clash" topics with both elements as components.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Constants

        private const int CLASH_THUMB_W = 160, CLASH_THUMB_H = 90;
        private const int CLASH_THUMB_RENDER_W = 320, CLASH_THUMB_RENDER_H = 180;

        /// <summary>Row pictures kept at once (more frees them all; the rows on screen are taken again).</summary>
        private const int CLASH_THUMB_CACHE_MAX = 300;

        /// <summary>Comment pictures: the BCF snapshot size (16:9, as other comments).</summary>
        private const int CLASH_SHOT_W = 1280, CLASH_SHOT_H = 720;

        /// <summary>Time a frame may spend on clash pictures (ms) before the rest wait for the next frame.</summary>
        private const double CLASH_PICTURE_BUDGET_MS = 40.0;

        /// <summary>TO COMMENTS saves the comments every this many.</summary>
        private const int CLASH_BATCH_SAVE_EVERY = 25;

        #endregion

        #region Fields

        // Row pictures: on / off (per machine), the version stale ones are compared with, the cache and this frame's wants
        private bool _clashThumbsOn = true;
        private int _clashThumbVersion;
        private string _clashThumbLabel;
        private readonly Dictionary<ClashRecord, (uint Texture, int Version)> _clashThumbs = new();
        private readonly List<ClashRecord> _clashThumbWanted = new();

        // True while a clash picture renders (RenderScene then draws the clash view in its photo pass)
        private bool _clashShot;

        // Off-screen targets and read-back buffers (made on first use, kept while clash mode needs them)
        private RenderTarget _clashThumbTarget, _clashShotTarget, _clashShotResolve;
        private byte[] _clashThumbRender, _clashThumbPixels, _clashShotPixels;

        // TO COMMENT waiting for the start of the next frame (0 none, 1 make / update, 2 also replace a marked-up picture)
        private int _clashCommentPending;

        // TO COMMENTS in progress (C-B3: the selection; marked-up pictures replaced only when ticked)
        private List<ClashRecord> _clashBatch;
        private bool _clashBatchReplace;

        // C-B3: the card's "3 TO COMMENTS" (cached by count) and a row pencil clicked this frame
        private string _clashCommentsLabel;
        private int _clashCommentsLabelFor = -1;
        private ClashRecord _clashMarkupClick;
        private int _clashBatchNext, _clashBatchCreated, _clashBatchUpdated, _clashBatchKept, _clashBatchFailed;
        private readonly Stopwatch _clashPictureClock = new();

        #endregion

        #region Frame

        /// <summary>
        /// Clash pictures due this frame, before the scene renders (camera, section and targets are put back after
        /// each): a pending TO COMMENT, the next TO COMMENTS pictures, or the row pictures the list wanted last frame.
        /// </summary>
        private void RenderClashPictures()
        {
            if (!_clashModeOn)
            {
                _clashThumbWanted.Clear();
                _clashCommentPending = 0;
                _clashGroupCommentPending = null;
                return;
            }

            if (_clashGroupCommentPending != null)
            {
                _clashThumbWanted.Clear();
                MakePendingClashGroupComment(); // C-C1: one comment for a group, framed on every member
                return;
            }

            if (_clashCommentPending != 0)
            {
                bool replace = _clashCommentPending == 2;
                _clashCommentPending = 0;
                _clashThumbWanted.Clear();
                MakeCurrentClashComment(replace);
                return;
            }

            if (_clashBatch != null)
            {
                _clashThumbWanted.Clear();
                StepClashBatch();
                return;
            }

            if (_clashReportJob != null)
            {
                _clashThumbWanted.Clear();
                StepClashReport(); // C-C3: the report's pictures
                return;
            }

            if (!_clashThumbsOn || _paused || _clashThumbWanted.Count == 0)
            {
                _clashThumbWanted.Clear();
                return;
            }
            int budget = _clashView == CLASH_VIEW_REAL ? 1 : 2; // the real view re-renders the sun's shadows too
            _clashPictureClock.Restart();
            for (int i = 0; i < _clashThumbWanted.Count && budget > 0; i++)
            {
                if (_clashPictureClock.Elapsed.TotalMilliseconds > CLASH_PICTURE_BUDGET_MS) { break; }
                RenderClashThumbnail(_clashThumbWanted[i]);
                budget--;
            }
            _clashThumbWanted.Clear();
        }

        /// <summary>
        /// Renders one clash's view off-screen into <paramref name="pixels"/> (bottom-up BGRA), then puts back the clash
        /// on screen, the section cut, the camera, the framebuffer and the viewport.
        /// </summary>
        /// <param name="clash">The clash.</param>
        /// <param name="framed">
        /// True: from the clash's own framing, the section box round it when the box is on (B). False: the current
        /// camera and cut, as you see them (the current clash).
        /// </param>
        /// <param name="frame">The camera used (scene-local eye).</param>
        /// <param name="cut">The section cut the picture shows (an inactive cut: none).</param>
        /// <returns>False when it could not be rendered (logged).</returns>
        private bool RenderClashPicture(ClashRecord clash, int width, int height, int samples, RenderTarget target, RenderTarget resolve,
            byte[] pixels, bool framed, out ClashView frame, out SectionCut cut)
        {
            frame = new ClashView(default, Camera.Position, Camera.Yaw, Camera.Pitch);
            cut = _section.Clone();

            ClashRecord current = _clashCurrent;
            bool multiSuspended = _clashMultiSuspended;
            int elementA = _clashElementA, elementB = _clashElementB;
            DynamicInstance dynamicA = _clashDynamicA, dynamicB = _clashDynamicB;
            SectionCut section = _section.Clone();
            Vector3 position = Camera.Position;
            float yaw = Camera.Yaw, pitch = Camera.Pitch;
            float viewportW = Camera.ViewportWidth, viewportH = Camera.ViewportHeight, aspect = Camera.Aspect;
            try
            {
                if (framed)
                {
                    _clashMultiSuspended = true; // one clash's picture, not the selection
                    _clashCurrent = clash;
                    ResolveClashElement(clash.A, out _clashElementA, out _clashDynamicA);
                    ResolveClashElement(clash.B, out _clashElementB, out _clashDynamicB);
                    frame = FrameClash(clash, _player.Yaw, out _, out SectionCut box);
                    cut = _clashBoxOn ? box : new SectionCut();
                    SetSectionQuiet(cut);
                    Camera.Position = frame.Eye;
                    Camera.Yaw = frame.Yaw;
                    Camera.Pitch = frame.Pitch;
                }
                Camera.ViewportWidth = width;
                Camera.ViewportHeight = height;
                Camera.Aspect = (float)width / Math.Max(height, 1);
                Camera.Update();

                _clashShot = true;
                RenderScene(width, height, target, samples, photo: true);
                if (target.Samples > 0)
                {
                    resolve.Ensure(width, height, 0);
                    target.ResolveTo(resolve);
                    resolve.ReadPixels(pixels);
                }
                else
                {
                    target.ReadPixels(pixels);
                }
                return true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Clash picture failed: {ex.Message}");
                return false;
            }
            finally
            {
                _clashShot = false;
                _clashMultiSuspended = multiSuspended;
                _clashCurrent = current;
                _clashElementA = elementA;
                _clashElementB = elementB;
                _clashDynamicA = dynamicA;
                _clashDynamicB = dynamicB;
                if (framed) { SetSectionQuiet(section); }
                Camera.Position = position;
                Camera.Yaw = yaw;
                Camera.Pitch = pitch;
                Camera.ViewportWidth = viewportW;
                Camera.ViewportHeight = viewportH;
                Camera.Aspect = aspect;
                Camera.Update();
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
                Gl.Viewport(0, 0, _window.Width, _window.Height);
            }
        }

        #endregion

        #region Row pictures

        /// <summary>
        /// A row's picture (0 = none yet): the cached texture, even a stale one, while a missing or stale one is asked for
        /// (rendered at the start of the next frame).
        /// </summary>
        private uint ClashThumbnailTexture(ClashRecord clash)
        {
            if (_clashThumbs.TryGetValue(clash, out (uint Texture, int Version) cached))
            {
                if (cached.Version != _clashThumbVersion) { _clashThumbWanted.Add(clash); }
                return cached.Texture;
            }
            _clashThumbWanted.Add(clash);
            return 0;
        }

        /// <summary>Marks one clash's row picture stale (GO visited it: taken again).</summary>
        private void InvalidateClashThumbnail(ClashRecord clash)
        {
            if (clash != null && _clashThumbs.TryGetValue(clash, out (uint Texture, int Version) cached)) { _clashThumbs[clash] = (cached.Texture, -1); }
        }

        /// <summary>Renders one row picture at 320 × 180, halves it to 160 × 90 and uploads it.</summary>
        private unsafe void RenderClashThumbnail(ClashRecord clash)
        {
            _clashThumbTarget ??= new RenderTarget();
            _clashThumbRender ??= new byte[CLASH_THUMB_RENDER_W * CLASH_THUMB_RENDER_H * 4];
            _clashThumbPixels ??= new byte[CLASH_THUMB_W * CLASH_THUMB_H * 4];
            _clashThumbTarget.Ensure(CLASH_THUMB_RENDER_W, CLASH_THUMB_RENDER_H, 0);
            if (!RenderClashPicture(clash, CLASH_THUMB_RENDER_W, CLASH_THUMB_RENDER_H, 0, _clashThumbTarget, null, _clashThumbRender,
                framed: true, out _, out _))
            {
                // Don't ask again this version (a broken one would otherwise render every frame)
                _clashThumbs[clash] = (_clashThumbs.TryGetValue(clash, out (uint Texture, int Version) old) ? old.Texture : 0u, _clashThumbVersion);
                return;
            }

            // 2 × 2 box filter, bottom-up rows in, top-down rows out (as the UI draws textures)
            const int SW = CLASH_THUMB_RENDER_W, SH = CLASH_THUMB_RENDER_H;
            for (int ty = 0; ty < CLASH_THUMB_H; ty++)
            {
                int row0 = (SH - 1 - ty * 2) * SW, row1 = (SH - 2 - ty * 2) * SW;
                for (int tx = 0; tx < CLASH_THUMB_W; tx++)
                {
                    int a = (row0 + tx * 2) * 4, b = (row1 + tx * 2) * 4, o = (ty * CLASH_THUMB_W + tx) * 4;
                    for (int c = 0; c < 3; c++)
                    {
                        _clashThumbPixels[o + c] = (byte)((_clashThumbRender[a + c] + _clashThumbRender[a + 4 + c] + _clashThumbRender[b + c] + _clashThumbRender[b + 4 + c] + 2) >> 2);
                    }
                    _clashThumbPixels[o + 3] = 255;
                }
            }

            if (!_clashThumbs.TryGetValue(clash, out (uint Texture, int Version) entry) || entry.Texture == 0)
            {
                if (entry.Texture == 0 && _clashThumbs.Count >= CLASH_THUMB_CACHE_MAX) { ReleaseClashThumbnails(); }
                uint created = Gl.GenTexture();
                Gl.BindTexture(Gl.TEXTURE_2D, created);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
                entry = (created, -1);
            }
            Gl.BindTexture(Gl.TEXTURE_2D, entry.Texture);
            Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
            fixed (byte* p = _clashThumbPixels)
            {
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, CLASH_THUMB_W, CLASH_THUMB_H, Gl.BGRA, Gl.UNSIGNED_BYTE, p);
            }
            Gl.BindTexture(Gl.TEXTURE_2D, 0);
            _clashThumbs[clash] = (entry.Texture, _clashThumbVersion);
        }

        /// <summary>PICTURES: row pictures on / off (remembered per machine).</summary>
        private void ToggleClashThumbnails()
        {
            _clashThumbsOn = !_clashThumbsOn;
            if (!_clashThumbsOn) { ReleaseClashThumbnails(); }
            _clashScrollToCurrent = true;
            RefreshClashViewLabels();
            Sound.Play(SoundId.UiClick);
            Toast(_clashThumbsOn ? "Clash list: a picture on each row" : "Clash list: text rows (more on screen)", 2f);
        }

        /// <summary>Frees every row picture (they are taken again as rows show).</summary>
        private void ReleaseClashThumbnails()
        {
            foreach ((uint texture, int _) in _clashThumbs.Values)
            {
                if (texture != 0) { Gl.DeleteTexture(texture); }
            }
            _clashThumbs.Clear();
        }

        /// <summary>Frees the row pictures and the off-screen targets (session end).</summary>
        private void ReleaseClashPictures()
        {
            ReleaseClashThumbnails();
            _clashThumbTarget?.Dispose();
            _clashThumbTarget = null;
            ReleaseClashShotTargets();
        }

        private void ReleaseClashShotTargets()
        {
            _clashShotTarget?.Dispose();
            _clashShotResolve?.Dispose();
            _clashShotTarget = _clashShotResolve = null;
            _clashShotPixels = null;
        }

        #endregion

        #region TO COMMENT

        /// <summary>
        /// TO COMMENT (C-B3): the selected clashes (or the current one) → comments, one per clash. Clashes without a
        /// comment get one straight away; when some already have one, a choice: UPDATE THEM (new picture, view, section,
        /// status; text and replies stay; marked-up pictures only with the tick), NEW ONLY (just the missing ones) or
        /// CANCEL. A single current clash is pictured as you see it; several are each framed on their own.
        /// </summary>
        private void ClashToComment()
        {
            if (_clashCurrent == null)
            {
                Sound.Play(SoundId.Error);
                Toast("Pick a clash first", 2f);
                return;
            }
            if (Comments == null)
            {
                Sound.Play(SoundId.Error);
                Toast("Comments aren't available in this session", 3f, important: true);
                return;
            }
            if (_clashBatch != null) { return; }

            List<ClashRecord> targets = ClashTargets().ToList(); // as selected now (the confirm may come later)
            int existing = 0, markedUp = 0;
            foreach (ClashRecord clash in targets)
            {
                CommentRecord comment = FindClashComment(clash);
                if (comment == null) { continue; }
                existing++;
                if (comment.HasMarkup) { markedUp++; }
            }
            if (existing == 0)
            {
                MakeClashComments(targets, update: false, replaceMarkup: false);
                return;
            }

            int count = targets.Count, missing = count - existing;
            string message = count == 1
                ? "This clash already has a comment. UPDATE gives it a new picture, view, section and status (its text and replies stay)."
                : $"{existing} of the {count} selected clashes already have a comment. UPDATE THEM gives those a new picture, view, section and status (text and replies stay)" +
                  (missing > 0 ? $" and makes the {missing} missing; NEW ONLY makes just the {missing} missing." : ".");
            string tick = markedUp > 0 ? $"Replace marked-up pictures too ({markedUp})" : null;
            OpenChoice(count == 1 ? "UPDATE COMMENT?" : "UPDATE COMMENTS?", message, count == 1 ? "UPDATE" : "UPDATE THEM", danger: false, tick,
                missing > 0 ? "NEW ONLY" : null,
                replace => MakeClashComments(targets, update: true, replaceMarkup: replace),
                _ => MakeClashComments(targets, update: false, replaceMarkup: false));
        }

        /// <summary>
        /// Starts making the comments: one current clash from the view on screen (next frame), several through the
        /// batch (each framed on its own). <paramref name="update"/> false leaves clashes that have a comment alone.
        /// </summary>
        private void MakeClashComments(IReadOnlyList<ClashRecord> targets, bool update, bool replaceMarkup)
        {
            if (targets.Count == 1 && targets[0] == _clashCurrent && !ClashMultiActive)
            {
                if (!update && FindClashComment(_clashCurrent) != null) { return; }
                _clashCommentPending = replaceMarkup ? 2 : 1;
                return;
            }
            StartClashBatch(targets, update, replaceMarkup);
        }

        /// <summary>The card's button with several selected: "3 TO COMMENTS" (rebuilt when the count changes).</summary>
        private string ClashCommentsLabel()
        {
            if (_clashCommentsLabelFor != _clashSelected.Count || _clashCommentsLabel == null)
            {
                _clashCommentsLabelFor = _clashSelected.Count;
                _clashCommentsLabel = $"{_clashSelected.Count} TO COMMENTS";
            }
            return _clashCommentsLabel;
        }

        /// <summary>
        /// MARKUP / the row pencil (C-B3): the markup editor on a clash's comment picture; DONE or Esc returns to clash
        /// mode on the same clash.
        /// </summary>
        private void OpenClashMarkup(ClashRecord clash)
        {
            CommentRecord comment = FindClashComment(clash);
            if (comment == null)
            {
                Sound.Play(SoundId.Error);
                Toast("This clash has no comment yet: TO COMMENT makes one (with its picture)", 3f);
                return;
            }
            if (comment.SnapshotData == null && comment.SnapshotOriginalData == null)
            {
                Sound.Play(SoundId.Error);
                Toast("This clash's comment has no picture: UPDATE COMMENT takes one", 3f);
                return;
            }
            OpenMarkup(comment, returnToGame: true);
        }

        /// <summary>
        /// The pencil on a clash row whose comment has a picture (C-B3): a dark disc with a drawn pencil.
        /// </summary>
        /// <returns>True when it was clicked (the click is consumed: the row isn't picked).</returns>
        private bool ClashCommentPencil(FontAtlas f, InputState input, float cx, float cy, ClashRecord clash) =>
            CommentPencil(input, cx, cy, FindClashComment(clash));

        /// <summary>
        /// A comment's pencil (C-B3; groups since the C-C1 feedback): drawn only when the comment has a picture; amber
        /// when the picture already has markup.
        /// </summary>
        /// <returns>True when it was clicked (the click is consumed: the row isn't picked).</returns>
        private bool CommentPencil(InputState input, float cx, float cy, CommentRecord comment)
        {
            if (comment == null || (comment.SnapshotData == null && comment.SnapshotOriginalData == null && comment.Thumbnail == null)) { return false; }
            float r = S(11);
            bool hover = Hover(input, cx - r, cy - r, r * 2f, r * 2f);
            _ui.Circle(cx, cy, r, hover ? Rgba.Hex(0x22D3EE, 0.95f) : Rgba.Hex(0x0B1220, 0.85f), 16);
            uint ink = hover ? Rgba.Hex(0x06232A) : comment.HasMarkup ? Rgba.Hex(0xF59E0B) : Rgba.Hex(0xFFFFFF);
            float s = r * 0.62f;
            _ui.Line(cx - s * 0.55f, cy + s * 0.55f, cx + s * 0.6f, cy - s * 0.6f, MathF.Max(2f, S(3f)), ink); // the body
            _ui.Line(cx - s * 0.8f, cy + s * 0.8f, cx - s * 0.55f, cy + s * 0.55f, MathF.Max(1f, S(1.5f)), ink); // the tip
            if (hover && input.LeftPressed)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
                return true;
            }
            return false;
        }

        /// <summary>Makes or updates the current clash's comment from what is on screen (start of a frame).</summary>
        private void MakeCurrentClashComment(bool replaceMarkup)
        {
            ClashRecord clash = _clashCurrent;
            if (clash == null || Comments == null || _clashDocument == null) { return; }

            // Mid-flight: the picture comes from where the flight ends
            bool framed = _clashFlying;
            if (!EnsureClashShotTargets()) { return; }
            bool rendered = RenderClashPicture(clash, CLASH_SHOT_W, CLASH_SHOT_H, 4, _clashShotTarget, _clashShotResolve, _clashShotPixels,
                framed, out ClashView frame, out SectionCut cut);
            if (!rendered)
            {
                ReleaseClashShotTargets();
                Sound.Play(SoundId.Error);
                Toast("The clash picture couldn't be taken (see the log)", 3f, important: true);
                return;
            }

            int outcome = MakeClashComment(clash, _clashShotPixels, CLASH_SHOT_W, CLASH_SHOT_H, frame, cut, replaceMarkup);
            ReleaseClashShotTargets();
            Comments.Save();
            ClashesChanged();
            _clashListDirty = true;
            _clashRowsDirty = true;
            Sound.Play(SoundId.Commit);
            Toast(outcome switch
            {
                CLASH_COMMENT_CREATED => "Comment made from the clash (Esc → COMMENTS · EXPORT BCF)",
                CLASH_COMMENT_KEPT => "The clash's comment updated (its marked-up picture kept)",
                _ => "The clash's comment updated: new picture, view and status"
            }, 3f);
        }

        // MakeClashComment's outcomes
        private const int CLASH_COMMENT_CREATED = 0, CLASH_COMMENT_UPDATED = 1, CLASH_COMMENT_KEPT = 2;

        /// <summary>
        /// Makes a clash's comment, or updates the one it has (picture, view and section, status, assignee), from a
        /// rendered picture (bottom-up BGRA). Doesn't save the comments (the caller does).
        /// </summary>
        /// <param name="replaceMarkup">Replace a marked-up picture (false: keep it, update the rest).</param>
        /// <returns><see cref="CLASH_COMMENT_CREATED"/>, <see cref="CLASH_COMMENT_UPDATED"/> or <see cref="CLASH_COMMENT_KEPT"/>.</returns>
        private int MakeClashComment(ClashRecord clash, byte[] pixels, int width, int height, ClashView frame, SectionCut cut, bool replaceMarkup)
        {
            ClashTest test = _clashDocument.FindTest(clash.TestId);
            string status = ClashCommentRules.CommentStatusFor(clash.Status);
            CommentRecord record = FindClashComment(clash);
            int outcome;
            if (record == null)
            {
                Vector3 origin = Scene.OriginOffset;
                var point = new Vector3((float)(clash.X - origin.X), (float)(clash.Y - origin.Y), (float)(clash.Z - origin.Z));
                bool hostA = string.IsNullOrEmpty(clash.A.Link) && clash.A.CloneKey == 0;
                record = Comments.Add(point, ClashCommentText(clash, test), hostA ? clash.A.ElementId : -1, ClashLevel(clash),
                    hostA ? clash.A.UniqueId : null, save: false);
                record.ClashId = clash.Id;
                record.Status = status;
                record.Priority = ClashCommentRules.PriorityFor(clash, test?.Kind);
                record.AssignedTo = string.IsNullOrWhiteSpace(clash.AssignedTo) ? null : clash.AssignedTo.Trim();
                clash.CommentId = record.Id;
                outcome = CLASH_COMMENT_CREATED;
            }
            else
            {
                Comments.SetIssue(record, status: status, assignedTo: string.IsNullOrWhiteSpace(clash.AssignedTo) ? null : clash.AssignedTo, save: false);
                record.ClashId ??= clash.Id;
                outcome = CLASH_COMMENT_UPDATED;
            }

            Comments.SetView(record, frame.Eye - Vector3.UnitZ * _player.Controller.StandEye, frame.Yaw, frame.Pitch, flying: true, save: false, section: cut);
            if (record.HasMarkup && !replaceMarkup) { return CLASH_COMMENT_KEPT; }

            string thumbnail = Convert.ToBase64String(EncodeJpeg(pixels, width, height, THUMB_WIDTH, THUMB_HEIGHT, THUMB_JPEG_QUALITY));
            byte[] snapshot = EncodeJpeg(pixels, width, height, width, height, SNAPSHOT_JPEG_QUALITY);
            Comments.SetPictures(record, thumbnail, snapshot, save: false);
            return outcome;
        }

        /// <summary>
        /// A clash comment's text: "Clash: test · A × B · crossing 32 mm · Level 2" (grids round B: " · Near C-4 : Level 2"
        /// when the grids panel's "In clash comments" is on), then the clash's notes.
        /// </summary>
        private string ClashCommentText(ClashRecord clash, ClashTest test)
        {
            string text = $"Clash: {test?.Name ?? "clash test"} · {clash.A.Label} × {clash.B.Label} · {ClashAmount(clash)} · {ClashLevel(clash)}" +
                (_grids.ClashComments ? ClashGridSuffix(clash, offset: false) : string.Empty);
            return string.IsNullOrWhiteSpace(clash.Notes) ? text : text + " · Notes: " + clash.Notes.Trim();
        }

        /// <summary>The clash's comment, or null (none made, or it was deleted).</summary>
        private CommentRecord FindClashComment(ClashRecord clash) =>
            clash == null || string.IsNullOrEmpty(clash.CommentId) || Comments == null ? null : Comments.Find(clash.CommentId);

        /// <summary>The comment picture's targets and buffer (made on first use, freed after the comment or batch).</summary>
        private bool EnsureClashShotTargets()
        {
            try
            {
                _clashShotTarget ??= new RenderTarget();
                _clashShotResolve ??= new RenderTarget();
                _clashShotPixels ??= new byte[CLASH_SHOT_W * CLASH_SHOT_H * 4];
                _clashShotTarget.Ensure(CLASH_SHOT_W, CLASH_SHOT_H, 4);
                return true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Clash picture targets failed: {ex.Message}");
                ReleaseClashShotTargets();
                Sound.Play(SoundId.Error);
                Toast("The clash picture couldn't be set up on this GPU", 3f, important: true);
                return false;
            }
        }

        #endregion

        #region TO COMMENTS

        /// <summary>
        /// Several clashes → comments (C-B3: the selection, at most <see cref="ClashCommentRules.BATCH_LIMIT"/>), each
        /// framed on its own, a few per frame. <paramref name="update"/> false skips clashes that already have one.
        /// </summary>
        private void StartClashBatch(IReadOnlyList<ClashRecord> targets, bool update, bool replaceMarkup)
        {
            var batch = new List<ClashRecord>(Math.Min(targets.Count, ClashCommentRules.BATCH_LIMIT));
            foreach (ClashRecord clash in targets)
            {
                if (batch.Count >= ClashCommentRules.BATCH_LIMIT) { break; }
                if (update || FindClashComment(clash) == null) { batch.Add(clash); }
            }
            if (batch.Count == 0 || !EnsureClashShotTargets()) { return; }
            _clashBatch = batch;
            _clashBatchReplace = replaceMarkup;
            _clashBatchNext = _clashBatchCreated = _clashBatchUpdated = _clashBatchKept = _clashBatchFailed = 0;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The next TO COMMENTS pictures (as many as fit the frame's budget, at least one).</summary>
        private void StepClashBatch()
        {
            _clashPictureClock.Restart();
            while (_clashBatchNext < _clashBatch.Count)
            {
                ClashRecord clash = _clashBatch[_clashBatchNext++];
                if (RenderClashPicture(clash, CLASH_SHOT_W, CLASH_SHOT_H, 4, _clashShotTarget, _clashShotResolve, _clashShotPixels,
                    framed: true, out ClashView frame, out SectionCut cut))
                {
                    switch (MakeClashComment(clash, _clashShotPixels, CLASH_SHOT_W, CLASH_SHOT_H, frame, cut, _clashBatchReplace))
                    {
                        case CLASH_COMMENT_CREATED: _clashBatchCreated++; break;
                        case CLASH_COMMENT_KEPT: _clashBatchKept++; break;
                        default: _clashBatchUpdated++; break;
                    }
                }
                else
                {
                    _clashBatchFailed++;
                }
                if (_clashBatchNext % CLASH_BATCH_SAVE_EVERY == 0) { Comments.Save(); }
                if (_clashPictureClock.Elapsed.TotalMilliseconds > CLASH_PICTURE_BUDGET_MS) { break; }
            }
            if (_clashBatchNext >= _clashBatch.Count) { FinishClashBatch(cancelled: false); }
        }

        /// <summary>Ends TO COMMENTS (done or cancelled: the comments made stay), saves and says what happened.</summary>
        private void FinishClashBatch(bool cancelled)
        {
            if (_clashBatch == null) { return; }
            int total = _clashBatch.Count, done = _clashBatchNext;
            _clashBatch = null;
            ReleaseClashShotTargets();
            Comments?.Save();
            ClashesChanged();
            _clashListDirty = true;
            _clashRowsDirty = true;

            Sound.Play(cancelled ? SoundId.UiClick : SoundId.Commit);
            string made = $"{_clashBatchCreated:N0} made, {_clashBatchUpdated + _clashBatchKept:N0} updated" +
                (_clashBatchKept > 0 ? $" ({_clashBatchKept:N0} kept their marked-up picture)" : string.Empty) +
                (_clashBatchFailed > 0 ? $", {_clashBatchFailed:N0} without a picture (see the log)" : string.Empty);
            Toast(cancelled ? $"Comments stopped at {done:N0} of {total:N0}: {made}" : $"Clash comments: {made} (Esc → COMMENTS · EXPORT BCF)",
                5f, important: _clashBatchFailed > 0);
        }

        /// <summary>
        /// The dock's progress while TO COMMENTS runs (in place of the current clash's card details), with CANCEL.
        /// </summary>
        /// <returns>The height used.</returns>
        private float BuildClashBatchProgress(FontAtlas f, InputState input, float x, float y, float w)
        {
            int total = Math.Max(1, _clashBatch.Count);
            Text.Clear().Append("MAKING COMMENTS · ").Append(_clashBatchNext).Append(" OF ").AppendGrouped(_clashBatch.Count);
            _ui.Text(f.Small, x, y, Text.Span, UiTheme.ACCENT, S(1.2f));
            float barY = y + S(24);
            _ui.Rect(x, barY, w, S(8), UiTheme.CONTROL);
            _ui.Rect(x, barY, w * Math.Clamp((float)_clashBatchNext / total, 0f, 1f), S(8), UiTheme.ACCENT);
            _ui.TextWrapped(f.Small, x, barY + S(16), w, "Each clash is framed, pictured and saved as a comment. The ones made stay if you cancel.", UiTheme.TEXT_MUTED, maxLines: 2);
            if (SmallButton(f, input, x, barY + S(54), MathF.Min(w, S(140)), S(28), "CANCEL")) { FinishClashBatch(cancelled: true); }
            return S(24) + S(54) + S(34);
        }

        #endregion

        #region Status sync

        /// <summary>
        /// Makes a clash's comment show the clash's status (clash → comment, one way).
        /// </summary>
        /// <returns>True when the comment changed.</returns>
        private bool SyncClashComment(ClashRecord clash, bool save)
        {
            CommentRecord record = FindClashComment(clash);
            return record != null && Comments.SetIssue(record, status: ClashCommentRules.CommentStatusFor(clash.Status), save: save);
        }

        /// <summary>
        /// After a run or an imported report: every linked comment follows its clash's status, and every group comment
        /// its group's (C-C1); one save.
        /// </summary>
        private void SyncClashComments()
        {
            if (_clashDocument == null || Comments == null) { return; }
            bool changed = false;
            foreach (ClashRecord clash in _clashDocument.Clashes)
            {
                if (!string.IsNullOrEmpty(clash.CommentId)) { changed |= SyncClashComment(clash, save: false); }
            }
            changed |= SyncClashGroupComments();
            if (changed) { Comments.Save(); }
        }

        #endregion
    }
}
