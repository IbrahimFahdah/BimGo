using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Native;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash grouping tools (Round C, build C-C2), from the dock's TOOLS ▾ (and the row menus). One tool at a time; each
    /// shows a bar at the bottom of the view (Enter commits, Esc leaves) and draws the clashes the list shows as dots seen
    /// through walls (the nearest <see cref="CLASH_TOOL_DOTS"/>, dimmer when hidden).
    /// <list type="bullet">
    /// <item><b>GROUP BY BOX…</b>: the section box itself, sized with the section editor's face handles (Shift: free);
    /// the dock folds away, RMB-drag orbits the box, the wheel zooms, the move keys fly (the orbit follows), FIT VIEW frames
    /// it. FULL HEIGHT makes it a plan rectangle catching clashes stacked on every level. Clashes inside light up amber
    /// with a live count; GROUP IN BOX (n) makes a group of the shown clashes inside and the group keeps the box. The cut
    /// you had comes back afterwards. <b>EDIT BOX…</b> (a group row's menu) reopens it on a group; committing updates the
    /// box and recollects.</item>
    /// <item><b>RECOLLECT FROM ITS BOX</b>: the test's open clashes inside the group's box join it (moved from other groups,
    /// the toast says so); when members now lie outside, a prompt offers REMOVE n / KEEP.</item>
    /// <item><b>PICK POINTS</b>: click a dot to pick / unpick it (a list row too), Ctrl+drag a marquee adds; the picks are
    /// the list selection. NEW GROUP (Enter) / ADD TO GROUP › / CLEAR / DONE.</item>
    /// <item><b>CLUSTER AROUND…</b>: a sphere centred on a clash, sized by the handle on its edge (in the XY plane, across the
    /// view; 0.05 m steps, Shift: free); the shown clashes inside it light up; click another dot (or row) to move the
    /// centre. GROUP (Enter) names it "Cluster N · Level × n clashes".</item>
    /// </list>
    /// Grouping by hand moves clashes out of other groups (the toast says how many), as GROUP SELECTED does.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const int CLASH_TOOL_NONE = 0, CLASH_TOOL_BOX = 1, CLASH_TOOL_PICK = 2, CLASH_TOOL_SPHERE = 3;

        /// <summary>The most clash dots a tool draws (the nearest to the eye).</summary>
        private const int CLASH_TOOL_DOTS = 2000;

        /// <summary>The cluster sphere's handle snaps to this step (m) unless the free-drag key is held.</summary>
        private const float CLASH_SPHERE_SNAP = 0.05f;

        private const int DROP_DOCK_TOOL_ADD = 20; // the PICK POINTS bar's ADD TO GROUP › list

        private int _clashTool;

        // The bar: where it is (clicks there don't reach the view), the button picked this frame, cached labels
        private Vector4 _clashToolBarRect;
        private int _clashToolBarAction;
        private const int BAR_NONE = 0, BAR_COMMIT = 1, BAR_CANCEL = 2, BAR_FULL_HEIGHT = 3, BAR_FIT = 4, BAR_CLEAR = 5;
        private string _clashToolTitle, _clashToolStatus, _clashToolCommitLabel;
        private int _clashToolLabelCount = -1;
        private float _clashToolLabelRadius = -1f;
        private int _clashToolLabelUnits = -1;

        // GROUP BY BOX…: the group being edited (null: a new group), the cut before, full height and its heights
        private ClashGroup _clashBoxGroup;
        private SectionCut _clashBoxSaved;
        private bool _clashBoxFullHeight;
        private float _clashBoxMinZ, _clashBoxMaxZ;
        private int _clashBoxInside;

        // The orbit round the box: its target (scene-local) and the eye it last placed (the flight moves both)
        private Vector3 _clashOrbitTarget, _clashOrbitLastEye;

        // The dots: the nearest shown clashes (rebuilt when the list changes or the eye moves a metre)
        private readonly List<ClashRecord> _clashToolDots = new();
        private float[] _clashDotKeys = Array.Empty<float>();
        private int[] _clashDotOrder = Array.Empty<int>();
        private bool _clashToolDotsDirty = true;
        private Vector3 _clashToolDotsEye;

        // The dot under the mouse and its label (built when it changes)
        private ClashRecord _clashToolHover;
        private string _clashToolHoverText;

        // PICK POINTS: the Ctrl+drag marquee
        private bool _clashMarquee;
        private Vector2 _clashMarqueeFrom;

        // CLUSTER AROUND…: the centre clash, the radius (kept for the session), the clashes inside, the handle
        private ClashRecord _clashSphereSeed;
        private float _clashSphereRadius = 1f;
        private readonly List<ClashRecord> _clashSphereMembers = new();
        private readonly HashSet<ClashRecord> _clashSphereLookup = new();
        private int _clashSphereElsewhere;
        private bool _clashSphereDirty = true;
        private bool _clashSphereHandleHover, _clashSphereDragging;
        private Vector3 _clashSphereAxis;

        private Overlay3D _clashToolOverlay;

        #endregion

        #region Start / leave

        /// <summary>The eye (scene-local) as the player stands or flies.</summary>
        private Vector3 PlayerEye => _player.Feet + Vector3.UnitZ * _player.Controller.StandEye;

        /// <summary>Starts a tool (leaving the one that was on): closes lists, stops typing and flying.</summary>
        private void BeginClashTool(int tool)
        {
            if (_clashTool != CLASH_TOOL_NONE) { LeaveClashTool(); }
            CloseOverlay();
            _clashSearchFocused = false;
            _clashFlying = false;
            _clashTool = tool;
            _clashToolDotsDirty = true;
            _clashToolHover = null;
            _clashToolLabelCount = -1;
            _clashMarquee = false;
            _window.Input.ReleaseAll();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>Leaves the tool: the box tool puts the cut back as it was.</summary>
        private void LeaveClashTool()
        {
            if (_clashTool == CLASH_TOOL_NONE) { return; }
            if (_clashTool == CLASH_TOOL_BOX)
            {
                _sectionDrag = _sectionHover = -1;
                _section = (_clashBoxSaved ?? new SectionCut()).Clone().Clean();
                SectionChanged();
                _clashBoxSaved = null;
                _clashBoxGroup = null;
            }
            _clashTool = CLASH_TOOL_NONE;
            _clashToolBarRect = default;
            _clashMarquee = false;
            _clashSphereDragging = false;
            _clashSphereSeed = null;
            _clashToolHover = null;
            _window.Input.ReleaseAll();
        }

        /// <summary>Esc / CANCEL / DONE: leaves the tool with a word.</summary>
        private void CancelClashTool()
        {
            int tool = _clashTool;
            LeaveClashTool();
            Sound.Play(SoundId.UiClick);
            Toast(tool == CLASH_TOOL_PICK ? "Pick points off (the picks stay selected)" : tool == CLASH_TOOL_BOX ? "Box grouping cancelled (the cut is as it was)" : "Cluster cancelled", 2f);
        }

        /// <summary>Enter / the bar's main button: commits the tool.</summary>
        private void CommitClashTool()
        {
            switch (_clashTool)
            {
                case CLASH_TOOL_BOX: CommitClashBox(); break;
                case CLASH_TOOL_PICK: CommitClashPicks(); break;
                case CLASH_TOOL_SPHERE: CommitClashSphere(); break;
            }
        }

        #endregion

        #region Frame

        /// <summary>
        /// A tool's keys and mouse (in place of clash mode's own): Esc closes a list or leaves, Enter commits, the clash
        /// mode key leaves clash mode; the mouse works the view unless it is over the dock or the bar.
        /// </summary>
        private void UpdateClashTool(InputState input, float dt)
        {
            if (input.Pressed(InputAction.Back))
            {
                if (CloseOverlay()) { return; }
                if (_clashMarquee) { _clashMarquee = false; return; }
                CancelClashTool();
                return;
            }
            if (input.Pressed(InputAction.ClashMode))
            {
                ExitClashMode();
                return;
            }
            if (_clashTool == CLASH_TOOL_PICK && input.Pressed(InputAction.ClashPickPoints)) // P-B: K again leaves pick points
            {
                CancelClashTool();
                return;
            }
            if (input.Pressed(InputAction.Help)) { _showHelp = !_showHelp; }
            if (input.Pressed(InputAction.HideUi)) { ToggleUiHidden(); }
            if (input.Pressed(InputAction.Fullscreen)) { _window.ToggleFullscreen(); }
            if (input.Pressed(InputAction.Screenshot)) { RequestScreenshot(); }
            if (input.Pressed(InputAction.ClashView)) { SetClashView((_clashView + 1) % CLASH_VIEW_NAMES.Length); } // C-C3: G stays live
            if (input.Pressed(InputAction.ClashFrame) && !OverlayOpen)
            {
                CommitClashTool();
                return;
            }

            // RMB pressed over the dock opens a row menu, not a look (as in clash mode)
            if (input.RightPressed && OverClashDock(input.MousePosition)) { _clashMenuLook = true; }
            if (!input.RightDown) { _clashMenuLook = false; }
            bool overUi = OverlayOpen || OverClashDock(input.MousePosition) || OverClashToolBar(input.MousePosition);

            switch (_clashTool)
            {
                case CLASH_TOOL_BOX: UpdateClashBoxTool(input, overUi); break;
                case CLASH_TOOL_PICK: UpdateClashPickTool(input, overUi); break;
                case CLASH_TOOL_SPHERE: UpdateClashSphereTool(input, overUi); break;
            }
            UpdateRoom();
            AdvanceClashFlight(dt);
        }

        private bool OverClashDock(Vector2 mouse) =>
            (_clashDockW > 0f && mouse.X >= _clashDockX && mouse.X < _clashDockX + _clashDockW && mouse.Y >= _clashDockY && mouse.Y < _clashDockY + _clashDockH)
            || OverGridsPanel(mouse); // grids round A: the grids panel beside the dock takes its clicks too

        private bool OverClashToolBar(Vector2 mouse) =>
            _clashToolBarRect.Z > 0f && mouse.X >= _clashToolBarRect.X && mouse.X < _clashToolBarRect.X + _clashToolBarRect.Z
            && mouse.Y >= _clashToolBarRect.Y && mouse.Y < _clashToolBarRect.Y + _clashToolBarRect.W;

        /// <summary>RMB-drag looks (pick points and cluster), unless it began over the dock.</summary>
        private void ClashToolLook(InputState input)
        {
            if (input.Down(InputAction.DragLook) && !_clashFlying && !_clashMenuLook) { _player.Look(input.MouseDeltaX, input.MouseDeltaY, _sensitivity, _invertY); }
        }

        /// <summary>A clash point, scene-local.</summary>
        private Vector3 ClashLocal(ClashRecord clash)
        {
            Vector3 origin = Scene.OriginOffset;
            return new Vector3((float)(clash.X - origin.X), (float)(clash.Y - origin.Y), (float)(clash.Z - origin.Z));
        }

        #endregion

        #region Dots

        /// <summary>
        /// The dots to draw and pick: every shown clash, or the nearest <see cref="CLASH_TOOL_DOTS"/> to the eye (rebuilt
        /// when the list changed or the eye moved more than a metre; the sort arrays are kept between rebuilds).
        /// </summary>
        private void RefreshClashToolDots()
        {
            Vector3 eye = Camera.Position;
            if (!_clashToolDotsDirty && Vector3.DistanceSquared(eye, _clashToolDotsEye) < 1f) { return; }
            _clashToolDotsDirty = false;
            _clashToolDotsEye = eye;
            _clashToolDots.Clear();
            int count = _clashList.Count;
            if (count <= CLASH_TOOL_DOTS)
            {
                _clashToolDots.AddRange(_clashList);
                return;
            }
            if (_clashDotKeys.Length < count)
            {
                _clashDotKeys = new float[count];
                _clashDotOrder = new int[count];
            }
            for (int i = 0; i < count; i++)
            {
                _clashDotKeys[i] = Vector3.DistanceSquared(eye, ClashLocal(_clashList[i]));
                _clashDotOrder[i] = i;
            }
            Array.Sort(_clashDotKeys, _clashDotOrder, 0, count);
            for (int i = 0; i < CLASH_TOOL_DOTS; i++) { _clashToolDots.Add(_clashList[_clashDotOrder[i]]); }
        }

        /// <summary>The dot nearest the mouse within 12 px (null: none, or over the dock / bar), and its label.</summary>
        private void UpdateClashToolHover(Vector2 mouse, bool overUi)
        {
            ClashRecord best = null;
            if (!overUi)
            {
                RefreshClashToolDots();
                float bestDistance = S(12) * S(12);
                foreach (ClashRecord clash in _clashToolDots)
                {
                    if (!Camera.WorldToScreen(ClashLocal(clash), out Vector2 screen)) { continue; }
                    float d = Vector2.DistanceSquared(screen, mouse);
                    if (d < bestDistance)
                    {
                        bestDistance = d;
                        best = clash;
                    }
                }
            }
            if (best == _clashToolHover) { return; }
            _clashToolHover = best;
            if (best == null) { _clashToolHoverText = null; return; }
            ClashGroup group = ClashGroupOf(best);
            _clashToolHoverText = $"{best.A.Label}  ×  {best.B.Label} · {ClashStatus.Label(best.Status).ToLowerInvariant()} · {ClashLevel(best)}" +
                (group == null ? string.Empty : $" · in “{Shorten(ClashGroups.DisplayName(group), 30)}”");
        }

        #endregion

        #region GROUP BY BOX…

        /// <summary>
        /// GROUP BY BOX… (null) or EDIT BOX… (a group): the section box round the group's box, the group's members, the
        /// selected clashes or the current one (1 m margin), else 4 × 4 m in front of you; the dock folds away and the view
        /// frames the box.
        /// </summary>
        private void BeginClashBoxTool(ClashGroup group)
        {
            if (_clashDocument == null) { return; }
            BeginClashTool(CLASH_TOOL_BOX);
            _clashBoxGroup = group;
            _clashBoxSaved = _section.Clone();
            _clashBoxFullHeight = group?.Box?.FullHeight ?? false;

            Vector3 origin = Scene.OriginOffset;
            Vector3 min, max;
            if (group?.Box != null)
            {
                min = new Vector3((float)group.Box.MinX, (float)group.Box.MinY, (float)group.Box.MinZ) - origin;
                max = new Vector3((float)group.Box.MaxX, (float)group.Box.MaxY, (float)group.Box.MaxZ) - origin;
            }
            else
            {
                IReadOnlyList<ClashRecord> around = group != null ? AllClashGroupMembers(group) : ClashTargets();
                if (around.Count > 0)
                {
                    Aabb box = Aabb.Empty;
                    foreach (ClashRecord clash in around) { box.Include(ClashLocal(clash)); }
                    min = box.Min - new Vector3(1f);
                    max = box.Max + new Vector3(1f);
                }
                else
                {
                    Vector3 eye = PlayerEye;
                    var forward = new Vector3(MathF.Cos(_player.Yaw), MathF.Sin(_player.Yaw), 0f);
                    Vector3 centre = eye + forward * 4f;
                    min = new Vector3(centre.X - 2f, centre.Y - 2f, _player.Feet.Z - 0.3f);
                    max = new Vector3(centre.X + 2f, centre.Y + 2f, _player.Feet.Z + 3f);
                }
            }
            _clashBoxMinZ = min.Z;
            _clashBoxMaxZ = max.Z;
            if (_clashBoxFullHeight) { FullHeightZ(ref min, ref max); }

            _section.BoxOn = true;
            _section.PlaneOn = false;
            _section.BoxMin = ToRevit(min);
            _section.BoxMax = ToRevit(max);
            _section.Clean();
            SectionChanged();
            FitClashBoxView();
            Toast(group == null
                ? $"Group by box: drag the handles · RMB-drag orbits · wheel zooms · {Key(InputAction.ClashFrame)} groups the shown clashes inside · Esc cancels"
                : $"Edit the box of “{Shorten(ClashGroups.DisplayName(group), 40)}” · {Key(InputAction.ClashFrame)} updates it and recollects · Esc cancels", 4f);
        }

        /// <summary>Full height: the box runs from under the model to over it (the plan rectangle is what counts).</summary>
        private void FullHeightZ(ref Vector3 min, ref Vector3 max)
        {
            Aabb bounds = Scene.Bounds;
            min.Z = bounds.Min.Z - 1f;
            max.Z = bounds.Max.Z + 1f;
        }

        /// <summary>FULL HEIGHT on / off (off puts back the heights it had).</summary>
        private void ToggleClashBoxFullHeight()
        {
            Vector3 origin = Scene.OriginOffset;
            Vector3 min = _section.BoxMin - origin, max = _section.BoxMax - origin;
            _clashBoxFullHeight = !_clashBoxFullHeight;
            if (_clashBoxFullHeight)
            {
                _clashBoxMinZ = min.Z;
                _clashBoxMaxZ = max.Z;
                FullHeightZ(ref min, ref max);
            }
            else
            {
                min.Z = _clashBoxMinZ;
                max.Z = MathF.Max(_clashBoxMaxZ, _clashBoxMinZ + SectionCut.MIN_SIZE);
            }
            _section.BoxMin = ToRevit(min);
            _section.BoxMax = ToRevit(max);
            _section.Clean();
            SectionChanged();
            _sectionHover = _sectionDrag = -1;
            Sound.Play(SoundId.UiClick);
            Toast(_clashBoxFullHeight ? "Full height: a plan rectangle catching clashes on every level (side handles only)" : "Box heights back", 2.5f);
        }

        /// <summary>FIT VIEW: the orbit centre on the box, back far enough to see it all, looking down a little.</summary>
        private void FitClashBoxView()
        {
            Vector3 origin = Scene.OriginOffset;
            var box = new Aabb(_section.BoxMin - origin, _section.BoxMax - origin);
            if (_clashBoxFullHeight)
            {
                // Frame the plan rectangle at the height it was drawn, not the whole building's height
                box.Min.Z = _clashBoxMinZ;
                box.Max.Z = MathF.Max(_clashBoxMaxZ, _clashBoxMinZ + SectionCut.MIN_SIZE);
            }
            _clashOrbitTarget = box.Center;
            float distance = ClashFraming.DistanceToSee(box, _fov, Camera.Aspect);
            PlaceClashOrbit(_player.Yaw, -0.45f, distance);
        }

        /// <summary>Puts the eye on the orbit: looking at the target from <paramref name="distance"/> back.</summary>
        private void PlaceClashOrbit(float yaw, float pitch, float distance)
        {
            pitch = Math.Clamp(pitch, -1.55f, 1.55f);
            float cp = MathF.Cos(pitch);
            var forward = new Vector3(cp * MathF.Cos(yaw), cp * MathF.Sin(yaw), MathF.Sin(pitch));
            Vector3 eye = _clashOrbitTarget - forward * distance;
            _clashFlying = false;
            _player.TeleportTo(eye - Vector3.UnitZ * _player.Controller.StandEye, yaw, pitch);
            _clashOrbitLastEye = eye;
        }

        /// <summary>
        /// The box tool's mouse: drag a face handle (snapped; the free-drag key: free), RMB-drag orbits the target, the
        /// wheel zooms; the flight moves the eye and the target together.
        /// </summary>
        private void UpdateClashBoxTool(InputState input, bool overUi)
        {
            // The move keys fly: the orbit centre goes along (they pan)
            Vector3 eye = PlayerEye;
            _clashOrbitTarget += eye - _clashOrbitLastEye;
            _clashOrbitLastEye = eye;

            Vector2 mouse = input.MousePosition;
            if (_sectionDrag >= 0)
            {
                if (!input.LeftDown)
                {
                    _sectionDrag = -1;
                    Sound.Play(SoundId.Click);
                }
                else { DragHandle(mouse, input.Down(InputAction.SectionFreeDrag)); }
            }
            else
            {
                _sectionHover = overUi ? -1 : ClashBoxHandleUnder(mouse);
                if (input.LeftPressed && _sectionHover >= 0)
                {
                    input.ConsumeClicks();
                    BeginDrag(_sectionHover, mouse);
                }
            }

            // Orbit (RMB-drag) and zoom (wheel) round the target
            float distance = MathF.Max(0.5f, Vector3.Distance(eye, _clashOrbitTarget));
            if (input.Down(InputAction.DragLook) && !_clashMenuLook && (input.MouseDeltaX != 0f || input.MouseDeltaY != 0f))
            {
                _player.Look(input.MouseDeltaX, input.MouseDeltaY, _sensitivity, _invertY);
                PlaceClashOrbit(_player.Yaw, _player.Pitch, distance);
            }
            if (!overUi && input.Wheel != 0)
            {
                distance = Math.Clamp(distance * MathF.Pow(0.85f, input.Wheel), 0.5f, 2000f);
                PlaceClashOrbit(_player.Yaw, _player.Pitch, distance);
                input.ConsumeWheel();
            }

            // The live count (no allocation: the shown clashes against the box as it is)
            _clashBoxInside = CountShownClashesInToolBox();
            UpdateClashToolHover(mouse, overUi || _sectionHover >= 0 || _sectionDrag >= 0);
        }

        /// <summary>The face handle under the mouse (full height: the four side handles only), or −1.</summary>
        private int ClashBoxHandleUnder(Vector2 mouse)
        {
            int best = -1;
            float bestDistance = S(18);
            int last = _clashBoxFullHeight ? 3 : 5;
            for (int h = 0; h <= last; h++)
            {
                if (!HandlePosition(h, out Vector3 position, out _) || !Camera.WorldToScreen(position, out Vector2 screen)) { continue; }
                float distance = Vector2.Distance(screen, mouse);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = h;
                }
            }
            return best;
        }

        /// <summary>True when a box tool hides a handle (the free plane always; the top and bottom at full height).</summary>
        private bool ClashBoxHidesHandle(int handle) => _clashTool == CLASH_TOOL_BOX && (handle == 6 || (_clashBoxFullHeight && handle >= 4));

        /// <summary>True when a clash point is in the tool's box (internal metres; full height: plan only).</summary>
        private bool InClashToolBox(ClashRecord clash) =>
            clash.X >= _section.MinX && clash.X <= _section.MaxX && clash.Y >= _section.MinY && clash.Y <= _section.MaxY
            && (_clashBoxFullHeight || (clash.Z >= _section.MinZ && clash.Z <= _section.MaxZ));

        private int CountShownClashesInToolBox()
        {
            int count = 0;
            foreach (ClashRecord clash in _clashList)
            {
                if (InClashToolBox(clash)) { count++; }
            }
            return count;
        }

        /// <summary>The tool's box as a group box (internal metres; full height kept with the heights it was drawn at).</summary>
        private ClashGroupBox ClashToolBox()
        {
            Vector3 origin = Scene.OriginOffset;
            return new ClashGroupBox
            {
                MinX = _section.MinX, MinY = _section.MinY, MaxX = _section.MaxX, MaxY = _section.MaxY,
                MinZ = _clashBoxFullHeight ? _clashBoxMinZ + origin.Z : _section.MinZ,
                MaxZ = _clashBoxFullHeight ? MathF.Max(_clashBoxMaxZ, _clashBoxMinZ + SectionCut.MIN_SIZE) + origin.Z : _section.MaxZ,
                FullHeight = _clashBoxFullHeight
            }.Normalise();
        }

        /// <summary>
        /// GROUP IN BOX: a new group of the shown clashes inside (keeping the box); EDIT BOX…: the group's box updated,
        /// then RECOLLECT. The cut comes back either way.
        /// </summary>
        private void CommitClashBox()
        {
            ClashGroupBox box = ClashToolBox();
            ClashGroup editing = _clashBoxGroup;
            if (editing != null)
            {
                LeaveClashTool();
                if (!(_clashDocument.Groups?.Contains(editing) ?? false)) { return; }
                ClashGroups.SetBox(editing, box, Environment.UserName, DateTime.UtcNow);
                ClashGroupsChanged();
                RecollectClashGroup(editing, "Box updated");
                return;
            }

            List<ClashRecord> inside = ClashGrouping.InBox(_clashList, box);
            if (inside.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("No shown clash is inside the box (drag the handles, or check the filters)", 2.5f);
                return;
            }
            LeaveClashTool();
            ClashGroup group = GroupClashes(inside, null);
            if (group == null) { return; }
            ClashGroups.SetBox(group, box, Environment.UserName, DateTime.UtcNow);
            ClashGroupsChanged();
        }

        /// <summary>
        /// RECOLLECT FROM ITS BOX (and after EDIT BOX…): the test's open clashes inside the group's box join it (moved from
        /// other groups, said); members now outside the box: REMOVE n / KEEP.
        /// </summary>
        private void RecollectClashGroup(ClashGroup group, string prefix)
        {
            if (!ClashGroups.BoxSplit(_clashDocument, group, null, out List<ClashRecord> joining, out List<ClashRecord> outside))
            {
                Sound.Play(SoundId.Error);
                Toast("This group has no box (EDIT BOX… draws one)", 2.5f);
                return;
            }
            int added = 0, moved = 0;
            if (joining.Count > 0)
            {
                added = ClashGroups.AddTo(_clashDocument, group, joining, Environment.UserName, DateTime.UtcNow, out moved);
                if (added > 0) { ClashGroupsChanged(); }
            }
            string name = Shorten(ClashGroups.DisplayName(group), 40);
            string summary = (prefix == null ? string.Empty : prefix + ": ") +
                (added == 0 ? $"no new clash in the box of “{name}”" : $"{added} clash{(added == 1 ? string.Empty : "es")} added to “{name}”") +
                (moved > 0 ? $" ({moved} moved from other groups)" : string.Empty);
            Sound.Play(added > 0 ? SoundId.Commit : SoundId.UiClick);
            if (outside.Count == 0)
            {
                Toast(summary, 3f);
                return;
            }
            OpenChoice("MEMBERS OUTSIDE THE BOX", $"{summary}. {outside.Count} of the group's clashes now lie outside its box. " +
                "REMOVE takes them out of the group (they stay, ungrouped); KEEP leaves them in.",
                $"REMOVE {outside.Count}", danger: true, null, "KEEP",
                _ => RemoveClashesFromGroups(outside),
                _ => Toast($"{outside.Count} kept in “{name}” (outside its box)", 2.5f));
        }

        #endregion

        #region PICK POINTS

        /// <summary>
        /// Polish round P-B: the pick points key (K) starts the tool as TOOLS ▾ → PICK POINTS does (a test must be under
        /// review); K again or Esc leaves it.
        /// </summary>
        private void StartPickPointsFromKey()
        {
            if (_clashDocument == null || _clashReviewTest == null)
            {
                Sound.Play(SoundId.Error);
                Toast("Pick points needs a clash test to review (TESTS…)", 2f);
                return;
            }
            BeginClashPickTool();
        }

        /// <summary>PICK POINTS: the dots take clicks; the picks are the list selection (kept when it already holds several).</summary>
        private void BeginClashPickTool()
        {
            BeginClashTool(CLASH_TOOL_PICK);
            if (!ClashMultiActive)
            {
                ClashRecord current = _clashCurrent;
                ClearClashSelection();
                _clashCurrent = current;
            }
            ClashPicksChanged();
            Toast($"Pick points: click dots (or rows) to pick · Ctrl+drag a box adds · {Key(InputAction.ClashFrame)}: new group · {Key(InputAction.ClashPickPoints)} or Esc leaves", 4f);
        }

        /// <summary>Clicks on dots (toggle), Ctrl+drag (marquee adds), RMB-drag looks.</summary>
        private void UpdateClashPickTool(InputState input, bool overUi)
        {
            Vector2 mouse = input.MousePosition;
            ClashToolLook(input);
            UpdateClashToolHover(mouse, overUi || _clashMarquee);

            if (_clashMarquee)
            {
                if (input.LeftDown) { return; }
                _clashMarquee = false;
                Vector2 from = _clashMarqueeFrom;
                if (Vector2.Distance(from, mouse) < S(4))
                {
                    // A Ctrl+click without a drag: toggle the dot there
                    UpdateClashToolHover(mouse, overUi);
                    if (_clashToolHover != null) { ToggleClashPick(_clashToolHover); }
                    return;
                }
                float x0 = MathF.Min(from.X, mouse.X), x1 = MathF.Max(from.X, mouse.X);
                float y0 = MathF.Min(from.Y, mouse.Y), y1 = MathF.Max(from.Y, mouse.Y);
                int added = 0;
                foreach (ClashRecord clash in _clashToolDots)
                {
                    if (!Camera.WorldToScreen(ClashLocal(clash), out Vector2 s) || s.X < x0 || s.X > x1 || s.Y < y0 || s.Y > y1) { continue; }
                    if (_clashSelectedLookup.Add(clash))
                    {
                        _clashSelected.Add(clash);
                        added++;
                    }
                }
                if (added > 0)
                {
                    _clashCurrent = _clashSelected[^1];
                    ClashPicksChanged();
                    Sound.Play(SoundId.UiClick);
                }
                Toast(added == 0 ? "No new dot in the box" : $"{added} added · {_clashSelected.Count} picked", 1.6f);
                return;
            }

            if (!input.LeftPressed || overUi) { return; }
            if (input.IsDown(Win32.VK_CONTROL))
            {
                // Ctrl held: start a marquee (a Ctrl+click without moving toggles, as a plain click does)
                input.ConsumeClicks();
                _clashMarquee = true;
                _clashMarqueeFrom = mouse;
                return;
            }
            if (_clashToolHover != null)
            {
                input.ConsumeClicks();
                ToggleClashPick(_clashToolHover);
            }
        }

        /// <summary>A dot or row click: the clash in or out of the picks (the camera stays).</summary>
        private void ToggleClashPick(ClashRecord clash)
        {
            if (clash == null) { return; }
            SyncClashLookup();
            if (_clashSelectedLookup.Remove(clash))
            {
                _clashSelected.Remove(clash);
                if (_clashCurrent == clash) { _clashCurrent = _clashSelected.Count > 0 ? _clashSelected[^1] : null; }
            }
            else
            {
                _clashSelected.Add(clash);
                _clashSelectedLookup.Add(clash);
                _clashCurrent = clash;
            }
            ClashPicksChanged();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>A group row click while picking: its shown members in (or out, when all are picked).</summary>
        private void ToggleClashPicks(List<ClashRecord> clashes)
        {
            if (clashes.Count == 0) { return; }
            SyncClashLookup();
            if (clashes.TrueForAll(_clashSelectedLookup.Contains))
            {
                var leaving = new HashSet<ClashRecord>(clashes);
                _clashSelected.RemoveAll(leaving.Contains);
                if (_clashCurrent != null && leaving.Contains(_clashCurrent)) { _clashCurrent = _clashSelected.Count > 0 ? _clashSelected[^1] : null; }
            }
            else
            {
                foreach (ClashRecord clash in clashes)
                {
                    if (_clashSelectedLookup.Add(clash)) { _clashSelected.Add(clash); }
                }
                _clashCurrent = clashes[^1];
            }
            ClashPicksChanged();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// After the picks changed: the pairs found again and drawn (one pick: that clash's pair; several: every pair), the
        /// card follows; the camera and the section box stay.
        /// </summary>
        private void ClashPicksChanged()
        {
            SyncClashLookup();
            _clashGroupCurrent = null;
            _clashGroupPicks.Clear();
            _clashMultiA.Clear(); _clashMultiB.Clear(); _clashMultiBoth.Clear();
            _clashMultiDynamicA.Clear(); _clashMultiDynamicB.Clear(); _clashMultiDynamicBoth.Clear();
            if (_clashCurrent != null)
            {
                ResolveClashElement(_clashCurrent.A, out _clashElementA, out _clashDynamicA);
                ResolveClashElement(_clashCurrent.B, out _clashElementB, out _clashDynamicB);
            }
            if (_clashSelected.Count > 1) { ResolveSelectedClashes(out _, out _, out _); }
            _clashToolLabelCount = -1;
            RefreshClashCard();
        }

        /// <summary>NEW GROUP (Enter): the picks become a group; the tool ends with its card showing.</summary>
        private void CommitClashPicks()
        {
            if (_clashSelected.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("Nothing picked yet: click dots, or Ctrl+drag a box round them", 2.5f);
                return;
            }
            List<ClashRecord> picks = _clashSelected.ToList();
            LeaveClashTool();
            GroupClashes(picks, null);
        }

        /// <summary>CLEAR: no picks.</summary>
        private void ClearClashPicks()
        {
            ClashRecord current = _clashCurrent;
            ClearClashSelection();
            _clashCurrent = current;
            ClashPicksChanged();
        }

        /// <summary>ADD TO GROUP ›: the test's groups (largest first); a pick adds the picks and ends the tool.</summary>
        private void OpenClashPickAddTo(float x, float y, float w, float h)
        {
            if (_clashSelected.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("Nothing picked yet", 2f);
                return;
            }
            List<ClashGroup> groups = ClashGroups.OfTest(_clashDocument, _clashReviewTest).OrderByDescending(g => g.Count).ToList();
            if (groups.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("This test has no groups yet: NEW GROUP makes one", 2.5f);
                return;
            }
            var labels = groups.Select(g => $"{Shorten(ClashGroups.DisplayName(g), 40)} ({g.Count})").ToList();
            OpenDropdown(_clashList, DROP_DOCK_TOOL_ADD, x, y, MathF.Max(w, S(320)), h, labels, -1, i =>
            {
                List<ClashRecord> picks = _clashSelected.ToList();
                LeaveClashTool();
                AddClashesToGroup(groups[i], picks);
            });
        }

        #endregion

        #region CLUSTER AROUND…

        /// <summary>CLUSTER AROUND…: a sphere on the clash (the radius from last time, 1 m at first).</summary>
        private void BeginClashSphereTool(ClashRecord seed)
        {
            if (seed == null)
            {
                Sound.Play(SoundId.Error);
                Toast("Pick a clash first: the cluster starts round it", 2.5f);
                return;
            }
            BeginClashTool(CLASH_TOOL_SPHERE);
            ClashRecord current = _clashCurrent;
            ClearClashSelection();
            _clashCurrent = current;
            _clashSphereSeed = seed;
            _clashSphereDirty = true;
            Toast($"Cluster: drag the sphere's white handle to size it · click a dot (or row) to move the centre · {Key(InputAction.ClashFrame)} groups · Esc cancels", 4f);
        }

        /// <summary>The handle: on the sphere's edge in the XY plane, across the view (so it sits on the outline).</summary>
        private Vector3 ClashSphereHandleAxis()
        {
            float yaw = Camera.Yaw;
            return new Vector3(MathF.Sin(yaw), -MathF.Cos(yaw), 0f);
        }

        /// <summary>Drag the handle (snapped; the free-drag key: free), click a dot to move the centre, RMB-drag looks.</summary>
        private void UpdateClashSphereTool(InputState input, bool overUi)
        {
            if (_clashSphereSeed == null)
            {
                LeaveClashTool();
                return;
            }
            Vector2 mouse = input.MousePosition;
            Vector3 centre = ClashLocal(_clashSphereSeed);

            if (_clashSphereDragging)
            {
                if (!input.LeftDown)
                {
                    _clashSphereDragging = false;
                    Sound.Play(SoundId.Click);
                    return;
                }
                ScreenRay(mouse, out Vector3 rayOrigin, out Vector3 rayDirection);
                if (ClosestOnAxis(centre, _clashSphereAxis, rayOrigin, rayDirection, out float parameter))
                {
                    float radius = MathF.Max(CLASH_SPHERE_SNAP, parameter);
                    if (!input.Down(InputAction.SectionFreeDrag)) { radius = MathF.Max(CLASH_SPHERE_SNAP, MathF.Round(radius / CLASH_SPHERE_SNAP) * CLASH_SPHERE_SNAP); }
                    radius = MathF.Min(radius, 500f);
                    if (MathF.Abs(radius - _clashSphereRadius) > 1e-4f)
                    {
                        _clashSphereRadius = radius;
                        _clashSphereDirty = true;
                    }
                }
                return;
            }

            ClashToolLook(input);
            Vector3 handle = centre + ClashSphereHandleAxis() * _clashSphereRadius;
            _clashSphereHandleHover = !overUi && Camera.WorldToScreen(handle, out Vector2 hs) && Vector2.Distance(hs, mouse) < S(14);
            UpdateClashToolHover(mouse, overUi || _clashSphereHandleHover);
            if (!input.LeftPressed || overUi) { return; }
            if (_clashSphereHandleHover)
            {
                input.ConsumeClicks();
                _clashSphereDragging = true;
                _clashSphereAxis = ClashSphereHandleAxis();
                Sound.Play(SoundId.UiClick);
            }
            else if (_clashToolHover != null)
            {
                input.ConsumeClicks();
                MoveClashSphere(_clashToolHover);
            }
        }

        /// <summary>A dot or row click: the sphere's centre moves to that clash.</summary>
        private void MoveClashSphere(ClashRecord clash)
        {
            if (clash == null || clash == _clashSphereSeed) { return; }
            _clashSphereSeed = clash;
            _clashSphereDirty = true;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The shown clashes in the sphere (nearest first) and how many are in other groups, after a change.</summary>
        private void RefreshClashSphere()
        {
            if (!_clashSphereDirty || _clashSphereSeed == null) { return; }
            _clashSphereDirty = false;
            _clashSphereMembers.Clear();
            _clashSphereLookup.Clear();
            _clashSphereMembers.AddRange(ClashGrouping.InSphere(_clashList, _clashSphereSeed.X, _clashSphereSeed.Y, _clashSphereSeed.Z, _clashSphereRadius));
            _clashSphereElsewhere = 0;
            foreach (ClashRecord clash in _clashSphereMembers)
            {
                _clashSphereLookup.Add(clash);
                if (ClashGroupOf(clash) != null) { _clashSphereElsewhere++; }
            }
            _clashToolLabelCount = -1;
        }

        /// <summary>GROUP (Enter): the clashes in the sphere become "Cluster N · Level × n clashes".</summary>
        private void CommitClashSphere()
        {
            RefreshClashSphere();
            if (_clashSphereMembers.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("No shown clash is in the sphere (drag its handle, or check the filters)", 2.5f);
                return;
            }
            List<ClashRecord> members = _clashSphereMembers.ToList();
            string label = ClashGrouping.ClusterLabel(_clashDocument, _clashReviewTest, members);
            LeaveClashTool();
            GroupClashes(members, null, label);
        }

        #endregion

        #region Bar

        /// <summary>
        /// The tool's bar at the bottom of the free view (left of the dock, or the whole width with the dock folded):
        /// title, live status, the buttons and the hint. Buttons are acted on after the overlays (<see cref="RunClashToolBarAction"/>).
        /// </summary>
        private void BuildClashToolBar(FontAtlas f, InputState input, int width, int height, float freeWidth)
        {
            RefreshClashToolLabels();
            float w = MathF.Min(S(760), freeWidth - S(40)), h = S(100);
            float x = MathF.Max(S(20), (freeWidth - w) * 0.5f), y = height - h - S(16);
            _clashToolBarRect = new Vector4(x, y, w, h);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
            float ix = x + S(14), iw = w - S(28), cy = y + S(10);
            float used = _ui.Text(f.Small, ix, cy, _clashToolTitle ?? string.Empty, UiTheme.ACCENT, S(1.4f));
            _ui.TextWrapped(f.Small, ix + used + S(14), cy, MathF.Max(S(40), iw - used - S(14)), _clashToolStatus ?? string.Empty, UiTheme.TEXT, maxLines: 1);
            cy += S(24);

            float bh = S(30);
            switch (_clashTool)
            {
                case CLASH_TOOL_BOX:
                {
                    float bw = (iw - S(18)) / 4f;
                    if (SmallButton(f, input, ix, cy, bw * 1.3f, bh, _clashToolCommitLabel)) { _clashToolBarAction = BAR_COMMIT; }
                    float bx = ix + bw * 1.3f + S(6), rest = (iw - bw * 1.3f - S(18)) / 3f;
                    if (SmallButton(f, input, bx, cy, rest, bh, _clashBoxFullHeight ? "FULL HEIGHT: ON" : "FULL HEIGHT: OFF")) { _clashToolBarAction = BAR_FULL_HEIGHT; }
                    if (SmallButton(f, input, bx + rest + S(6), cy, rest, bh, "FIT VIEW")) { _clashToolBarAction = BAR_FIT; }
                    if (SmallButton(f, input, bx + (rest + S(6)) * 2f, cy, rest, bh, "CANCEL")) { _clashToolBarAction = BAR_CANCEL; }
                    break;
                }
                case CLASH_TOOL_PICK:
                {
                    float bw = (iw - S(18)) / 4f;
                    if (SmallButton(f, input, ix, cy, bw, bh, _clashToolCommitLabel)) { _clashToolBarAction = BAR_COMMIT; }
                    float ax = ix + bw + S(6);
                    if (DropdownButton(f, input, ax, cy, bw, bh, "ADD TO GROUP", IsDropdownOpen(_clashList, DROP_DOCK_TOOL_ADD))) { OpenClashPickAddTo(ax, cy, bw, bh); }
                    if (SmallButton(f, input, ix + (bw + S(6)) * 2f, cy, bw, bh, "CLEAR")) { _clashToolBarAction = BAR_CLEAR; }
                    if (SmallButton(f, input, ix + (bw + S(6)) * 3f, cy, bw, bh, "DONE")) { _clashToolBarAction = BAR_CANCEL; }
                    break;
                }
                default:
                {
                    float bw = (iw - S(6)) / 2f;
                    if (SmallButton(f, input, ix, cy, bw, bh, _clashToolCommitLabel)) { _clashToolBarAction = BAR_COMMIT; }
                    if (SmallButton(f, input, ix + bw + S(6), cy, bw, bh, "CANCEL")) { _clashToolBarAction = BAR_CANCEL; }
                    break;
                }
            }
            cy += bh + S(8);
            _ui.TextWrapped(f.Small, ix, cy, iw, ClashToolHint(), UiTheme.TEXT_FAINT, maxLines: 1);

            // The marquee and the hovered dot's label
            if (_clashMarquee)
            {
                Vector2 m = input.MousePosition;
                float mx = MathF.Min(_clashMarqueeFrom.X, m.X), my = MathF.Min(_clashMarqueeFrom.Y, m.Y);
                float mw = MathF.Abs(m.X - _clashMarqueeFrom.X), mh = MathF.Abs(m.Y - _clashMarqueeFrom.Y);
                _ui.Rect(mx, my, mw, mh, Rgba.Hex(0x22D3EE, 0.12f));
                _ui.Outline(mx, my, mw, mh, MathF.Max(1f, UiScale), Rgba.Hex(0x22D3EE, 0.9f));
            }
            if (!_clashMarquee) { DrawClashHoverLabel(f, input, width); }

            // Clicks on the bar stay on the bar
            if (OverClashToolBar(input.MousePosition) && input.LeftPressed) { input.ConsumeClicks(); }
        }

        /// <summary>The dot under the mouse: its pair, status, level and group beside the cursor (C-C3: in clash mode too).</summary>
        private void DrawClashHoverLabel(FontAtlas f, InputState input, int width)
        {
            if (_clashToolHoverText == null || _clashToolHover == null) { return; }
            Vector2 m = input.MousePosition;
            float tw = MathF.Min(S(520), UiBatch.Measure(f.Small, _clashToolHoverText) + S(20));
            float tx = MathF.Min(m.X + S(16), width - tw - S(8)), ty = m.Y + S(16);
            _ui.Panel(tx, ty, tw, S(26), UiTheme.PANEL_STRONG, StatusColour(_clashToolHover.Status));
            _ui.TextWrapped(f.Small, tx + S(10), ty + S(6), tw - S(20), _clashToolHoverText, UiTheme.TEXT, maxLines: 1);
        }

        /// <summary>The bar's title, status and main button (rebuilt when the counts, radius or units change).</summary>
        private void RefreshClashToolLabels()
        {
            int count;
            switch (_clashTool)
            {
                case CLASH_TOOL_BOX: count = _clashBoxInside * 2 + (_clashBoxFullHeight ? 1 : 0); break;
                case CLASH_TOOL_PICK: count = _clashSelected.Count; break;
                default: RefreshClashSphere(); count = _clashSphereMembers.Count; break;
            }
            if (count == _clashToolLabelCount && _clashToolLabelRadius == _clashSphereRadius && _clashToolLabelUnits == UnitFormat.Revision) { return; }
            _clashToolLabelCount = count;
            _clashToolLabelRadius = _clashSphereRadius;
            _clashToolLabelUnits = UnitFormat.Revision;

            switch (_clashTool)
            {
                case CLASH_TOOL_BOX:
                    _clashToolTitle = _clashBoxGroup == null ? "GROUP BY BOX" : "EDIT BOX";
                    _clashToolStatus = $"{_clashBoxInside:N0} of {_clashList.Count:N0} shown clashes inside" + (_clashBoxFullHeight ? " · full height" : string.Empty) +
                        (_clashBoxGroup == null ? string.Empty : $" · “{Shorten(ClashGroups.DisplayName(_clashBoxGroup), 34)}”");
                    _clashToolCommitLabel = _clashBoxGroup == null ? $"GROUP IN BOX ({_clashBoxInside:N0})" : "UPDATE + RECOLLECT";
                    break;
                case CLASH_TOOL_PICK:
                    _clashToolTitle = "PICK POINTS";
                    _clashToolStatus = $"{_clashSelected.Count:N0} picked";
                    _clashToolCommitLabel = $"NEW GROUP ({_clashSelected.Count:N0})";
                    break;
                default:
                    _clashToolTitle = "CLUSTER";
                    _clashToolStatus = $"radius {UnitFormat.Length(_clashSphereRadius, 2)} · {_clashSphereMembers.Count:N0} clash{(_clashSphereMembers.Count == 1 ? string.Empty : "es")}" +
                        (_clashSphereElsewhere > 0 ? $" ({_clashSphereElsewhere} in other groups: they move)" : string.Empty);
                    _clashToolCommitLabel = $"GROUP ({_clashSphereMembers.Count:N0})";
                    break;
            }
        }

        private static readonly KeyHint HINT_CLASH_BOX = new(() =>
            $"Drag the cyan handles ({Hotkeys.Label(InputAction.SectionFreeDrag)}: free) · RMB-drag orbits · wheel zooms · move keys pan · " +
            $"{Hotkeys.Label(InputAction.ClashFrame)} commits · Esc cancels");
        private static readonly KeyHint HINT_CLASH_PICK = new(() =>
            $"Click dots or rows to pick · Ctrl+drag a box adds · RMB-drag looks · {Hotkeys.Label(InputAction.ClashFrame)}: new group · {Hotkeys.Label(InputAction.ClashPickPoints)} or Esc leaves");
        private static readonly KeyHint HINT_CLASH_SPHERE = new(() =>
            $"Drag the white handle to size the sphere ({Hotkeys.Label(InputAction.SectionFreeDrag)}: free) · click a dot or row to move the centre · " +
            $"{Hotkeys.Label(InputAction.ClashFrame)} groups · Esc cancels");

        private string ClashToolHint() => _clashTool switch
        {
            CLASH_TOOL_BOX => HINT_CLASH_BOX.Text,
            CLASH_TOOL_PICK => HINT_CLASH_PICK.Text,
            _ => HINT_CLASH_SPHERE.Text
        };

        /// <summary>Acts on the bar's button (after the dock's overlays).</summary>
        /// <returns>True when the tool ended (the dock returns for this frame).</returns>
        private bool RunClashToolBarAction()
        {
            int action = _clashToolBarAction;
            _clashToolBarAction = BAR_NONE;
            if (_clashTool == CLASH_TOOL_NONE) { return false; }
            switch (action)
            {
                case BAR_COMMIT: CommitClashTool(); return true;
                case BAR_CANCEL: CancelClashTool(); return true;
                case BAR_FULL_HEIGHT: ToggleClashBoxFullHeight(); return false;
                case BAR_FIT: FitClashBoxView(); return false;
                case BAR_CLEAR: ClearClashPicks(); return false;
                default: return false;
            }
        }

        #endregion

        #region Drawing

        /// <summary>
        /// The tool's 3D marks (after the scene's markers; depth-tested, then a 40 % copy so hidden ones stay findable):
        /// the dots (box: amber inside; pick: amber ring when picked, bigger when hovered; cluster: amber inside, a line to
        /// the centre), and the cluster's wire sphere and handle.
        /// </summary>
        private void DrawClashToolOverlay()
        {
            if (!_clashModeOn || _clashTool == CLASH_TOOL_NONE) { return; }
            if (_clashToolOverlay == null)
            {
                _clashToolOverlay = new Overlay3D();
                _clashToolOverlay.Initialise();
            }
            RefreshClashToolDots();
            if (_clashTool == CLASH_TOOL_SPHERE) { RefreshClashSphere(); }
            Overlay3D o = _clashToolOverlay;
            o.Begin(Camera);
            uint amber = Rgba.Hex(0xF59E0B);

            Vector3 centre = _clashSphereSeed != null ? ClashLocal(_clashSphereSeed) : Vector3.Zero;
            int lines = 0;
            foreach (ClashRecord clash in _clashToolDots)
            {
                Vector3 p = ClashLocal(clash);
                bool hover = clash == _clashToolHover;
                bool marked = _clashTool switch
                {
                    CLASH_TOOL_BOX => InClashToolBox(clash),
                    CLASH_TOOL_PICK => _clashSelectedLookup.Contains(clash) && _clashSelected.Count > 0,
                    _ => _clashSphereLookup.Contains(clash)
                };
                if (marked && _clashTool == CLASH_TOOL_SPHERE && lines < 400)
                {
                    o.Line(centre, p, 1.5f, Rgba.Hex(0xF59E0B, 0.55f));
                    lines++;
                }
                if (marked)
                {
                    o.Dot(p, S(hover ? 10f : 8f), amber);
                    o.Dot(p, S(hover ? 6.5f : 5f), StatusColour(clash.Status));
                }
                else
                {
                    if (hover) { o.Dot(p, S(9f), Rgba.Hex(0xFFFFFF)); }
                    o.Dot(p, S(hover ? 6.5f : 4.5f), StatusColour(clash.Status));
                }
            }

            if (_clashTool == CLASH_TOOL_SPHERE && _clashSphereSeed != null)
            {
                float r = _clashSphereRadius;
                float thickness = MathF.Max(0.01f, r * 0.012f);
                uint wire = Rgba.Hex(0x22D3EE, 0.85f);
                o.Ring(centre, Vector3.UnitX, Vector3.UnitY, r, r, thickness * 1.5f, wire, 64); // the XY ring: the handle's
                o.Ring(centre, Vector3.UnitX, Vector3.UnitZ, r, r, thickness, Rgba.Hex(0x22D3EE, 0.5f), 48);
                o.Ring(centre, Vector3.UnitY, Vector3.UnitZ, r, r, thickness, Rgba.Hex(0x22D3EE, 0.5f), 48);
                Vector3 right = ClashSphereHandleAxis();
                Vector3 up = Vector3.Normalize(Vector3.Cross(right, Camera.Forward));
                if (float.IsFinite(up.X)) { o.Ring(centre, right, up, r, r, thickness, Rgba.Hex(0x22D3EE, 0.35f), 64); } // the outline
                Vector3 axis = _clashSphereDragging ? _clashSphereAxis : right;
                Vector3 handle = centre + axis * r;
                o.Line(centre, handle, 2f, Rgba.Hex(0xFFFFFF, 0.8f));
                bool active = _clashSphereDragging || _clashSphereHandleHover;
                o.Dot(handle, S(active ? 11f : 8.5f), Rgba.Hex(0xFFFFFF));
                o.Dot(handle, S(active ? 7f : 5.5f), Rgba.Hex(0x22D3EE));
                o.Dot(centre, S(7f), Rgba.Hex(0xFFFFFF));
            }

            o.Draw(Camera, depthTest: true, alpha: 1f, additive: false);
            o.Draw(Camera, depthTest: false, alpha: 0.4f, additive: false);
        }

        #endregion
    }
}
