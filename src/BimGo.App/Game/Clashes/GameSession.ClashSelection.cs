using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Several clashes at once in clash mode (Round C, build C-B3). In the docked list a click goes to one clash (the
    /// selection is just that one); <b>Ctrl+click</b> adds or removes a clash, <b>Shift+click</b> selects the run from
    /// the last clicked one. With two or more selected the clash view shows every pair (A red, B green), the section
    /// box (when on) covers every selected clash's region, and the camera stands back far enough to see them all. The
    /// card shows the clicked clash; 1–5 set every selected clash's status, R shows them all in Revit, TO COMMENT makes
    /// a comment for each. `.` / `,`, a plain click, a test change or the filters hiding all but one go back to one.
    /// C-B4: SELECT ALL SHOWN (Ctrl+A) selects every clash the list shows: a focus on them all (amber where an element
    /// is A in one clash and B in another); the box stays off above 200 clashes, R asks first above 500.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        // The selected clashes in click order (empty or one: a single clash, shown as before)
        private readonly List<ClashRecord> _clashSelected = new();
        private ClashRecord _clashAnchor;

        // C-B4: the selection as a set (row tints and markers ask per clash per frame; thousands with SELECT ALL)
        private readonly HashSet<ClashRecord> _clashSelectedLookup = new();

        // C-B4: elements that are A in one selected clash and B in another (drawn amber)
        private readonly List<int> _clashMultiBoth = new();
        private readonly List<DynamicInstance> _clashMultiDynamicBoth = new();

        // C-B4: above this many selected clashes the section box stays off (it would be most of the building)
        private const int CLASH_FOCUS_BOX_CAP = 200;

        // C-B4: above this many, R asks first (Revit is slow to select thousands)
        private const int CLASH_REVIT_WARN = 500;

        // Amber: an element clashing as A in one selected clash and as B in another
        private static readonly Vector4 CLASH_BOTH_TINT = new(0.98f, 0.62f, 0.10f, 0.75f);

        // The SELECT ALL / CLEAR button's label (built when the counts change)
        private string _clashAllLabel;
        private int _clashAllLabelSelected = -1, _clashAllLabelShown = -1;

        // Every selected pair as walked (static elements and moved / cloned instances), drawn together
        private readonly List<int> _clashMultiA = new(), _clashMultiB = new();
        private readonly List<DynamicInstance> _clashMultiDynamicA = new(), _clashMultiDynamicB = new();

        // True while a single clash's picture renders (the selection is set aside)
        private bool _clashMultiSuspended;

        #endregion

        #region State

        /// <summary>True while two or more clashes are shown together.</summary>
        private bool ClashMultiActive => !_clashMultiSuspended && _clashSelected.Count > 1;

        /// <summary>True when a clash is part of the selection (two or more).</summary>
        private bool IsClashSelected(ClashRecord clash) => _clashSelected.Count > 1 && _clashSelectedLookup.Contains(clash);

        /// <summary>The lookup again after the selection list changed.</summary>
        private void SyncClashLookup()
        {
            _clashSelectedLookup.Clear();
            foreach (ClashRecord clash in _clashSelected) { _clashSelectedLookup.Add(clash); }
        }

        /// <summary>True when every clash the list shows is selected (two or more).</summary>
        private bool AllShownClashesSelected => _clashList.Count > 1 && _clashSelected.Count == _clashList.Count;

        /// <summary>The clashes 1–5, R and TO COMMENT act on: the selection, or the current clash.</summary>
        private IReadOnlyList<ClashRecord> ClashTargets()
        {
            if (ClashMultiActive) { return _clashSelected; }
            return _clashCurrent == null ? Array.Empty<ClashRecord>() : new[] { _clashCurrent };
        }

        #endregion

        #region Picking

        /// <summary>
        /// A click on a list row: plain = that clash alone; Ctrl = add / remove it; Shift = the run from the last clicked
        /// (Ctrl+Shift adds the run to the selection).
        /// </summary>
        private void ClickClashRow(ClashRecord clash, bool ctrl, bool shift)
        {
            if (clash == null) { return; }
            _clashGroupCurrent = null; // C-C1: a clash row shows the clash card
            if (!ctrl && !shift)
            {
                _clashAnchor = clash;
                GoToClash(clash, animate: !_clashInstant);
                return;
            }

            // Start from the clash on screen when nothing is selected yet
            if (_clashSelected.Count == 0 && _clashCurrent != null && _clashList.Contains(_clashCurrent)) { _clashSelected.Add(_clashCurrent); }
            SyncClashLookup();

            if (shift)
            {
                ClashRecord anchor = _clashAnchor != null && _clashList.Contains(_clashAnchor) ? _clashAnchor : _clashCurrent;
                int from = anchor == null ? -1 : _clashList.IndexOf(anchor), to = _clashList.IndexOf(clash);
                if (from < 0) { from = to; }
                if (!ctrl) { _clashSelected.Clear(); _clashSelectedLookup.Clear(); }
                for (int i = Math.Min(from, to); i <= Math.Max(from, to); i++)
                {
                    if (_clashSelectedLookup.Add(_clashList[i])) { _clashSelected.Add(_clashList[i]); }
                }
                _clashCurrent = clash;
            }
            else
            {
                _clashAnchor = clash;
                if (_clashSelected.Remove(clash))
                {
                    _clashSelectedLookup.Remove(clash);
                    if (_clashCurrent == clash) { _clashCurrent = _clashSelected.Count > 0 ? _clashSelected[^1] : null; }
                }
                else
                {
                    _clashSelected.Add(clash);
                    _clashSelectedLookup.Add(clash);
                    _clashCurrent = clash;
                }
            }

            Sound.Play(SoundId.UiClick);
            if (_clashSelected.Count == 0) { return; }
            if (_clashSelected.Count == 1)
            {
                ClashRecord only = _clashSelected[0];
                GoToClash(only, animate: !_clashInstant);
                return;
            }
            GoToSelectedClashes(animate: !_clashInstant);
            Toast($"{_clashSelected.Count} clashes together · Ctrl+click adds / removes · Shift+click a run · a plain click goes back to one", 2.5f);
        }

        /// <summary>Back to a single clash (the current one stays on screen).</summary>
        private void ClearClashSelection()
        {
            _clashGroupCurrent = null; // C-C1: the group card goes with the selection
            _clashGroupPicks.Clear();
            _clashSelected.Clear();
            _clashSelectedLookup.Clear();
            _clashMultiBoth.Clear();
            _clashMultiDynamicBoth.Clear();
            _clashMultiA.Clear();
            _clashMultiB.Clear();
            _clashMultiDynamicA.Clear();
            _clashMultiDynamicB.Clear();
        }

        /// <summary>
        /// After the list changed: drops selected clashes it no longer shows (one left: back to a single clash) and
        /// finds the remaining pairs again (the camera stays).
        /// </summary>
        private void PruneClashSelection()
        {
            if (_clashSelected.Count == 0) { return; }
            int before = _clashSelected.Count;
            var shown = new HashSet<ClashRecord>(_clashList);
            _clashSelected.RemoveAll(c => !shown.Contains(c));
            SyncClashLookup();
            if (_clashSelected.Count < 2)
            {
                ClearClashSelection();
                return;
            }
            if (_clashSelected.Count != before || _clashMultiA.Count + _clashMultiDynamicA.Count + _clashMultiB.Count + _clashMultiDynamicB.Count == 0)
            {
                ResolveSelectedClashes(out _, out _, out _);
            }
            if (!_clashSelectedLookup.Contains(_clashCurrent)) { _clashCurrent = _clashSelected[^1]; }
        }

        /// <summary>
        /// C-B4: SELECT ALL SHOWN (Ctrl+A): every clash the list shows (after its filters) becomes the selection and the
        /// view focuses on them all: every pair tinted (amber where an element is A in one clash and B in another),
        /// the rest by the model view (G), the camera far enough back to see them. A second press (all already
        /// selected) clears back to the current clash.
        /// </summary>
        private void ToggleSelectAllShownClashes()
        {
            _clashGroupCurrent = null; // C-C1
            if (AllShownClashesSelected)
            {
                ClashRecord keep = _clashCurrent;
                ClearClashSelection();
                Sound.Play(SoundId.UiClick);
                if (keep != null) { GoToClash(keep, animate: !_clashInstant); }
                return;
            }
            if (_clashList.Count < 2)
            {
                Sound.Play(SoundId.Error);
                Toast(_clashList.Count == 0 ? "No clash in the list to select" : "Only one clash in the list", 2f);
                return;
            }

            _clashSelected.Clear();
            _clashSelected.AddRange(_clashList);
            SyncClashLookup();
            if (_clashCurrent == null || !_clashSelectedLookup.Contains(_clashCurrent)) { _clashCurrent = _clashList[0]; }
            _clashAnchor = _clashCurrent;
            Sound.Play(SoundId.UiClick);
            GoToSelectedClashes(animate: !_clashInstant);
            string box = _clashSelected.Count > CLASH_FOCUS_BOX_CAP && _clashBoxOn
                ? $" · box off above {CLASH_FOCUS_BOX_CAP} ({Key(InputAction.ClashSectionToggle)} boxes them all)" : string.Empty;
            Toast($"All {_clashSelected.Count:N0} clashes shown together{box} · {Key(InputAction.ClashSelectAll)} again clears", 3f);
        }

        /// <summary>The SELECT ALL / CLEAR button's label (cached; changes with the counts).</summary>
        private string ClashSelectAllLabel()
        {
            int selected = ClashMultiActive ? _clashSelected.Count : 0;
            if (_clashAllLabel == null || selected != _clashAllLabelSelected || _clashList.Count != _clashAllLabelShown)
            {
                _clashAllLabelSelected = selected;
                _clashAllLabelShown = _clashList.Count;
                // C-C2: narrower (it shares a row with search and REPORT…; the key hint names the key)
                _clashAllLabel = AllShownClashesSelected ? $"CLEAR ALL {selected:N0}"
                    : selected > 1 ? $"SELECT ALL {_clashList.Count:N0}"
                    : "SELECT ALL";
            }
            return _clashAllLabel;
        }

        #endregion

        #region GO

        /// <summary>
        /// Shows the selected clashes together: every pair found as walked, the section box over all their regions (when
        /// on), the camera far enough back to see them, the clicked clash on the card.
        /// </summary>
        private void GoToSelectedClashes(bool animate)
        {
            if (_clashSelected.Count < 2) { return; }
            if (_clashCurrent == null || !_clashSelectedLookup.Contains(_clashCurrent)) { _clashCurrent = _clashSelected[^1]; }
            ResolveClashElement(_clashCurrent.A, out _clashElementA, out _clashDynamicA);
            ResolveClashElement(_clashCurrent.B, out _clashElementB, out _clashDynamicB);

            ResolveSelectedClashes(out Aabb region, out Aabb boxesA, out Aabb boxesB);
            Vector3 centre = region.Center;
            float distance = ClashFraming.DistanceToSee(region, _fov, Camera.Aspect);
            ClashView view = ClashFraming.Frame(centre, boxesA, boxesB, region, _player.Yaw, distance: distance);
            _clashFrame = view;

            Vector3 origin = Scene.OriginOffset;
            _clashSection = new SectionCut
            {
                BoxOn = true,
                MinX = region.Min.X + origin.X, MinY = region.Min.Y + origin.Y, MinZ = region.Min.Z + origin.Z,
                MaxX = region.Max.X + origin.X, MaxY = region.Max.Y + origin.Y, MaxZ = region.Max.Z + origin.Z
            };
            if (_clashBoxOn)
            {
                // C-B4: a box round hundreds of clashes is most of the building: off above the cap (B puts it on)
                if (_clashSelected.Count <= CLASH_FOCUS_BOX_CAP) { ApplySection(_clashSection, announce: false); }
                else if (_section.IsActive)
                {
                    _section.BoxOn = false;
                    _section.PlaneOn = false;
                    SectionChanged();
                }
            }

            var point = new Vector3((float)(_clashCurrent.X - origin.X), (float)(_clashCurrent.Y - origin.Y), (float)(_clashCurrent.Z - origin.Z));
            int room = FindRoom(point);
            _clashCurrentRoom = room >= 0 ? (string.IsNullOrWhiteSpace(Scene.Rooms[room].Number) || Scene.Rooms[room].Number == "—"
                ? Scene.Rooms[room].Name : $"{Scene.Rooms[room].Number} · {Scene.Rooms[room].Name}") : null;
            _clashScrollToCurrent = true;
            RefreshClashCard();
            FlyToClashView(view, animate);
        }

        /// <summary>
        /// Finds every selected pair as walked (into the multi lists) and the boxes they make together: the section
        /// regions, the A elements and the B elements.
        /// </summary>
        private void ResolveSelectedClashes(out Aabb region, out Aabb boxesA, out Aabb boxesB)
        {
            _clashMultiA.Clear();
            _clashMultiB.Clear();
            _clashMultiDynamicA.Clear();
            _clashMultiDynamicB.Clear();
            _clashMultiBoth.Clear();
            _clashMultiDynamicBoth.Clear();
            var seenA = new HashSet<int>();
            var seenB = new HashSet<int>();
            var seenDynamicA = new HashSet<DynamicInstance>();
            var seenDynamicB = new HashSet<DynamicInstance>();
            region = Aabb.Empty;
            boxesA = Aabb.Empty;
            boxesB = Aabb.Empty;
            Vector3 origin = Scene.OriginOffset;
            foreach (ClashRecord clash in _clashSelected)
            {
                ResolveClashElement(clash.A, out int a, out DynamicInstance da);
                ResolveClashElement(clash.B, out int b, out DynamicInstance db);
                if (a >= 0 && seenA.Add(a)) { _clashMultiA.Add(a); }
                if (da != null && seenDynamicA.Add(da)) { _clashMultiDynamicA.Add(da); }
                if (b >= 0 && seenB.Add(b)) { _clashMultiB.Add(b); }
                if (db != null && seenDynamicB.Add(db)) { _clashMultiDynamicB.Add(db); }

                var point = new Vector3((float)(clash.X - origin.X), (float)(clash.Y - origin.Y), (float)(clash.Z - origin.Z));
                Aabb boxA = ClashBoundsOf(a, da, point), boxB = ClashBoundsOf(b, db, point);
                Aabb section = ClashFraming.SectionFor(boxA, boxB, point);
                region.Include(section.Min);
                region.Include(section.Max);
                boxesA.Include(boxA.Min);
                boxesA.Include(boxA.Max);
                boxesB.Include(boxB.Min);
                boxesB.Include(boxB.Max);
            }

            // C-B4: an element in both lists is drawn once, amber (and still goes to Revit once)
            foreach (int element in _clashMultiA)
            {
                if (seenB.Contains(element)) { _clashMultiBoth.Add(element); }
            }
            foreach (DynamicInstance instance in _clashMultiDynamicA)
            {
                if (seenDynamicB.Contains(instance)) { _clashMultiDynamicBoth.Add(instance); }
            }
            if (_clashMultiBoth.Count > 0)
            {
                _clashMultiA.RemoveAll(seenB.Contains);
                _clashMultiB.RemoveAll(seenA.Contains);
            }
            if (_clashMultiDynamicBoth.Count > 0)
            {
                _clashMultiDynamicA.RemoveAll(seenDynamicB.Contains);
                _clashMultiDynamicB.RemoveAll(seenDynamicA.Contains);
            }
        }

        /// <summary>Every selected pair in red (A) and green (B).</summary>
        private void DrawSelectedClashPairs(in SceneDrawParams q)
        {
            foreach (int element in _clashMultiA) { _renderer.DrawElementHighlight(q, element, CLASH_A_TINT); }
            foreach (DynamicInstance instance in _clashMultiDynamicA) { _renderer.DrawDynamicHighlight(q, instance, CLASH_A_TINT); }
            foreach (int element in _clashMultiB) { _renderer.DrawElementHighlight(q, element, CLASH_B_TINT); }
            foreach (DynamicInstance instance in _clashMultiDynamicB) { _renderer.DrawDynamicHighlight(q, instance, CLASH_B_TINT); }
            foreach (int element in _clashMultiBoth) { _renderer.DrawElementHighlight(q, element, CLASH_BOTH_TINT); }
            foreach (DynamicInstance instance in _clashMultiDynamicBoth) { _renderer.DrawDynamicHighlight(q, instance, CLASH_BOTH_TINT); }
        }

        #endregion
    }
}
