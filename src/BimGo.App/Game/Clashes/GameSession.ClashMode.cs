using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Live;
using BimGo.Native;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash mode (Round C, build C-B1): Y (or REVIEW in the CLASHES panel) docks the clash list on the right while
    /// you fly: free cursor, the move keys fly, RMB-drag looks. GO (a row, `,` / `.`, Enter) flies to a clash in about
    /// a second (or jumps, with INSTANT on), puts the section box around it (the clash region + 1 m), draws the pair in
    /// red (A) and green (B) and the rest as faint grey glass without shadows (C-C3: a click on a dot goes there too, with a
    /// label on hover). 1–5 set the status; R selects the pair in
    /// Revit (live). The test's clashes show as dots in the model while the mode is on (overlay only: never saved).
    /// C-B1 fixes: G cycles the rest of the model through ghost / wireframe / real / hidden; B switches the section box
    /// off and back on (on again = round the current clash). Leaving keeps the section box (Ctrl+P clears it) and flying
    /// (V walks). C-B2: the box choice sticks: off stays off from clash to clash, on follows each clash GO goes to; R
    /// shows the clash in Revit (the pair selected in a "BimGo clash" 3D view with the same section box).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const float CLASH_GHOST = 0.15f;
        private const float CLASH_WIRE = 0.4f;

        // The rest of the model in the clash view (G cycles; the dock's VIEW dropdown picks)
        private const int CLASH_VIEW_GHOST = 0, CLASH_VIEW_WIREFRAME = 1, CLASH_VIEW_REAL = 2, CLASH_VIEW_HIDDEN = 3;
        private static readonly string[] CLASH_VIEW_NAMES = { "GHOST", "WIREFRAME", "REAL MODEL", "HIDDEN" };
        private int _clashView = CLASH_VIEW_GHOST;
        private string _clashViewLabel, _clashBoxLabel;

        // The current clash's section box, and whether it is on (B toggles; C-B2: the choice sticks from clash to clash)
        private SectionCut _clashSection;
        private bool _clashBoxOn = true;

        /// <summary>The current clash's framing (camera and region), kept for SHOW IN REVIT.</summary>
        private ClashView _clashFrame;
        private static readonly Vector4 CLASH_A_TINT = new(0.94f, 0.27f, 0.27f, 0.75f);
        private static readonly Vector4 CLASH_B_TINT = new(0.13f, 0.77f, 0.37f, 0.75f);

        private bool _clashModeOn;
        private bool _clashInstant;

        // The clash on screen and its pair as walked (a static element, or a moved / cloned instance)
        private ClashRecord _clashCurrent;
        private int _clashElementA = -1, _clashElementB = -1;
        private DynamicInstance _clashDynamicA, _clashDynamicB;
        private string _clashCurrentRoom;
        private Dictionary<string, int> _clashElementByKey;

        // The flight between clashes
        private bool _clashFlying;
        private float _clashFlyTime, _clashFlyDuration, _clashFlyLift;
        private Vector3 _clashFlyFrom, _clashFlyTo;
        private float _clashFlyFromYaw, _clashFlyToYaw, _clashFlyFromPitch, _clashFlyToPitch;

        #endregion

        #region State

        /// <summary>True while the clash view is drawn: clash mode on and the current clash's pair found.</summary>
        private bool ClashViewActive => _clashModeOn && _clashCurrent != null
            && (_clashElementA >= 0 || _clashDynamicA != null || _clashElementB >= 0 || _clashDynamicB != null
                || (ClashMultiActive && _clashMultiA.Count + _clashMultiB.Count + _clashMultiDynamicA.Count + _clashMultiDynamicB.Count
                    + _clashMultiBoth.Count + _clashMultiDynamicBoth.Count > 0));

        /// <summary>
        /// True when the player's own movement waits (a flight, or typing in the search box; C-C2: picking points with Ctrl
        /// held, since Ctrl+drag draws a marquee and Ctrl also flies down).
        /// </summary>
        private bool ClashFreezesPlayer => _clashModeOn && (_clashFlying || _clashSearchFocused
            || (_clashTool == CLASH_TOOL_PICK && (_clashMarquee || _window.Input.IsDown(Win32.VK_CONTROL))));

        #endregion

        #region Enter / leave

        /// <summary>Y: clash mode on, or off when it is on.</summary>
        private void ToggleClashMode()
        {
            if (_clashModeOn) { ExitClashMode(); }
            else { EnterClashMode(null); }
        }

        /// <summary>
        /// Turns clash mode on (switching clash detection on the first time), on a test (null: the selected test, else
        /// the first with clashes), and goes to <paramref name="clash"/> (null: the first clash the list shows).
        /// </summary>
        private void EnterClashMode(ClashRecord clash, string testId = null)
        {
            EnsureClashes();
            ExitPathEditor(); // Round K-B: one free-cursor mode at a time
            _clashPickerRule = null;
            CloseOverlay();
            CloseClashes();
            ClosePhotoMode();
            CloseSectionEditor();
            CloseSunPanel();
            CloseSunHours();
            if (_paused) { SetPaused(false); }
            ShowUi();

            string wanted = testId ?? clash?.TestId ?? _clashReviewTest ?? _clashSelectedTest;
            if (_clashDocument.FindTest(wanted) == null || (clash == null && !_clashDocument.Clashes.Any(c => c.TestId == wanted)))
            {
                wanted = _clashDocument.Tests.FirstOrDefault(t => _clashDocument.Clashes.Any(c => c.TestId == t.Id))?.Id ?? _clashDocument.Tests.FirstOrDefault()?.Id;
            }
            SetClashReviewTest(wanted);
            RefreshClashViewLabels();

            _clashModeOn = true;
            if (!_player.Flying) { _player.ToggleFly(); }
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            RefreshClashList();

            ClashRecord first = clash ?? (_clashCurrent != null && _clashList.Contains(_clashCurrent) ? _clashCurrent : _clashList.FirstOrDefault());
            if (first != null) { GoToClash(first, animate: !_clashInstant); }
            Sound.Play(SoundId.UiClick);
            Toast(_clashList.Count == 0
                ? $"Clash mode: no clashes to show yet (TESTS… runs them) · {Key(InputAction.ClashMode)} or Esc leaves"
                : $"Clash mode: {Key(InputAction.ClashPrevious)} / {Key(InputAction.ClashNext)} previous / next · 1–5 status · RMB-drag looks · {Key(InputAction.ClashMode)} or Esc leaves", 4f);
        }

        /// <summary>
        /// Leaves clash mode: the clash view goes, flying stays. QOL round: the clash section box goes too (BOX stays on,
        /// so coming back puts it round the clash again).
        /// </summary>
        private void ExitClashMode()
        {
            if (!_clashModeOn) { return; }
            CloseGridsPanel(); // grids round A (clash mode's cursor handling follows)
            if (_clashBatch != null) { FinishClashBatch(cancelled: true); }
            CancelClashReport(); // C-C3
            _clashReportCardOpen = false;
            LeaveClashTool(); // C-C2: a box tool puts the cut back first
            _clashToolHover = null;
            _clashModeOn = false;
            _clashFlying = false;
            _clashSearchFocused = false;
            _clashMenuLook = false;
            CloseOverlay();
            _window.Input.ReleaseAll();
            if (!_paused && _window.IsActive) { _window.SetCaptured(true); }
            bool boxCleared = false;
            if (_clashBoxOn && _section.IsActive)
            {
                _section.BoxOn = false;
                _section.PlaneOn = false;
                SectionChanged();
                boxCleared = true;
            }
            Toast(boxCleared
                ? $"Clash mode off · still flying ({Key(InputAction.Fly)} walks) · section box off"
                : $"Clash mode off · still flying ({Key(InputAction.Fly)} walks)", 3f);
        }

        #endregion

        #region Frame

        /// <summary>
        /// Clash mode's keys and mouse (the docked panel handles its own clicks when it is drawn).
        /// </summary>
        private void UpdateClashMode(InputState input, float dt)
        {
            // The search box has the keys while it is focused (Enter / Esc / a click elsewhere end it)
            if (_clashSearchFocused)
            {
                TypeIntoClashSearch(input);
                AdvanceClashFlight(dt);
                return;
            }

            // Grids round A: the grids keys stay live in clash mode (Esc closes an open grids panel first)
            if (input.Pressed(InputAction.GridsPanel)) { ToggleGridsPanel(); }
            if (input.Pressed(InputAction.GridsCycle)) { CycleGrids(); }
            if (input.Pressed(InputAction.ColourProfile)) { ToggleProfile(); } // colour round A: shows in the real model view
            if (_gridsPanelOpen && _clashTool == CLASH_TOOL_NONE && !OverlayOpen && input.Pressed(InputAction.Back))
            {
                CloseGridsPanel();
                return;
            }

            // C-C2: a grouping tool (box, pick points, cluster) has the keys and the mouse
            if (_clashTool != CLASH_TOOL_NONE)
            {
                UpdateClashTool(input, dt);
                return;
            }

            // Esc closes an open dropdown first, then stops making comments (C-B2) or the report (C-C3), closes its card
            if (input.Pressed(InputAction.Back) && CloseOverlay()) { return; }
            if (input.Pressed(InputAction.Back) && _clashBatch != null)
            {
                FinishClashBatch(cancelled: true);
                return;
            }
            if (input.Pressed(InputAction.Back) && _clashReportJob != null)
            {
                CancelClashReport();
                return;
            }
            if (input.Pressed(InputAction.Back) && _clashReportCardOpen)
            {
                _clashReportCardOpen = false;
                return;
            }
            if (input.Pressed(InputAction.Back) || input.Pressed(InputAction.ClashMode))
            {
                ExitClashMode();
                return;
            }
            if (input.Pressed(InputAction.Help)) { _showHelp = !_showHelp; }
            if (input.Pressed(InputAction.HideUi)) { ToggleUiHidden(); }
            if (input.Pressed(InputAction.Fullscreen)) { _window.ToggleFullscreen(); }
            if (input.Pressed(InputAction.Screenshot)) { RequestScreenshot(); }
            // C-C1: RMB pressed over the dock opens a row menu, so it doesn't look until it is released
            if (input.RightPressed && _clashDockW > 0f && Hover(input, _clashDockX, _clashDockY, _clashDockW, _clashDockH, focus: false)) { _clashMenuLook = true; }
            if (!input.RightDown) { _clashMenuLook = false; }
            if (input.Down(InputAction.DragLook) && !_clashFlying && !_clashMenuLook) { _player.Look(input.MouseDeltaX, input.MouseDeltaY, _sensitivity, _invertY); }
            UpdateRoom();

            // C-C3: the dots take clicks as list rows do: a click goes to that clash, Ctrl adds / removes, Shift a run
            bool overDock = OverClashDock(input.MousePosition);
            UpdateClashToolHover(input.MousePosition, overDock || OverlayOpen || input.Down(InputAction.DragLook) || _clashFlying);
            if (input.LeftPressed && _clashToolHover != null && !overDock && !OverlayOpen)
            {
                ClashRecord hit = _clashToolHover;
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
                ClickClashRow(hit, input.IsDown(Win32.VK_CONTROL), input.IsDown(Win32.VK_SHIFT));
            }
            else if (!overDock && _clashToolHover == null) { ClickGridNode(input); } // grids round B: a node flies there

            if (input.PressedOrRepeated(InputAction.ClashNext)) { StepClash(+1); }
            else if (input.PressedOrRepeated(InputAction.ClashPrevious)) { StepClash(-1); }
            else if (input.Pressed(InputAction.ClashFrame) && _clashCurrent != null)
            {
                if (ClashMultiActive) { GoToSelectedClashes(animate: !_clashInstant); }
                else { GoToClash(_clashCurrent, animate: !_clashInstant); }
            }
            else if (input.Pressed(InputAction.ClashSelectInRevit)) { ShowClashInRevit(); }
            else if (input.Pressed(InputAction.ClashView)) { SetClashView((_clashView + 1) % CLASH_VIEW_NAMES.Length); }
            else if (input.Pressed(InputAction.ClashSectionToggle)) { ToggleClashBox(); }
            else if (input.Pressed(InputAction.ClashSelectAll)) { ToggleSelectAllShownClashes(); }
            else if (input.Pressed(InputAction.ClashPictures)) { ToggleClashThumbnails(); } // sky round: P / the pad's Back
            else if (input.Pressed(InputAction.ClashUngroup)) { UngroupFromKeys(); } // C-C1: Ctrl+Shift+G
            else if (input.Pressed(InputAction.ClashGroup)) { GroupClashes(ClashTargets(), null); } // C-C1: Ctrl+G
            else if (input.Pressed(InputAction.ClashPickPoints)) { StartPickPointsFromKey(); } // P-B: K (TOOLS ▾ → PICK POINTS)
            else if (input.Pressed(InputAction.ClashStatusCycle)) { CycleCurrentClashStatus(); } // P-B: the gamepad's LB+A
            else
            {
                for (int k = 0; k < ClashStatus.All.Length; k++)
                {
                    if (input.Pressed((InputAction)((int)InputAction.ClashStatusNew + k)))
                    {
                        SetCurrentClashStatus(ClashStatus.All[k]);
                        break;
                    }
                }
            }

            AdvanceClashFlight(dt);
        }

        /// <summary>
        /// Moves the camera along the flight: eased, rising in the middle for longer hops so you see where you went.
        /// </summary>
        private void AdvanceClashFlight(float dt)
        {
            if (!_clashFlying) { return; }
            _clashFlyTime += dt;
            float t = Math.Clamp(_clashFlyTime / MathF.Max(_clashFlyDuration, 0.01f), 0f, 1f);
            float e = t * t * (3f - 2f * t);
            Vector3 eye = Vector3.Lerp(_clashFlyFrom, _clashFlyTo, e) + Vector3.UnitZ * (_clashFlyLift * MathF.Sin(MathF.PI * e));
            float yaw = _clashFlyFromYaw + ClashFraming.AngleBetween(_clashFlyToYaw, _clashFlyFromYaw) * e;
            float pitch = _clashFlyFromPitch + (_clashFlyToPitch - _clashFlyFromPitch) * e;
            _player.TeleportTo(eye - Vector3.UnitZ * _player.Controller.StandEye, yaw, pitch);
            if (t >= 1f) { _clashFlying = false; }
        }

        #endregion

        #region GO

        /// <summary>
        /// Goes to a clash: finds its pair as walked, sets the section box around it and flies (or jumps) to ~2.5 m back.
        /// </summary>
        private void GoToClash(ClashRecord clash, bool animate)
        {
            if (clash == null) { return; }
            ClearClashSelection(); // C-B3: one clash again
            _clashCurrent = clash;
            ResolveClashElement(clash.A, out _clashElementA, out _clashDynamicA);
            ResolveClashElement(clash.B, out _clashElementB, out _clashDynamicB);
            ClashView view = FrameClash(clash, _player.Yaw, out Vector3 point, out _clashSection);
            _clashFrame = view;

            // The section box (kept after leaving clash mode until Ctrl+P or the next GO). C-B2: it follows the clash
            // only while it is on; switched off (B) it stays off from clash to clash
            if (_clashBoxOn) { ApplySection(_clashSection, announce: false); }
            InvalidateClashThumbnail(clash); // the visited one's picture is taken again

            int room = FindRoom(point);
            _clashCurrentRoom = room >= 0 ? (string.IsNullOrWhiteSpace(Scene.Rooms[room].Number) || Scene.Rooms[room].Number == "—"
                ? Scene.Rooms[room].Name : $"{Scene.Rooms[room].Number} · {Scene.Rooms[room].Name}") : null;
            _clashScrollToCurrent = true;
            RefreshClashCard();
            FlyToClashView(view, animate);
        }

        /// <summary>Flies (or jumps) the camera to a clash view.</summary>
        private void FlyToClashView(ClashView view, bool animate)
        {
            Vector3 from = _player.Feet + Vector3.UnitZ * _player.Controller.StandEye;
            float distance = Vector3.Distance(from, view.Eye);
            if (!animate || distance < 0.05f)
            {
                _clashFlying = false;
                _player.TeleportTo(view.Eye - Vector3.UnitZ * _player.Controller.StandEye, view.Yaw, view.Pitch);
                return;
            }
            _clashFlying = true;
            _clashFlyTime = 0f;
            _clashFlyDuration = Math.Clamp(0.6f + distance * 0.02f, 0.8f, 2f);
            _clashFlyLift = MathF.Min(distance * 0.15f, 6f);
            _clashFlyFrom = from;
            _clashFlyTo = view.Eye;
            _clashFlyFromYaw = _player.Yaw;
            _clashFlyToYaw = view.Yaw;
            _clashFlyFromPitch = _player.Pitch;
            _clashFlyToPitch = view.Pitch;
        }

        /// <summary>
        /// A clash's framing from the pair as currently resolved (<see cref="_clashElementA"/> etc.): the camera ~2.5 m
        /// back and the section box round the clash region (Revit internal metres, box on).
        /// </summary>
        /// <param name="clash">The clash.</param>
        /// <param name="currentYaw">The heading that breaks ties between equally good sides.</param>
        /// <param name="point">The clash point (scene-local).</param>
        /// <param name="cut">The section box round the clash region.</param>
        /// <returns>The camera (scene-local eye).</returns>
        private ClashView FrameClash(ClashRecord clash, float currentYaw, out Vector3 point, out SectionCut cut)
        {
            Vector3 origin = Scene.OriginOffset;
            point = new Vector3((float)(clash.X - origin.X), (float)(clash.Y - origin.Y), (float)(clash.Z - origin.Z));
            Aabb boxA = ClashBoundsOf(_clashElementA, _clashDynamicA, point);
            Aabb boxB = ClashBoundsOf(_clashElementB, _clashDynamicB, point);
            Aabb section = ClashFraming.SectionFor(boxA, boxB, point);
            cut = new SectionCut
            {
                BoxOn = true,
                MinX = section.Min.X + origin.X, MinY = section.Min.Y + origin.Y, MinZ = section.Min.Z + origin.Z,
                MaxX = section.Max.X + origin.X, MaxY = section.Max.Y + origin.Y, MaxZ = section.Max.Z + origin.Z
            };
            return ClashFraming.Frame(point, boxA, boxB, section, currentYaw);
        }

        /// <summary>
        /// The next / previous clash in the list (wrapping round, with a word when it does).
        /// </summary>
        private void StepClash(int direction)
        {
            RefreshClashList();
            if (_clashList.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("No clashes in the list (check the filters, or run the test)", 2.5f);
                return;
            }
            int index = _clashCurrent == null ? -1 : _clashList.IndexOf(_clashCurrent);
            int next = index < 0 ? (direction > 0 ? 0 : _clashList.Count - 1) : index + direction;
            if (next >= _clashList.Count) { next = 0; Toast("Back to the first clash", 1.6f); }
            else if (next < 0) { next = _clashList.Count - 1; Toast("The last clash", 1.6f); }
            GoToClash(_clashList[next], animate: !_clashInstant);
        }

        /// <summary>
        /// Finds a clash element as walked: a clone / placement by its clone key; a model element by link + UniqueId,
        /// or its moved instance when it was moved; nothing when it was demolished / deleted or isn't in this snapshot.
        /// </summary>
        private void ResolveClashElement(ClashElementRef reference, out int element, out DynamicInstance instance)
        {
            element = -1;
            instance = null;
            if (reference == null) { return; }
            if (reference.CloneKey > 0)
            {
                instance = Dynamics?.Instances.FirstOrDefault(d => d.IsClone && d.CloneKey == reference.CloneKey && !d.Hidden);
                return;
            }

            if (_clashElementByKey == null)
            {
                _clashElementByKey = new Dictionary<string, int>(Scene.Elements.Length, StringComparer.Ordinal);
                for (int i = 0; i < Scene.Elements.Length; i++)
                {
                    if (!Scene.Elements[i].IsLibraryTemplate) { _clashElementByKey.TryAdd(ClashMerge.ElementKey(Scene, i), i); }
                }
            }
            if (!_clashElementByKey.TryGetValue(reference.Key, out int found)) { return; }
            if (!_hidden[found])
            {
                element = found;
                return;
            }
            DynamicInstance moved = Dynamics?.FindOriginal(found);
            if (moved != null && !moved.Hidden) { instance = moved; }
        }

        /// <summary>An element's current box (a small box round the point when it isn't found).</summary>
        private Aabb ClashBoundsOf(int element, DynamicInstance instance, Vector3 point)
        {
            if (instance != null) { return instance.WorldBounds; }
            if (element >= 0) { return Scene.Elements[element].Bounds; }
            return new Aabb(point - new Vector3(0.1f), point + new Vector3(0.1f));
        }

        #endregion

        #region View and section box

        /// <summary>G / the VIEW dropdown: how the rest of the model draws round the pair.</summary>
        private void SetClashView(int view)
        {
            _clashView = Math.Clamp(view, 0, CLASH_VIEW_NAMES.Length - 1);
            _clashThumbVersion++; // row pictures follow the view
            RefreshClashViewLabels();
            Sound.Play(SoundId.UiClick);
            Toast(_clashView switch
            {
                CLASH_VIEW_WIREFRAME => "Clash view: the rest of the model as wireframe",
                CLASH_VIEW_REAL => "Clash view: the real model (the pair tinted)",
                CLASH_VIEW_HIDDEN => "Clash view: only the pair",
                _ => "Clash view: the rest of the model ghosted"
            } + $" ({Key(InputAction.ClashView)} cycles)", 2f);
        }

        /// <summary>
        /// B / BOX: switches the section box off, or back on round the current clash.
        /// </summary>
        private void ToggleClashBox()
        {
            if (_clashBoxOn)
            {
                _clashBoxOn = false;
                if (_section.IsActive)
                {
                    _section.BoxOn = false;
                    _section.PlaneOn = false;
                    SectionChanged();
                }
                Sound.Play(SoundId.Remove);
                Toast($"Section box off, from clash to clash too ({Key(InputAction.ClashSectionToggle)} puts it back round the clash)", 2.5f);
            }
            else
            {
                if (_clashCurrent == null || _clashSection == null)
                {
                    Sound.Play(SoundId.Error);
                    Toast("Pick a clash first: the box goes round it", 2f);
                    return;
                }
                _clashBoxOn = true;
                ApplySection(_clashSection, announce: false);
                Sound.Play(SoundId.UiClick);
                Toast("Section box on: round each clash you go to", 2f);
            }
            _clashThumbVersion++; // row pictures follow the box
            RefreshClashViewLabels();
        }

        /// <summary>The dock's VIEW / BOX button text (rebuilt when they change, not per frame).</summary>
        private void RefreshClashViewLabels()
        {
            _clashViewLabel = $"VIEW: {CLASH_VIEW_NAMES[_clashView]} ({Hotkeys.Label(InputAction.ClashView)})";
            _clashBoxLabel = $"BOX: {(_clashBoxOn ? "ON" : "OFF")} ({Hotkeys.Label(InputAction.ClashSectionToggle)})";
            _clashThumbLabel = _clashThumbsOn ? "PICTURES: ON" : "PICTURES: OFF";
        }

        #endregion

        #region Status and Revit

        /// <summary>
        /// Polish round P-B: the next status for the picked group or the current clash (new → active → reviewed →
        /// approved → resolved → new), through <see cref="SetCurrentClashStatus"/>.
        /// </summary>
        private void CycleCurrentClashStatus()
        {
            string status = _clashGroupCurrent?.Status ?? _clashCurrent?.Status;
            if (status == null)
            {
                Sound.Play(SoundId.Error);
                return;
            }
            int next = (ClashStatus.IndexOf(status) + 1) % ClashStatus.All.Length;
            SetCurrentClashStatus(ClashStatus.All[next]);
        }

        /// <summary>1–5: the current clash's status (stamped with who and when).</summary>
        private void SetCurrentClashStatus(string status)
        {
            if (_clashGroupCurrent != null)
            {
                SetClashGroupStatus(_clashGroupCurrent, status); // C-C1: a group row picked: the group and every member
                return;
            }
            if (_clashCurrent == null)
            {
                Sound.Play(SoundId.Error);
                return;
            }

            // C-B3: every selected clash (or the current one); their comments follow (clash → comment, one save)
            IReadOnlyList<ClashRecord> targets = ClashTargets();
            int changed = 0;
            bool commentsChanged = false;
            foreach (ClashRecord clash in targets)
            {
                if (clash.Status == status) { continue; }
                ClashMerge.SetStatus(clash, status, Environment.UserName, DateTime.UtcNow);
                commentsChanged |= SyncClashComment(clash, save: false);
                changed++;
            }
            if (changed == 0) { return; }
            ClashesChanged();
            if (commentsChanged) { Comments.Save(); }
            _clashListDirty = true;
            _clashRowsDirty = true;
            Sound.Play(SoundId.UiClick);
            Toast(changed == 1 ? $"Clash {ClashStatus.Label(status).ToLowerInvariant()}" : $"{changed} clashes {ClashStatus.Label(status).ToLowerInvariant()}", 1.6f);
        }

        /// <summary>
        /// R / REVIT: shows the clash in Revit (live sessions). C-B2: one request selects the pair (host, linked or one of
        /// each, together) and sets up a 3D view named "BimGo clash" (made once, then reused) with the clash's section
        /// box (on or off as in BimGo), turned to look the way BimGo does, made active and zoomed to the region. An older
        /// add-in reads the same request as a plain selection (it ignores the view part).
        /// </summary>
        private void ShowClashInRevit() => ShowClashInRevit(confirmed: false);

        /// <summary>R / REVIT; above <see cref="CLASH_REVIT_WARN"/> selected clashes it asks first (C-B4).</summary>
        private void ShowClashInRevit(bool confirmed)
        {
            if (_clashCurrent == null) { return; }
            if (!confirmed && ClashMultiActive && _clashSelected.Count > CLASH_REVIT_WARN && _live != null && _live.Connected)
            {
                int elements = _clashMultiA.Count + _clashMultiB.Count + _clashMultiBoth.Count
                    + _clashMultiDynamicA.Count + _clashMultiDynamicB.Count + _clashMultiDynamicBoth.Count;
                OpenConfirm("SHOW IN REVIT", $"{_clashSelected.Count:N0} clashes ({elements:N0} elements): Revit can take a while to select that many.",
                    "SHOW THEM", danger: false, offerSkip: false, ok => { if (ok) { ShowClashInRevit(confirmed: true); } });
                return;
            }
            if (_live == null)
            {
                Toast("Showing a clash in Revit needs a live Revit session (press Go in Revit)");
                return;
            }
            if (!_live.Connected)
            {
                Toast("Not connected to Revit", important: true);
                return;
            }

            var hostIds = new List<long>(2);
            var linked = new List<LinkedElementRef>(2);
            if (ClashMultiActive)
            {
                // C-B3: every selected pair, one view whose box covers them all
                foreach (int element in _clashMultiA) { AddRevitTarget(element, null, hostIds, linked); }
                foreach (DynamicInstance instance in _clashMultiDynamicA) { AddRevitTarget(-1, instance, hostIds, linked); }
                foreach (int element in _clashMultiB) { AddRevitTarget(element, null, hostIds, linked); }
                foreach (DynamicInstance instance in _clashMultiDynamicB) { AddRevitTarget(-1, instance, hostIds, linked); }
                foreach (int element in _clashMultiBoth) { AddRevitTarget(element, null, hostIds, linked); }
                foreach (DynamicInstance instance in _clashMultiDynamicBoth) { AddRevitTarget(-1, instance, hostIds, linked); }
            }
            else
            {
                AddRevitTarget(_clashElementA, _clashDynamicA, hostIds, linked);
                AddRevitTarget(_clashElementB, _clashDynamicB, hostIds, linked);
            }
            if (hostIds.Count == 0 && linked.Count == 0)
            {
                Toast("Neither element is in Revit (clones not created yet, or demolished)", 3f);
                return;
            }

            // The region and camera in Revit internal metres (the section box is the clash's, whether on or off here)
            Vector3 origin = Scene.OriginOffset;
            SectionCut box = _clashSection;
            Vector3 eye = _clashFrame.Eye + origin;
            float cp = MathF.Cos(_clashFrame.Pitch);
            var request = new ClashViewRequest
            {
                Name = ClashViewRequest.DEFAULT_NAME,
                SectionBox = _clashBoxOn,
                MinX = box?.MinX ?? 0, MinY = box?.MinY ?? 0, MinZ = box?.MinZ ?? 0,
                MaxX = box?.MaxX ?? 0, MaxY = box?.MaxY ?? 0, MaxZ = box?.MaxZ ?? 0,
                EyeX = eye.X, EyeY = eye.Y, EyeZ = eye.Z,
                DirectionX = cp * MathF.Cos(_clashFrame.Yaw), DirectionY = cp * MathF.Sin(_clashFrame.Yaw), DirectionZ = MathF.Sin(_clashFrame.Pitch)
            };

            Win32.AllowSetForegroundWindow(_live.RevitPid);
            if (!_live.ShowClash(hostIds, linked, request))
            {
                Toast("Revit didn't take the request", important: true);
                return;
            }
            Sound.Play(SoundId.UiClick);
            Toast("Showing the clash in Revit (“" + ClashViewRequest.DEFAULT_NAME + "” 3D view)…", 3f);
        }

        private void AddRevitTarget(int element, DynamicInstance instance, List<long> hostIds, List<LinkedElementRef> linked)
        {
            if (instance != null)
            {
                if (instance.RevitId > 0) { hostIds.Add(instance.RevitId); }
                return;
            }
            if (element < 0) { return; }
            ElementRecord record = Scene.Elements[element];
            LinkInfo link = Scene.LinkOf(record);
            if (link == null) { hostIds.Add(record.ElementId); }
            else if (link.InstanceId > 0) { linked.Add(new LinkedElementRef { LinkInstanceId = link.InstanceId, ElementId = record.ElementId }); }
        }

        #endregion

        #region Drawing

        /// <summary>
        /// The clash view in place of the scene passes, by view (G): <b>ghost</b> (the pair opaque in red / green, the
        /// ground, then everything as faint grey glass behind the pair by polygon offset, no sun shadows); <b>wireframe</b>
        /// (the pair, then everything as grey lines, its own lines pushed behind its surfaces); <b>real model</b> (the
        /// normal scene with shadows, caps and glass, the pair tinted over it like a gun highlight); <b>hidden</b> (only
        /// the pair and the ground).
        /// </summary>
        private void DrawClashView(in SceneDrawParams p)
        {
            if (_clashView == CLASH_VIEW_REAL)
            {
                DrawClashRealView(p);
                return;
            }

            SceneDrawParams q = p with { Sun = false };
            DrawClashPair(q);
            _renderer.DrawGround(Camera, _groundZ);
            if (_clashView == CLASH_VIEW_HIDDEN) { return; }

            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            Gl.DepthMask(false);
            bool wire = _clashView == CLASH_VIEW_WIREFRAME;
            if (wire)
            {
                // Everything else as lines (the triangles' edges), drawn with the ghost colour
                Gl.Enable(Gl.POLYGON_OFFSET_LINE);
                Gl.PolygonOffset(1f, 2f);
                Gl.PolygonMode(Gl.FRONT_AND_BACK, Gl.LINE);
                _renderer.GhostAlpha = CLASH_WIRE;
            }
            else
            {
                // Everything else, ghosted (the pair's own ghost lies behind its opaque copy and fails the depth test)
                Gl.Enable(Gl.POLYGON_OFFSET_FILL);
                Gl.PolygonOffset(1f, 2f);
                _renderer.GhostAlpha = CLASH_GHOST;
            }
            _renderer.DrawStatic(q, _groupVisible, transparent: false);
            _renderer.DrawDynamic(q, Dynamics, transparent: false);
            _renderer.DrawStatic(q, _groupVisible, transparent: true);
            _renderer.DrawDynamic(q, Dynamics, transparent: true);
            _renderer.GhostAlpha = 0f;
            if (wire)
            {
                Gl.PolygonMode(Gl.FRONT_AND_BACK, Gl.FILL);
                Gl.Disable(Gl.POLYGON_OFFSET_LINE);
            }
            else { Gl.Disable(Gl.POLYGON_OFFSET_FILL); }
            Gl.DepthMask(true);
            Gl.Disable(Gl.BLEND);
        }

        /// <summary>The pair, opaque, in red (A) and green (B).</summary>
        private void DrawClashPair(in SceneDrawParams q)
        {
            if (ClashMultiActive)
            {
                DrawSelectedClashPairs(q); // C-B3: every selected pair
                return;
            }
            if (_clashElementA >= 0) { _renderer.DrawElementHighlight(q, _clashElementA, CLASH_A_TINT); }
            if (_clashDynamicA != null) { _renderer.DrawDynamicHighlight(q, _clashDynamicA, CLASH_A_TINT); }
            if (_clashElementB >= 0) { _renderer.DrawElementHighlight(q, _clashElementB, CLASH_B_TINT); }
            if (_clashDynamicB != null) { _renderer.DrawDynamicHighlight(q, _clashDynamicB, CLASH_B_TINT); }
        }

        /// <summary>
        /// The real model view: the normal scene passes (shadows, section caps, ground, glass), the pair tinted on top.
        /// </summary>
        private void DrawClashRealView(in SceneDrawParams p)
        {
            _renderer.DrawStatic(p, _groupVisible, transparent: false);
            _renderer.DrawDynamic(p, Dynamics, transparent: false);
            if (_sectionCount > 0)
            {
                float extent = Scene.Bounds.Size.Length() + 50f;
                _renderer.DrawSectionCaps(Camera.ViewProjection, Camera.Planes, Camera.Position, _groupVisible, Dynamics, _capColour, extent);
            }
            _renderer.DrawGround(Camera, _groundZ);

            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            Gl.Enable(Gl.POLYGON_OFFSET_FILL);
            Gl.PolygonOffset(-1f, -2f);
            DrawClashPair(p);
            Gl.Disable(Gl.POLYGON_OFFSET_FILL);

            Gl.DepthMask(false);
            _renderer.DrawProfileGhosts(p, _groupVisible, Dynamics); // colour round A: the profile's ghosted elements
            _renderer.DrawStatic(p, _groupVisible, transparent: true);
            _renderer.DrawDynamic(p, Dynamics, transparent: true);
            Gl.DepthMask(true);
            Gl.Disable(Gl.BLEND);
        }

        /// <summary>
        /// The list's clashes as dots (status colours; the current one larger, ringed), overlay only: never saved.
        /// </summary>
        private void DrawClashMarkers(Overlay3D overlay)
        {
            if (!_clashModeOn || _clashTool != CLASH_TOOL_NONE) { return; } // C-C2: a tool draws its own dots
            Vector3 origin = Scene.OriginOffset;
            int count = Math.Min(_clashList.Count, 4000);
            for (int i = 0; i < count; i++)
            {
                ClashRecord clash = _clashList[i];
                if (clash == _clashCurrent) { continue; }
                var point = new Vector3((float)(clash.X - origin.X), (float)(clash.Y - origin.Y), (float)(clash.Z - origin.Z));
                if (clash == _clashToolHover) { overlay.Dot(point, S(9f), Rgba.Hex(0xFFFFFF)); } // C-C3: the dot under the mouse
                if (_clashSelected.Count > 1 && _clashSelectedLookup.Contains(clash)) { overlay.Dot(point, S(7.5f), Rgba.Hex(0xFFFFFF)); } // C-B3: selected
                overlay.Dot(point, S(4.5f), StatusColour(clash.Status));
            }
            if (_clashCurrent != null)
            {
                var point = new Vector3((float)(_clashCurrent.X - origin.X), (float)(_clashCurrent.Y - origin.Y), (float)(_clashCurrent.Z - origin.Z));
                overlay.Dot(point, S(9f), Rgba.Hex(0xFFFFFF));
                overlay.Dot(point, S(6.5f), StatusColour(_clashCurrent.Status));
            }
        }

        #endregion
    }
}
