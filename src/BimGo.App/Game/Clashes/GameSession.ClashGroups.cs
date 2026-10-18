using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Native;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash groups in clash mode (Round C, build C-C1; Core <see cref="ClashGroups"/> / <see cref="ClashGrouping"/>).
    /// <list type="bullet">
    /// <item>The docked list shows a <b>group row</b> (chevron, name, member count, status, MIXED when members differ)
    /// among the clashes, sorted by the group's status and its deepest member; its members follow, indented, when
    /// expanded (chevron; per session). Filters apply to members: a group shows when any member does, with the shown
    /// count. Search also matches group names.</item>
    /// <item>A click on a group row selects its shown members (the C-B3 selection and union view) and shows the
    /// <b>group card</b>: status 1–5 (the group and every member), ASSIGN… (group and members), NOTES… (the group's),
    /// TO COMMENT (one comment for the group). Ctrl+click adds / removes a group's members (and picks it for MERGE).</item>
    /// <item><b>Right-click menu</b> on rows (over the list only; right-drag in the view still looks): GROUP SELECTED,
    /// ADD TO GROUP ›, REMOVE FROM GROUP, GROUP ALL ON &lt;A&gt; / &lt;B&gt; on clash rows; MERGE n GROUPS, ADD SELECTED,
    /// RENAME…, UNGROUP, EXPAND / COLLAPSE on group rows.</item>
    /// <item>Dock buttons GROUP (Ctrl+G), UNGROUP (Ctrl+Shift+G) and TOOLS ▾ (C-C2: GROUP BY BOX…, PICK POINTS, CLUSTER
    /// AROUND…, AUTO by element / level / category pair / level + category pair, remove automatic groups).</item>
    /// </list>
    /// A clash is in one group: grouping by hand moves clashes out of their old group (the toast says how many);
    /// automatic grouping never touches grouped clashes.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>One line of the docked list: a group row, or a clash row (a member when indented under its group).</summary>
        private sealed class ClashDisplayRow
        {
            public ClashGroup Group;   // the group row's group, or a member row's group
            public ClashRow Row;       // a clash row (null for a group row)
            public bool Member;        // indented under its group
            public string Title, Detail, Status;
            public bool Mixed;
            public ClashRecord First;  // a group row: its first shown member (its picture)
        }

        private readonly List<ClashDisplayRow> _clashDisplay = new();

        // Clash id → group / clash, rebuilt when the clash document changes (revision)
        private Dictionary<string, ClashGroup> _clashGroupOf = new(StringComparer.Ordinal);
        private Dictionary<string, ClashRecord> _clashById = new(StringComparer.Ordinal);
        private int _clashGroupIndexRevision = -1;
        private ClashDocument _clashGroupIndexDocument;

        // Expanded groups (per session), the group whose card shows, groups picked (click order: the first wins a merge)
        private readonly HashSet<string> _clashGroupExpanded = new(StringComparer.Ordinal);
        private ClashGroup _clashGroupCurrent;
        private readonly List<ClashGroup> _clashGroupPicks = new();
        private int _clashGroupsInTest;

        // The group card's text (built when it changes, not per frame) and the dock's button labels
        private string _clashGroupCardHeader, _clashGroupCardCounts, _clashGroupCardAssign, _clashGroupCardNotes;
        private bool _clashGroupCardMixed;
        private string _clashGroupButtonLabel, _clashUngroupButtonLabel;

        // Clicks found while drawing the list, acted on after the overlays (a group row, a chevron, a right-click)
        private ClashGroup _clashGroupClick, _clashGroupChevron;
        private ClashDisplayRow _clashMenuRow;
        private Vector2 _clashMenuAt;

        // RMB went down over the dock: no drag-look until it is released
        private bool _clashMenuLook;
        private float _clashDockX, _clashDockY, _clashDockW, _clashDockH;

        // Dropdown slots on the dock (11–15 in ClashDock)
        private const int DROP_DOCK_AUTO = 16, DROP_DOCK_MENU = 17, DROP_DOCK_ADD_TO = 18, DROP_DOCK_SHOW = 19;

        // C-C1 feedback: SHOW: all / groups only (ungrouped hidden) / ungrouped only (grouped hidden)
        private const int CLASH_SHOW_ALL = 0, CLASH_SHOW_GROUPS = 1, CLASH_SHOW_UNGROUPED = 2;
        private static readonly string[] CLASH_SHOW_CHOICES = { "ALL", "GROUPS ONLY (HIDE UNGROUPED)", "UNGROUPED ONLY (HIDE GROUPED)" };
        private static readonly string[] CLASH_SHOW_LABELS = { "SHOW: ALL", "SHOW: GROUPS", "SHOW: UNGROUPED" };
        private int _clashGroupFilter;

        // A group row's pencil clicked this frame (its comment picture's markup)
        private ClashGroup _clashGroupMarkupClick;

        // The list's scroll region (polish round P-A2: the shared ScrollRegion: wheel, thumb drag, track paging)
        private readonly ScrollRegion _clashListScroll = new();

        // C-C2: TOOLS ▾ (the grouping tools, then the automatic methods: the test's ungrouped open clashes, 2+ per group)
        private static readonly string[] CLASH_TOOL_ACTIONS =
        {
            "GROUP BY BOX…", "PICK POINTS", "CLUSTER AROUND THE CURRENT CLASH…",
            "AUTO: BY ELEMENT", "AUTO: BY LEVEL", "AUTO: BY CATEGORY PAIR", "AUTO: BY LEVEL + CATEGORY PAIR",
            "AUTO: BY GRID", "AUTO: BY GRID + LEVEL",
            "REMOVE AUTOMATIC GROUPS"
        };
        private const int TOOL_BOX = 0, TOOL_PICK = 1, TOOL_CLUSTER = 2, TOOL_AUTO_ELEMENT = 3, TOOL_AUTO_LEVEL = 4,
            TOOL_AUTO_CATEGORY = 5, TOOL_AUTO_LEVEL_CATEGORY = 6, TOOL_AUTO_GRID = 7, TOOL_AUTO_GRID_LEVEL = 8, TOOL_REMOVE_AUTO = 9;

        // The group's comment: make or update at the start of the next frame (0 none, 1 link members' comments, 2 replace them)
        private ClashGroup _clashGroupCommentPending;
        private int _clashGroupCommentMode;
        private bool _clashGroupCommentReplaceMarkup;
        private const int GROUP_COMMENT_KEEP = 0, GROUP_COMMENT_LINK = 1, GROUP_COMMENT_REPLACE = 2;

        #endregion

        #region Index and list

        /// <summary>The clash → group and id → clash lookups, rebuilt when the document changed.</summary>
        private void EnsureClashGroupIndex()
        {
            if (_clashDocument == null) { return; }
            if (_clashGroupIndexRevision == _clashRevision && ReferenceEquals(_clashGroupIndexDocument, _clashDocument)) { return; }
            _clashGroupIndexRevision = _clashRevision;
            _clashGroupIndexDocument = _clashDocument;
            _clashGroupOf = ClashGroups.Index(_clashDocument);
            _clashById = ClashGroups.ClashesById(_clashDocument);
            if (_clashGroupCurrent != null && !(_clashDocument.Groups?.Contains(_clashGroupCurrent) ?? false)) { _clashGroupCurrent = null; }
            _clashGroupPicks.RemoveAll(g => !(_clashDocument.Groups?.Contains(g) ?? false));
        }

        /// <summary>The group a clash is in, or null.</summary>
        private ClashGroup ClashGroupOf(ClashRecord clash)
        {
            if (clash == null) { return null; }
            EnsureClashGroupIndex();
            return _clashGroupOf.TryGetValue(clash.Id, out ClashGroup group) ? group : null;
        }

        /// <summary>
        /// The group name a search can match (empty when the clash is ungrouped). Used while the list filters.
        /// </summary>
        private string ClashGroupSearchText(ClashRecord clash) =>
            _clashGroupOf.TryGetValue(clash.Id, out ClashGroup group) ? ClashGroups.DisplayName(group) : string.Empty;

        /// <summary>
        /// Builds the display rows and the navigation list from the filtered, sorted clash rows: a group row where its
        /// first shown member would be (by the group's own status, then its deepest member), members after it (all in
        /// <see cref="_clashList"/>, only expanded groups' on screen), ungrouped clashes as before.
        /// </summary>
        private void BuildClashDisplay()
        {
            EnsureClashGroupIndex();
            _clashDisplay.Clear();
            _clashList.Clear();

            var buckets = new Dictionary<ClashGroup, List<ClashRow>>();
            var tops = new List<(int Status, double Depth, int Order, ClashGroup Group, ClashRow Row)>(_clashDockRows.Count);
            foreach (ClashRow row in _clashDockRows)
            {
                if (_clashGroupOf.TryGetValue(row.Clash.Id, out ClashGroup group))
                {
                    if (_clashGroupFilter == CLASH_SHOW_UNGROUPED) { continue; } // grouped hidden
                    if (!buckets.TryGetValue(group, out List<ClashRow> members))
                    {
                        members = new List<ClashRow>();
                        buckets[group] = members;
                        tops.Add((ClashStatus.IndexOf(group.Status), row.Clash.Distance, tops.Count, group, null));
                    }
                    members.Add(row);
                    continue;
                }
                if (_clashGroupFilter == CLASH_SHOW_GROUPS) { continue; } // ungrouped hidden
                tops.Add((ClashStatus.IndexOf(row.Clash.Status), row.Clash.Distance, tops.Count, null, row));
            }

            // Groups first (by status priority, then their deepest member), then the ungrouped clashes as before
            tops.Sort((p, q) =>
            {
                int c = (p.Group == null).CompareTo(q.Group == null);
                if (c == 0) { c = p.Status.CompareTo(q.Status); }
                if (c == 0) { c = q.Depth.CompareTo(p.Depth); }
                return c != 0 ? c : p.Order.CompareTo(q.Order);
            });

            foreach (var (_, _, _, group, row) in tops)
            {
                if (group == null)
                {
                    _clashDisplay.Add(new ClashDisplayRow { Row = row });
                    _clashList.Add(row.Clash);
                    continue;
                }
                List<ClashRow> members = buckets[group];
                _clashDisplay.Add(MakeClashGroupRow(group, members));
                bool expanded = _clashGroupExpanded.Contains(group.Id);
                foreach (ClashRow member in members)
                {
                    _clashList.Add(member.Clash);
                    if (expanded) { _clashDisplay.Add(new ClashDisplayRow { Row = member, Group = group, Member = true }); }
                }
            }

            _clashGroupsInTest = 0;
            if (_clashDocument.Groups != null)
            {
                foreach (ClashGroup group in _clashDocument.Groups)
                {
                    if (group.TestId == _clashReviewTest) { _clashGroupsInTest++; }
                }
            }
            _clashToolDotsDirty = true; // C-C2: the tools' dots and the cluster follow the list
            _clashSphereDirty = true;
            _clashGroupButtonLabel = "GROUP";     // feedback: no key in the label (too wide); the key hint names it
            _clashUngroupButtonLabel = "UNGROUP";
        }

        /// <summary>A group row's text: name, "5 of 7 shown · MIXED: 3 new, 2 active · assignee · notes", status.</summary>
        private ClashDisplayRow MakeClashGroupRow(ClashGroup group, List<ClashRow> shown)
        {
            ClashGroupSummary summary = ClashGroups.Summarise(group, _clashById);
            string count = shown.Count == group.Count ? $"{group.Count} clash{(group.Count == 1 ? string.Empty : "es")}" : $"{shown.Count} of {group.Count} shown";
            string detail = count + (summary.Mixed ? " · " + ClashStatusCounts(summary.ByStatus) : string.Empty) +
                (string.IsNullOrEmpty(group.AssignedTo) ? string.Empty : " · " + group.AssignedTo) +
                (string.IsNullOrEmpty(group.Notes) ? string.Empty : " · notes") +
                (string.IsNullOrEmpty(group.CommentId) ? string.Empty : " · comment");
            return new ClashDisplayRow
            {
                Group = group,
                Title = ClashGroups.DisplayName(group),
                Detail = detail,
                Status = ClashStatus.Label(group.Status).ToUpperInvariant(),
                Mixed = summary.Mixed,
                First = shown.Count > 0 ? shown[0].Clash : null
            };
        }

        /// <summary>"3 new, 2 active" (statuses with members only).</summary>
        private static string ClashStatusCounts(int[] byStatus)
        {
            var parts = new List<string>(ClashStatus.All.Length);
            for (int k = 0; k < byStatus.Length; k++)
            {
                if (byStatus[k] > 0) { parts.Add($"{byStatus[k]} {ClashStatus.All[k]}"); }
            }
            return string.Join(", ", parts);
        }

        /// <summary>The group card's text (built when the group or its details change).</summary>
        private void RefreshClashGroupCard()
        {
            ClashGroup group = _clashGroupCurrent;
            if (group == null) { return; }
            EnsureClashGroupIndex();
            ClashGroupSummary summary = ClashGroups.Summarise(group, _clashById);
            int shown = 0;
            foreach (ClashRecord clash in _clashList)
            {
                if (_clashGroupOf.TryGetValue(clash.Id, out ClashGroup of) && of == group) { shown++; }
            }
            _clashGroupCardMixed = summary.Mixed;
            _clashGroupCardHeader = $"GROUP · {group.Count} CLASH{(group.Count == 1 ? string.Empty : "ES")}" + (shown == group.Count ? string.Empty : $" · {shown} SHOWN");
            _clashGroupCardCounts = (summary.Mixed ? "Members: " + ClashStatusCounts(summary.ByStatus) : $"Every member {ClashStatus.Label(group.Status).ToLowerInvariant()}") +
                (group.KeyElement != null ? " · all on " + ClashGroups.ElementName(group.KeyElement) : string.Empty) +
                (string.IsNullOrEmpty(group.Notes) ? string.Empty : " · Notes: " + group.Notes.Replace('\n', ' '));
            _clashGroupCardAssign = string.IsNullOrEmpty(group.AssignedTo) ? "ASSIGN…" : "ASSIGNED: " + group.AssignedTo;
            _clashGroupCardNotes = string.IsNullOrEmpty(group.Notes) ? "NOTES…" : "NOTES (EDIT)…";
        }

        /// <summary>A group's members the list shows, in list order.</summary>
        private List<ClashRecord> ShownClashGroupMembers(ClashGroup group)
        {
            var members = new List<ClashRecord>();
            foreach (ClashRecord clash in _clashList)
            {
                if (_clashGroupOf.TryGetValue(clash.Id, out ClashGroup of) && of == group) { members.Add(clash); }
            }
            return members;
        }

        /// <summary>Every member of a group still in the document (shown or not).</summary>
        private List<ClashRecord> AllClashGroupMembers(ClashGroup group)
        {
            EnsureClashGroupIndex();
            return ClashGroups.Members(group, _clashById);
        }

        /// <summary>After a group change: stored (live: written now), list and card rebuilt.</summary>
        private void ClashGroupsChanged()
        {
            ClashesChanged();
            _clashListDirty = true;
            _clashRowsDirty = true;
        }

        #endregion

        #region Picking

        /// <summary>
        /// A click on a group row: plain = select its shown members (the union view; one member: GO) and show the group
        /// card; Ctrl = add / remove its members to / from the selection (and pick it for MERGE).
        /// </summary>
        private void ClickClashGroupRow(ClashGroup group, bool ctrl)
        {
            List<ClashRecord> members = ShownClashGroupMembers(group);
            if (members.Count == 0) { return; }
            Sound.Play(SoundId.UiClick);
            if (!ctrl)
            {
                if (members.Count == 1) { GoToClash(members[0], animate: !_clashInstant); }
                else
                {
                    ClearClashSelection();
                    _clashSelected.AddRange(members);
                    SyncClashLookup();
                    _clashCurrent = members[0];
                    _clashAnchor = members[0];
                    GoToSelectedClashes(animate: !_clashInstant);
                }
                _clashGroupPicks.Clear();
                _clashGroupPicks.Add(group);
                _clashGroupCurrent = group;
                RefreshClashGroupCard();
                return;
            }

            // Ctrl: the group's members in or out of the selection (starting from the clash on screen)
            if (_clashSelected.Count == 0 && _clashCurrent != null && _clashList.Contains(_clashCurrent)) { _clashSelected.Add(_clashCurrent); }
            SyncClashLookup();
            bool all = members.TrueForAll(_clashSelectedLookup.Contains);
            if (all)
            {
                var leaving = new HashSet<ClashRecord>(members);
                _clashSelected.RemoveAll(leaving.Contains);
                _clashGroupPicks.Remove(group);
            }
            else
            {
                foreach (ClashRecord clash in members)
                {
                    if (_clashSelectedLookup.Add(clash)) { _clashSelected.Add(clash); }
                }
                if (!_clashGroupPicks.Contains(group)) { _clashGroupPicks.Add(group); }
            }
            SyncClashLookup();
            List<ClashGroup> picks = _clashGroupPicks.ToList();
            _clashGroupCurrent = null;
            if (_clashSelected.Count == 0) { return; }
            if (_clashSelected.Count == 1)
            {
                GoToClash(_clashSelected[0], animate: !_clashInstant);
            }
            else
            {
                if (!_clashSelectedLookup.Contains(_clashCurrent)) { _clashCurrent = _clashSelected[^1]; }
                GoToSelectedClashes(animate: !_clashInstant);
            }
            _clashGroupPicks.Clear();
            _clashGroupPicks.AddRange(picks); // GoToClash may have cleared them
            Toast($"{_clashSelected.Count} clashes together · right-click a group row to merge the picked groups", 2.5f);
        }

        /// <summary>The chevron: a group's members shown or hidden in the list.</summary>
        private void ToggleClashGroupExpanded(ClashGroup group)
        {
            if (!_clashGroupExpanded.Remove(group.Id)) { _clashGroupExpanded.Add(group.Id); }
            Sound.Play(SoundId.UiClick);
            _clashListDirty = true;
        }

        /// <summary>COLLAPSE GROUP from a member's menu: the group folds and its row is kept in view.</summary>
        private void CollapseClashGroupFrom(ClashGroup group)
        {
            _clashGroupExpanded.Remove(group.Id);
            Sound.Play(SoundId.UiClick);
            _clashListDirty = true;
            _clashScrollToCurrent = true;
        }

        /// <summary>SHOW ▾: all, groups only or ungrouped only.</summary>
        private void SetClashGroupFilter(int filter)
        {
            _clashGroupFilter = Math.Clamp(filter, 0, CLASH_SHOW_LABELS.Length - 1);
            _clashListDirty = true;
            _clashListScroll.Reset();
        }

        /// <summary>
        /// The groups picked for MERGE: those clicked (in click order) whose shown members are all still selected, plus
        /// the right-clicked one (first when it wasn't picked).
        /// </summary>
        private List<ClashGroup> PickedClashGroups(ClashGroup clicked)
        {
            var groups = new List<ClashGroup>();
            foreach (ClashGroup group in _clashGroupPicks)
            {
                if (group.TestId != _clashReviewTest || !(_clashDocument.Groups?.Contains(group) ?? false)) { continue; }
                if (group != clicked && !ShownClashGroupMembers(group).TrueForAll(c => _clashSelected.Count > 1 && _clashSelectedLookup.Contains(c))) { continue; }
                groups.Add(group);
            }
            if (!groups.Contains(clicked)) { groups.Insert(0, clicked); }
            return groups;
        }

        /// <summary>The clashes a menu on a clash row acts on: the selection when the row is in it, else that clash.</summary>
        private List<ClashRecord> ClashMenuTargets(ClashRecord clash)
        {
            if (ClashMultiActive && _clashSelectedLookup.Contains(clash)) { return _clashSelected.ToList(); }
            return new List<ClashRecord> { clash };
        }

        #endregion

        #region Right-click menu

        /// <summary>Opens the right-click menu for a row (after the dock is drawn), at the mouse, kept inside the dock.</summary>
        private void OpenClashRowMenu(ClashDisplayRow row, Vector2 at)
        {
            var labels = new List<string>();
            var actions = new List<Action>();
            void Item(string label, Action action)
            {
                labels.Add(label);
                actions.Add(action);
            }

            if (row.Row == null)
            {
                // A group row
                ClashGroup group = row.Group;
                List<ClashGroup> picked = PickedClashGroups(group);
                if (picked.Count >= 2) { Item($"MERGE {picked.Count} GROUPS (INTO “{Shorten(ClashGroups.DisplayName(picked[0]), 28)}”)", () => MergeClashGroups(picked)); }
                int outside = ClashMultiActive ? _clashSelected.Count(c => ClashGroupOf(c) != group) : 0;
                if (outside > 0) { Item($"ADD THE {outside} SELECTED TO THIS GROUP", () => AddClashesToGroup(group, _clashSelected.ToList())); }
                Item("RENAME…", () => RenameClashGroup(group));
                // C-C2: the group's box (a group without one starts with a box round its members)
                Item("EDIT BOX…", () => BeginClashBoxTool(group));
                if (group.Box != null) { Item("RECOLLECT FROM ITS BOX", () => RecollectClashGroup(group, null)); }
                Item(_clashGroupExpanded.Contains(group.Id) ? "COLLAPSE" : "EXPAND", () => ToggleClashGroupExpanded(group));
                Item("UNGROUP (CLASHES STAY)", () => UngroupClashGroup(group));
            }
            else
            {
                ClashRecord clash = row.Row.Clash;
                List<ClashRecord> targets = ClashMenuTargets(clash);
                Item(targets.Count > 1 ? $"GROUP SELECTED ({targets.Count})" : "NEW GROUP (THIS CLASH)", () => GroupClashes(targets, null));
                if (_clashGroupsInTest > 0) { Item(targets.Count > 1 ? $"ADD {targets.Count} TO GROUP ›" : "ADD TO GROUP ›", () => OpenAddToGroupMenu(targets, at)); }
                int grouped = targets.Count(c => ClashGroupOf(c) != null);
                if (grouped > 0) { Item(grouped > 1 ? $"REMOVE {grouped} FROM THEIR GROUPS" : "REMOVE FROM GROUP", () => RemoveClashesFromGroups(targets)); }
                ClashGroup own = ClashGroupOf(clash);
                if (own != null && _clashGroupExpanded.Contains(own.Id))
                {
                    Item($"COLLAPSE GROUP “{Shorten(ClashGroups.DisplayName(own), 30)}”", () => CollapseClashGroupFrom(own));
                }
                Item("CLUSTER AROUND THIS…", () => BeginClashSphereTool(clash)); // C-C2
                Item($"GROUP ALL ON {Shorten(ClashGroups.ElementName(clash.A), 34)}", () => GroupAllOnClashElement(clash.A));
                if (clash.B.Key != clash.A.Key) { Item($"GROUP ALL ON {Shorten(ClashGroups.ElementName(clash.B), 34)}", () => GroupAllOnClashElement(clash.B)); }
            }

            float w = MathF.Min(S(340), _clashDockW - S(20));
            float x = Math.Clamp(at.X, _clashDockX + S(6), _clashDockX + _clashDockW - w - S(6));
            OpenDropdown(_clashList, DROP_DOCK_MENU, x, at.Y, w, 0f, labels, -1, i => actions[i]());
        }

        /// <summary>ADD TO GROUP ›: the test's groups as a second list (largest first).</summary>
        private void OpenAddToGroupMenu(List<ClashRecord> targets, Vector2 at)
        {
            List<ClashGroup> groups = ClashGroups.OfTest(_clashDocument, _clashReviewTest).OrderByDescending(g => g.Count).ToList();
            if (groups.Count == 0) { return; }
            var labels = groups.Select(g => $"{Shorten(ClashGroups.DisplayName(g), 40)} ({g.Count})").ToList();
            float w = MathF.Min(S(340), _clashDockW - S(20));
            float x = Math.Clamp(at.X, _clashDockX + S(6), _clashDockX + _clashDockW - w - S(6));
            OpenDropdown(_clashList, DROP_DOCK_ADD_TO, x, at.Y, w, 0f, labels, -1, i => AddClashesToGroup(groups[i], targets));
        }

        private static string Shorten(string text, int max) =>
            string.IsNullOrEmpty(text) || text.Length <= max ? text ?? string.Empty : text[..(max - 1)].TrimEnd() + "…";

        #endregion

        #region Actions

        /// <summary>
        /// GROUP / Ctrl+G / the menu: the clashes become a new group (each leaves its old group). Named after the
        /// element they all share (when several share one), else "Group N".
        /// </summary>
        /// <param name="clashes">The clashes.</param>
        /// <param name="keyElement">The element they share (null: found when there is one).</param>
        /// <param name="autoLabel">C-C2: an automatic label ("Cluster 3 · Level 2") instead of "Group N", or null.</param>
        /// <returns>The new group, or null.</returns>
        private ClashGroup GroupClashes(IReadOnlyList<ClashRecord> clashes, ClashElementRef keyElement, string autoLabel = null)
        {
            if (_clashDocument == null) { return null; }
            if (clashes == null || clashes.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("Pick clashes first (click, Ctrl / Shift click or a group row)", 2.5f);
                return null;
            }
            ClashGroup already = ClashGroupOf(clashes[0]);
            if (already != null && already.Count == clashes.Count && clashes.All(c => ClashGroupOf(c) == already))
            {
                Sound.Play(SoundId.Error);
                Toast($"Those clashes are already the group “{ClashGroups.DisplayName(already)}”", 2.5f);
                return null;
            }

            if (autoLabel == null) { keyElement ??= clashes.Count > 1 ? ClashGroups.CommonElement(clashes) : null; }
            ClashGroup group = ClashGroups.Create(_clashDocument, _clashReviewTest, clashes, null, keyElement, autoLabel, null, Environment.UserName, DateTime.UtcNow, out int moved);
            if (group == null) { return null; }
            _clashGroupExpanded.Add(group.Id);
            ClashGroupsChanged();
            RefreshClashList();
            _clashGroupCurrent = group;
            _clashGroupPicks.Clear();
            _clashGroupPicks.Add(group);
            RefreshClashGroupCard();
            Sound.Play(SoundId.Commit);
            Toast($"Grouped {group.Count} clash{(group.Count == 1 ? string.Empty : "es")}: “{ClashGroups.DisplayName(group)}”" +
                (moved > 0 ? $" ({moved} moved from other groups)" : string.Empty) + " · right-click the row to rename", 3f);
            return group;
        }

        /// <summary>GROUP ALL ON &lt;element&gt;: every unresolved clash of the test with that element (filters aside).</summary>
        private void GroupAllOnClashElement(ClashElementRef element)
        {
            List<ClashRecord> clashes = ClashGrouping.ForElement(_clashDocument, _clashReviewTest, element.Key);
            if (clashes.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("No open clash of this test has that element", 2.5f);
                return;
            }
            GroupClashes(clashes, element);
        }

        /// <summary>ADD TO GROUP: the clashes join a group (each leaves its old group).</summary>
        private void AddClashesToGroup(ClashGroup group, List<ClashRecord> clashes)
        {
            int added = ClashGroups.AddTo(_clashDocument, group, clashes, Environment.UserName, DateTime.UtcNow, out int moved);
            if (added == 0)
            {
                Toast("Already in that group", 2f);
                return;
            }
            ClashGroupsChanged();
            Sound.Play(SoundId.Commit);
            Toast($"{added} added to “{ClashGroups.DisplayName(group)}”" + (moved > 0 ? $" ({moved} moved from other groups)" : string.Empty), 2.5f);
        }

        /// <summary>REMOVE FROM GROUP: the clashes leave their groups (a group left empty goes).</summary>
        private void RemoveClashesFromGroups(List<ClashRecord> clashes)
        {
            int removed = ClashGroups.Remove(_clashDocument, clashes);
            if (removed == 0) { return; }
            ClashGroupsChanged();
            Sound.Play(SoundId.Remove);
            Toast($"{removed} clash{(removed == 1 ? string.Empty : "es")} taken out of {(removed == 1 ? "its group" : "their groups")}", 2.5f);
        }

        /// <summary>UNGROUP: the group goes, its clashes stay (ungrouped). Its comment, if any, stays as it is.</summary>
        private void UngroupClashGroup(ClashGroup group)
        {
            string name = ClashGroups.DisplayName(group);
            int count = group.Count;
            if (!ClashGroups.Ungroup(_clashDocument, group)) { return; }
            if (_clashGroupCurrent == group) { _clashGroupCurrent = null; }
            _clashGroupExpanded.Remove(group.Id);
            ClashGroupsChanged();
            Sound.Play(SoundId.Remove);
            Toast($"Ungrouped “{name}” (its {count} clash{(count == 1 ? string.Empty : "es")} stay)", 2.5f);
        }

        /// <summary>
        /// Ctrl+Shift+G / UNGROUP: the group on the card goes; else the selected clashes leave their groups.
        /// </summary>
        private void UngroupFromKeys()
        {
            if (_clashGroupCurrent != null)
            {
                UngroupClashGroup(_clashGroupCurrent);
                return;
            }
            List<ClashRecord> targets = ClashTargets().ToList();
            if (!targets.Any(c => ClashGroupOf(c) != null))
            {
                Sound.Play(SoundId.Error);
                Toast("Nothing grouped is picked (click a group row, or select grouped clashes)", 2.5f);
                return;
            }
            RemoveClashesFromGroups(targets);
        }

        /// <summary>MERGE GROUPS: the first picked takes the others' members (its name, status, assignee and notes stay).</summary>
        private void MergeClashGroups(List<ClashGroup> groups)
        {
            int total = groups.Sum(g => g.Count);
            ClashGroup merged = ClashGroups.Merge(_clashDocument, groups, Environment.UserName, DateTime.UtcNow);
            if (merged == null) { return; }
            foreach (ClashGroup group in groups)
            {
                if (group != merged) { _clashGroupExpanded.Remove(group.Id); }
            }
            ClashGroupsChanged();
            RefreshClashList();
            _clashGroupCurrent = merged;
            _clashGroupPicks.Clear();
            _clashGroupPicks.Add(merged);
            RefreshClashGroupCard();
            Sound.Play(SoundId.Commit);
            bool otherComments = groups.Any(g => g != merged && !string.IsNullOrEmpty(g.CommentId));
            Toast($"{groups.Count} groups merged into “{ClashGroups.DisplayName(merged)}” ({total} clashes)" +
                (otherComments ? " · the other groups' comments stay as they were" : string.Empty), 3f);
        }

        /// <summary>RENAME…: an empty name goes back to the automatic one.</summary>
        private void RenameClashGroup(ClashGroup group)
        {
            // An automatic name starts empty (typing replaces it; leaving it empty keeps the automatic one)
            BeginTextEdit("RENAME GROUP (empty = automatic name)", group.Name ?? string.Empty, 80, text =>
            {
                ClashGroups.Rename(_clashDocument, group, text, Environment.UserName, DateTime.UtcNow);
                ClashGroupsChanged();
                SyncClashGroupComment(group, save: true, text: true);
                Toast($"Group: “{ClashGroups.DisplayName(group)}”", 2f);
            });
        }

        /// <summary>
        /// TOOLS ▾ (C-C2): the grouping tools, or an automatic method over the test's ungrouped, unresolved clashes
        /// (filters aside; one method per run, so runs chain), or removing the automatic groups.
        /// </summary>
        private void RunClashToolAction(int action)
        {
            if (_clashDocument == null || _clashReviewTest == null) { return; }
            switch (action)
            {
                case TOOL_BOX: BeginClashBoxTool(null); return;
                case TOOL_PICK: BeginClashPickTool(); return;
                case TOOL_CLUSTER: BeginClashSphereTool(_clashCurrent); return;
                case TOOL_REMOVE_AUTO: RemoveAutomaticClashGroups(); return;
            }

            string method;
            List<ClashGroup> made;
            string user = Environment.UserName;
            DateTime utc = DateTime.UtcNow;
            switch (action)
            {
                case TOOL_AUTO_LEVEL:
                    method = "by level";
                    made = ClashGrouping.ByLevel(_clashDocument, _clashReviewTest, ClashGrouping.MIN_SIZE, user, utc);
                    break;
                case TOOL_AUTO_CATEGORY:
                    method = "by category pair";
                    made = ClashGrouping.ByCategoryPair(_clashDocument, _clashReviewTest, perLevel: false, ClashGrouping.MIN_SIZE, user, utc);
                    break;
                case TOOL_AUTO_LEVEL_CATEGORY:
                    method = "by level + category pair";
                    made = ClashGrouping.ByCategoryPair(_clashDocument, _clashReviewTest, perLevel: true, ClashGrouping.MIN_SIZE, user, utc);
                    break;
                case TOOL_AUTO_GRID:
                case TOOL_AUTO_GRID_LEVEL:
                    // Grids round B: the nearest grid intersection (and its level)
                    EnsureGridNodes();
                    if (_gridLocator.IsEmpty)
                    {
                        Sound.Play(SoundId.Error);
                        Toast("AUTO by grid: this model has no grid intersections (or the snapshot is older than grids: export again / F5)", 4f);
                        return;
                    }
                    bool perLevel = action == TOOL_AUTO_GRID_LEVEL;
                    method = perLevel ? "by grid + level" : "by grid";
                    made = ClashGrouping.ByGrid(_clashDocument, _clashReviewTest, ClashGridLookup, perLevel, ClashGrouping.MIN_SIZE, user, utc);
                    break;
                default:
                    method = "by element";
                    made = ClashGrouping.ByElement(_clashDocument, _clashReviewTest, ClashGrouping.MIN_SIZE, user, utc);
                    break;
            }

            Dictionary<string, ClashGroup> index = ClashGroups.Index(_clashDocument); // with the new groups
            int left = 0;
            foreach (ClashRecord clash in _clashDocument.Clashes)
            {
                if (clash.TestId == _clashReviewTest && clash.Status != ClashStatus.RESOLVED && !index.ContainsKey(clash.Id)) { left++; }
            }
            if (made.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast($"AUTO {method}: no {ClashGrouping.MIN_SIZE}+ ungrouped open clashes share one ({left:N0} left ungrouped)", 3f);
                return;
            }
            int grouped = made.Sum(g => g.Count);
            ClashGroupsChanged();
            Sound.Play(SoundId.Commit);
            Toast($"AUTO {method}: {made.Count:N0} group{(made.Count == 1 ? string.Empty : "s")} ({grouped:N0} clashes) · " +
                $"{left:N0} open clashes left ungrouped (grouped ones were left alone)", 4f);
        }

        /// <summary>REMOVE AUTOMATIC GROUPS: the test's automatic groups go (their clashes stay; hand-made groups kept).</summary>
        private void RemoveAutomaticClashGroups()
        {
            int before = _clashDocument.Groups?.Count ?? 0;
            _clashDocument.Groups?.RemoveAll(g => g.TestId == _clashReviewTest && g.Auto != null);
            if (_clashDocument.Groups != null && _clashDocument.Groups.Count == 0) { _clashDocument.Groups = null; }
            int removed = before - (_clashDocument.Groups?.Count ?? 0);
            if (removed == 0)
            {
                Toast("This test has no automatic groups", 2f);
                return;
            }
            if (_clashGroupCurrent != null && !(_clashDocument.Groups?.Contains(_clashGroupCurrent) ?? false)) { _clashGroupCurrent = null; }
            ClashGroupsChanged();
            Sound.Play(SoundId.Remove);
            Toast($"{removed} automatic group{(removed == 1 ? string.Empty : "s")} removed (their clashes stay; hand-made groups kept)", 3f);
        }

        /// <summary>1–5 / the group card's chips: the group's status and every member's (their comments follow).</summary>
        private void SetClashGroupStatus(ClashGroup group, string status)
        {
            EnsureClashGroupIndex();
            if (group.Status == status && !ClashGroups.Summarise(group, _clashById).Mixed) { return; }
            List<ClashRecord> changed = ClashGroups.SetStatus(group, status, _clashById, Environment.UserName, DateTime.UtcNow);
            bool comments = false;
            foreach (ClashRecord clash in changed) { comments |= SyncClashComment(clash, save: false); }
            comments |= SyncClashGroupComment(group, save: false);
            ClashGroupsChanged();
            if (comments) { Comments.Save(); }
            Sound.Play(SoundId.UiClick);
            Toast($"Group {ClashStatus.Label(status).ToLowerInvariant()} ({group.Count} clash{(group.Count == 1 ? string.Empty : "es")})", 1.8f);
        }

        /// <summary>ASSIGN… on the group card: the group's and every member's assignee (comments follow).</summary>
        private void BeginClashGroupAssign(ClashGroup group)
        {
            BeginTextEdit("ASSIGN GROUP TO (empty = unassigned; every member too)", group.AssignedTo, 60, text =>
            {
                List<ClashRecord> members = ClashGroups.SetAssignee(group, text, _clashById, Environment.UserName, DateTime.UtcNow);
                foreach (ClashRecord clash in members)
                {
                    CommentRecord comment = FindClashComment(clash);
                    if (comment != null) { Comments.SetIssue(comment, assignedTo: text, save: false); }
                }
                CommentRecord own = FindClashGroupComment(group);
                if (own != null) { Comments.SetIssue(own, assignedTo: text, save: false); }
                Comments?.Save();
                ClashGroupsChanged();
                Toast(text.Length == 0 ? "Group unassigned" : $"Group assigned to {text}", 2f);
            });
        }

        /// <summary>NOTES… on the group card: the group's own notes.</summary>
        private void BeginClashGroupNotes(ClashGroup group)
        {
            BeginTextEdit("GROUP NOTES (empty clears)", group.Notes, 280, text =>
            {
                ClashGroups.SetNotes(group, text, Environment.UserName, DateTime.UtcNow);
                ClashGroupsChanged();
                Toast(text.Length == 0 ? "Group notes cleared" : "Group notes saved", 2f);
            });
        }

        #endregion

        #region Group card

        /// <summary>
        /// The group card (in place of the clash details): header with MIXED, the name, member counts, status 1–5 for
        /// the group and every member, ASSIGN… and NOTES….
        /// </summary>
        private void BuildClashGroupCard(FontAtlas f, InputState input, float x, float y, float w)
        {
            ClashGroup group = _clashGroupCurrent;
            float cy = y;
            float used = _ui.Text(f.Small, x, cy, _clashGroupCardHeader ?? "GROUP", UiTheme.TEXT_MUTED, S(1.2f));
            if (_clashGroupCardMixed) { _ui.Text(f.Small, x + used + S(10), cy, "MIXED", Rgba.Hex(0xF59E0B), S(1.2f)); }
            cy += S(20);
            _ui.TextWrapped(f.Body, x, cy, w, ClashGroups.DisplayName(group), UiTheme.TEXT, maxLines: 1);
            cy += S(22);
            _ui.TextWrapped(f.Small, x, cy, w, _clashGroupCardCounts ?? string.Empty, UiTheme.TEXT_MUTED, maxLines: 3);
            cy += S(54);

            float chip = (w - S(4) * 4) / 5f;
            for (int k = 0; k < ClashStatus.All.Length; k++)
            {
                string status = ClashStatus.All[k];
                float bx = x + k * (chip + S(4));
                bool on = group.Status == status;
                bool hover = Hover(input, bx, cy, chip, S(28));
                _ui.Rect(bx, cy, chip, S(28), on ? StatusColour(status) : hover ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
                _ui.Outline(bx, cy, chip, S(28), MathF.Max(1f, UiScale), on ? StatusColour(status) : UiTheme.CONTROL_BORDER);
                _ui.TextCentred(f.Small, bx + chip * 0.5f, cy + S(7), CLASH_STATUS_SHORT[k], on ? Rgba.Hex(0x111827) : UiTheme.TEXT);
                if (hover && input.LeftPressed && (!on || _clashGroupCardMixed))
                {
                    input.ConsumeClicks();
                    SetClashGroupStatus(group, status);
                }
            }
            cy += S(34);

            float half = (w - S(6)) * 0.5f;
            if (SmallButton(f, input, x, cy, half, S(28), _clashGroupCardAssign ?? "ASSIGN…")) { BeginClashGroupAssign(group); }
            if (SmallButton(f, input, x + half + S(6), cy, half, S(28), _clashGroupCardNotes ?? "NOTES…")) { BeginClashGroupNotes(group); }
        }

        #endregion

        #region Group comment

        /// <summary>The group's comment, or null.</summary>
        private CommentRecord FindClashGroupComment(ClashGroup group) =>
            group == null || string.IsNullOrEmpty(group.CommentId) || Comments == null ? null : Comments.Find(group.CommentId);

        /// <summary>
        /// TO COMMENT on a group: one comment for every member (picture framed on them all). When it is the group's first
        /// comment and members already have their own, a choice: LINK (theirs stay, the group's lists them), REPLACE
        /// (theirs are closed, pointing to the group's) or CANCEL. An existing group comment is updated (a marked-up
        /// picture only after a confirm).
        /// </summary>
        private void ClashGroupToComment(ClashGroup group)
        {
            if (Comments == null)
            {
                Sound.Play(SoundId.Error);
                Toast("Comments aren't available in this session", 3f, important: true);
                return;
            }
            List<ClashRecord> members = AllClashGroupMembers(group);
            if (members.Count == 0) { return; }

            CommentRecord own = FindClashGroupComment(group);
            if (own != null)
            {
                if (own.HasMarkup)
                {
                    OpenChoice("UPDATE GROUP COMMENT?", "The group's comment picture has markup. UPDATE refreshes its view, status and text and keeps the marked-up picture; tick to replace it.",
                        "UPDATE", danger: false, "Replace the marked-up picture", null,
                        replace => QueueClashGroupComment(group, GROUP_COMMENT_KEEP, replace), null);
                    return;
                }
                QueueClashGroupComment(group, GROUP_COMMENT_KEEP, replaceMarkup: true);
                return;
            }

            int theirs = members.Count(c => FindClashComment(c) != null);
            if (theirs == 0)
            {
                QueueClashGroupComment(group, GROUP_COMMENT_KEEP, replaceMarkup: true);
                return;
            }
            OpenChoice("GROUP COMMENT", $"{theirs} of the group's {members.Count} clashes already have their own comment. LINK keeps them and lists them in the group's comment; " +
                "REPLACE closes them with a reply pointing to the group's comment (and unlinks them from their clashes).",
                "LINK", danger: false, null, "REPLACE",
                _ => QueueClashGroupComment(group, GROUP_COMMENT_LINK, replaceMarkup: true),
                _ => QueueClashGroupComment(group, GROUP_COMMENT_REPLACE, replaceMarkup: true));
        }

        /// <summary>MARKUP on the group card: the markup editor on the group comment's picture (back to clash mode after).</summary>
        private void OpenClashGroupMarkup(ClashGroup group)
        {
            CommentRecord comment = FindClashGroupComment(group);
            if (comment == null || (comment.SnapshotData == null && comment.SnapshotOriginalData == null))
            {
                Sound.Play(SoundId.Error);
                Toast(comment == null ? "This group has no comment yet: GROUP TO COMMENT makes one (with its picture)"
                    : "The group's comment has no picture: UPDATE GROUP COMMENT takes one", 3f);
                return;
            }
            OpenMarkup(comment, returnToGame: true);
        }

        private void QueueClashGroupComment(ClashGroup group, int mode, bool replaceMarkup)
        {
            _clashGroupCommentPending = group;
            _clashGroupCommentMode = mode;
            _clashGroupCommentReplaceMarkup = replaceMarkup;
        }

        /// <summary>The pending group comment (start of a frame): framed on every member, then made or updated.</summary>
        private void MakePendingClashGroupComment()
        {
            ClashGroup group = _clashGroupCommentPending;
            int mode = _clashGroupCommentMode;
            bool replaceMarkup = _clashGroupCommentReplaceMarkup;
            _clashGroupCommentPending = null;
            if (group == null || Comments == null || _clashDocument == null || !(_clashDocument.Groups?.Contains(group) ?? false)) { return; }
            List<ClashRecord> members = AllClashGroupMembers(group);
            if (members.Count == 0 || !EnsureClashShotTargets()) { return; }

            bool rendered = RenderClashGroupPicture(members, out ClashView frame, out SectionCut cut, out Vector3 centre);
            if (!rendered)
            {
                ReleaseClashShotTargets();
                Sound.Play(SoundId.Error);
                Toast("The group picture couldn't be taken (see the log)", 3f, important: true);
                return;
            }

            bool created = MakeClashGroupComment(group, members, frame, cut, centre, mode, replaceMarkup, out int replaced);
            ReleaseClashShotTargets();
            Comments.Save();
            ClashGroupsChanged();
            Sound.Play(SoundId.Commit);
            Toast((created ? $"Group comment made ({members.Count} clashes, every element listed)" : "Group comment updated: new picture, view, status and text") +
                (replaced > 0 ? $" · {replaced} member comment{(replaced == 1 ? string.Empty : "s")} closed, pointing to it" : string.Empty) +
                " (Esc → COMMENTS · EXPORT BCF)", 3.5f);
        }

        /// <summary>
        /// Renders the group's picture into the comment buffer: one member from its own framing; several from the union
        /// framing (every pair drawn, the section box over all their regions when the box is on and they are at most
        /// <see cref="CLASH_FOCUS_BOX_CAP"/>, the camera far enough back to see them all). The selection, camera and
        /// section on screen are put back.
        /// </summary>
        private bool RenderClashGroupPicture(List<ClashRecord> members, out ClashView frame, out SectionCut cut, out Vector3 centre)
        {
            Vector3 origin = Scene.OriginOffset;
            ClashRecord first = members[0];
            centre = new Vector3((float)(first.X - origin.X), (float)(first.Y - origin.Y), (float)(first.Z - origin.Z));
            if (members.Count == 1)
            {
                return RenderClashPicture(first, CLASH_SHOT_W, CLASH_SHOT_H, 4, _clashShotTarget, _clashShotResolve, _clashShotPixels,
                    framed: true, out frame, out cut);
            }

            // The selection as it is (put back afterwards), then the members as the selection
            var selected = new List<ClashRecord>(_clashSelected);
            ClashRecord current = _clashCurrent;
            bool suspended = _clashMultiSuspended;
            SectionCut section = _section.Clone();
            Vector3 position = Camera.Position;
            float yaw = Camera.Yaw, pitch = Camera.Pitch;
            try
            {
                _clashMultiSuspended = false;
                _clashSelected.Clear();
                _clashSelected.AddRange(members);
                SyncClashLookup();
                _clashCurrent = first;
                ResolveSelectedClashes(out Aabb region, out Aabb boxesA, out Aabb boxesB);
                centre = region.Center;
                float distance = ClashFraming.DistanceToSee(region, _fov, (float)CLASH_SHOT_W / CLASH_SHOT_H);
                ClashView view = ClashFraming.Frame(region.Center, boxesA, boxesB, region, _player.Yaw, distance: distance);
                SectionCut box = _clashBoxOn && members.Count <= CLASH_FOCUS_BOX_CAP
                    ? new SectionCut
                    {
                        BoxOn = true,
                        MinX = region.Min.X + origin.X, MinY = region.Min.Y + origin.Y, MinZ = region.Min.Z + origin.Z,
                        MaxX = region.Max.X + origin.X, MaxY = region.Max.Y + origin.Y, MaxZ = region.Max.Z + origin.Z
                    }
                    : new SectionCut();
                SetSectionQuiet(box);
                Camera.Position = view.Eye;
                Camera.Yaw = view.Yaw;
                Camera.Pitch = view.Pitch;
                return RenderClashPicture(first, CLASH_SHOT_W, CLASH_SHOT_H, 4, _clashShotTarget, _clashShotResolve, _clashShotPixels,
                    framed: false, out frame, out cut);
            }
            finally
            {
                _clashSelected.Clear();
                _clashSelected.AddRange(selected);
                SyncClashLookup();
                _clashCurrent = current;
                _clashMultiSuspended = suspended;
                if (_clashSelected.Count > 1) { ResolveSelectedClashes(out _, out _, out _); }
                else
                {
                    _clashMultiA.Clear(); _clashMultiB.Clear(); _clashMultiBoth.Clear();
                    _clashMultiDynamicA.Clear(); _clashMultiDynamicB.Clear(); _clashMultiDynamicBoth.Clear();
                }
                SetSectionQuiet(section);
                Camera.Position = position;
                Camera.Yaw = yaw;
                Camera.Pitch = pitch;
                Camera.Update();
            }
        }

        /// <summary>
        /// Makes or updates the group's comment from the rendered picture: text (test, name, count, levels, every
        /// element, notes, linked comments), status from the group, priority high when any member is a deep hard
        /// crossing, the group's assignee, the view and section; LINK / REPLACE for members' own comments.
        /// </summary>
        /// <returns>True when the comment was made (false: updated).</returns>
        private bool MakeClashGroupComment(ClashGroup group, List<ClashRecord> members, ClashView frame, SectionCut cut, Vector3 centre,
            int mode, bool replaceMarkup, out int replaced)
        {
            replaced = 0;
            ClashTest test = _clashDocument.FindTest(group.TestId);
            string status = ClashCommentRules.CommentStatusFor(group.Status);
            string priority = members.Any(c => ClashCommentRules.PriorityFor(c, test?.Kind) == CommentPriority.HIGH) ? CommentPriority.HIGH : CommentPriority.NORMAL;

            // REPLACE: members' comments are closed with a reply pointing here, and unlinked from their clashes
            if (mode == GROUP_COMMENT_REPLACE)
            {
                string name = ClashGroups.DisplayName(group);
                foreach (ClashRecord clash in members)
                {
                    CommentRecord theirs = FindClashComment(clash);
                    if (theirs == null) { continue; }
                    Comments.SetIssue(theirs, status: CommentStatus.CLOSED, save: false);
                    Comments.AddReply(theirs, $"Replaced by the group comment “{name}”.");
                    clash.CommentId = null;
                    replaced++;
                }
            }

            string text = ClashGroupCommentText(group, test, members);
            CommentRecord record = FindClashGroupComment(group);
            bool created = record == null;
            if (created)
            {
                ClashElementRef key = group.KeyElement;
                bool host = key != null && string.IsNullOrEmpty(key.Link) && key.CloneKey == 0;
                record = Comments.Add(centre, text, host ? key.ElementId : -1, ClashLevel(members[0]), host ? key.UniqueId : null, save: false);
                record.ClashId = group.Id; // C-C1: a group comment holds the group's id (a clash comment holds the clash's)
                record.Status = status;
                record.Priority = priority;
                record.AssignedTo = string.IsNullOrWhiteSpace(group.AssignedTo) ? null : group.AssignedTo.Trim();
                group.CommentId = record.Id;
            }
            else
            {
                Comments.SetIssue(record, status: status, priority: priority, assignedTo: group.AssignedTo ?? string.Empty, save: false);
                record.ClashId ??= group.Id;
                if (record.Text != text) { Comments.Update(record, text); }
            }

            Comments.SetView(record, frame.Eye - Vector3.UnitZ * _player.Controller.StandEye, frame.Yaw, frame.Pitch, flying: true, save: false, section: cut);
            if (!record.HasMarkup || replaceMarkup)
            {
                string thumbnail = Convert.ToBase64String(EncodeJpeg(_clashShotPixels, CLASH_SHOT_W, CLASH_SHOT_H, THUMB_WIDTH, THUMB_HEIGHT, THUMB_JPEG_QUALITY));
                byte[] snapshot = EncodeJpeg(_clashShotPixels, CLASH_SHOT_W, CLASH_SHOT_H, CLASH_SHOT_W, CLASH_SHOT_H, SNAPSHOT_JPEG_QUALITY);
                Comments.SetPictures(record, thumbnail, snapshot, save: false);
            }
            return created;
        }

        /// <summary>
        /// "Clash group: test · name · 7 clashes · Level 1, Level 2 · Elements: … · Notes: … · Linked clash comments: …".
        /// </summary>
        private string ClashGroupCommentText(ClashGroup group, ClashTest test, List<ClashRecord> members)
        {
            const int MAX_ELEMENTS = 24, MAX_LINKED = 10;
            var levels = new List<string>();
            var elements = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (ClashRecord clash in members)
            {
                string level = ClashLevel(clash);
                if (!levels.Contains(level)) { levels.Add(level); }
                foreach (ClashElementRef element in new[] { clash.A, clash.B })
                {
                    if (seen.Add(element.Key)) { elements.Add($"{element.Category} · {ClashGroups.ElementName(element)}"); }
                }
            }
            string elementText = string.Join(", ", elements.Take(MAX_ELEMENTS)) + (elements.Count > MAX_ELEMENTS ? $" (+{elements.Count - MAX_ELEMENTS} more)" : string.Empty);
            string text = $"Clash group: {test?.Name ?? "clash test"} · {ClashGroups.DisplayName(group)} · {members.Count} clash{(members.Count == 1 ? string.Empty : "es")} · " +
                $"{string.Join(", ", levels)} · Elements ({elements.Count}): {elementText}";
            if (_grids.ClashComments)
            {
                // Grids round B: the members' grid locations (most common first, up to five)
                List<string> near = members.Select(c => ClashGridLocation(c)).Where(l => l.HasValue).Select(l => l.Value.Text)
                    .GroupBy(t => t, StringComparer.Ordinal).OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
                    .Select(g => g.Key).ToList();
                if (near.Count > 0) { text += " · Near " + string.Join(", ", near.Take(5)) + (near.Count > 5 ? $" (+{near.Count - 5} more)" : string.Empty); }
            }
            if (!string.IsNullOrWhiteSpace(group.Notes)) { text += " · Notes: " + group.Notes.Replace('\n', ' ').Trim(); }

            // LINK: members' own comments listed (by their pair)
            var linked = members.Where(c => FindClashComment(c) != null).ToList();
            if (linked.Count > 0)
            {
                text += $" · Linked clash comments ({linked.Count}): " + string.Join("; ", linked.Take(MAX_LINKED).Select(c => $"{c.A.Label} × {c.B.Label}")) +
                    (linked.Count > MAX_LINKED ? $" (+{linked.Count - MAX_LINKED} more)" : string.Empty);
            }
            return text;
        }

        /// <summary>
        /// The group's comment follows the group (status; with <paramref name="text"/>, its name in the text too).
        /// </summary>
        /// <returns>True when the comment changed.</returns>
        private bool SyncClashGroupComment(ClashGroup group, bool save, bool text = false)
        {
            CommentRecord record = FindClashGroupComment(group);
            if (record == null) { return false; }
            bool changed = Comments.SetIssue(record, status: ClashCommentRules.CommentStatusFor(group.Status), save: save);
            if (text)
            {
                List<ClashRecord> members = AllClashGroupMembers(group);
                string updated = ClashGroupCommentText(group, _clashDocument.FindTest(group.TestId), members);
                if (updated != record.Text) { changed |= Comments.Update(record, updated); }
            }
            return changed;
        }

        /// <summary>After a run or an imported report: group comments follow their groups' statuses (no save).</summary>
        private bool SyncClashGroupComments()
        {
            if (_clashDocument?.Groups == null || Comments == null) { return false; }
            bool changed = false;
            foreach (ClashGroup group in _clashDocument.Groups)
            {
                if (!string.IsNullOrEmpty(group.CommentId)) { changed |= SyncClashGroupComment(group, save: false); }
            }
            return changed;
        }

        #endregion
    }
}
