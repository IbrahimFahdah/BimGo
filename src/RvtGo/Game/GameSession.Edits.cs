using System.Numerics;
using RvtGo.Bridge;
using RvtGo.Physics;
using RvtGo.Scene;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// Runtime element edits (hide, move, clone), the Revit bridge pump and the room readout.
    ///
    /// Edits are optimistic: the game changes immediately and the guns submit a request to Revit through the
    /// <see cref="BridgeChannel"/>; if Revit refuses, the gun's result callback puts things back.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private readonly bool[] _hidden;
        private readonly Dictionary<long, int> _elementIndexById;
        private readonly Dictionary<int, Action<BridgeResult>> _bridgeCallbacks = new();
        private float _bridgeWait;
        private int _nextCloneKey;

        // Room readout
        private int _roomIndex = -1;
        private Vector3 _roomCheckedAt = new(float.MaxValue);
        private float _roomBannerUntil;

        #endregion

        #region Element state

        /// <summary>Moved and cloned elements.</summary>
        public DynamicSet Dynamics { get; private set; }

        /// <summary>True if Revit write-back is available this session.</summary>
        public bool RevitLinked => _bridge != null;

        /// <summary>Revit requests still waiting for an answer.</summary>
        public int RevitPending => _bridge?.Pending ?? 0;

        /// <summary>
        /// True if a static element is hidden (demolished, deleted or replaced by its moved instance).
        /// </summary>
        public bool IsHidden(int element) => _hidden[element];

        /// <summary>
        /// True if a pick target still exists in the game: a visible static element or an active dynamic instance.
        /// </summary>
        public bool IsTargetPresent(int element, int dynamicId)
        {
            if (dynamicId > 0)
            {
                DynamicInstance instance = Dynamics.Find(dynamicId);
                return instance != null && Dynamics.IsActive(instance);
            }
            return element >= 0 && !_hidden[element];
        }

        /// <summary>
        /// Hides or restores a static element (drawing, picking and collision).
        /// </summary>
        public void SetStaticHidden(int element, bool hidden)
        {
            if (_hidden[element] == hidden) { return; }
            _hidden[element] = hidden;
            _renderer.SetElementHidden(element, hidden);

            bool visible = _categoryVisible[Scene.Elements[element].CategoryIndex] && !hidden;
            _pickMask[element] = visible;
            _collisionMask[element] = visible && Scene.Elements[element].CategoryIndex != _doorCategory;
        }

        /// <summary>
        /// The dynamic instance standing in for a static element, created on first use (the static copy is hidden).
        /// </summary>
        public DynamicInstance MakeDynamic(int element)
        {
            DynamicInstance existing = Dynamics.FindOriginal(element);
            if (existing != null) { return existing; }

            _renderer.EnsureDynamicGeometry(element);
            DynamicInstance instance = Dynamics.Create(element, Vector3.Zero, 0f, Scene.Elements[element].ElementId, isClone: false, cloneKey: 0);
            SetStaticHidden(element, true);
            return instance;
        }

        /// <summary>
        /// Puts a moved original back into the static scene if it is untransformed (tidies up after a cancelled move).
        /// </summary>
        public void RestoreIfUnmoved(DynamicInstance instance)
        {
            if (instance == null || instance.IsClone || instance.Hidden) { return; }
            if (instance.Offset.LengthSquared() > 1e-10f || MathF.Abs(instance.Angle) > 1e-6f) { return; }
            Dynamics.Remove(instance);
            SetStaticHidden(instance.Element, false);
        }

        /// <summary>
        /// Creates an uncommitted clone of a target, starting at the target's current transform.
        /// </summary>
        /// <param name="element">The source element.</param>
        /// <param name="source">The dynamic instance being cloned, or null for a static element.</param>
        public DynamicInstance CreateClone(int element, DynamicInstance source)
        {
            _renderer.EnsureDynamicGeometry(element);
            Vector3 offset = source?.Offset ?? Vector3.Zero;
            float angle = source?.Angle ?? 0f;
            return Dynamics.Create(element, offset, angle, revitId: 0, isClone: true, cloneKey: ++_nextCloneKey);
        }

        /// <summary>
        /// Hides everything Revit reports as deleted / demolished (static elements and dynamic instances).
        /// </summary>
        /// <returns>The number of game objects hidden.</returns>
        public int ApplyRevitRemovals(long[] revitIds)
        {
            int count = 0;
            foreach (long id in revitIds)
            {
                if (_elementIndexById.TryGetValue(id, out int element) && Dynamics.FindOriginal(element) == null && !_hidden[element])
                {
                    SetStaticHidden(element, true);
                    count++;
                }
                foreach (DynamicInstance instance in Dynamics.Instances)
                {
                    if (instance.RevitId == id && !instance.Hidden)
                    {
                        instance.Hidden = true;
                        count++;
                    }
                }
            }
            return count;
        }

        /// <summary>
        /// Scene-local metres to Revit internal metres.
        /// </summary>
        public Vector3 ToRevit(Vector3 local) => local + Scene.OriginOffset;

        #endregion

        #region Bridge

        /// <summary>
        /// Sends a request to Revit. The callback runs on the game thread when the answer arrives.
        /// </summary>
        /// <returns>False if Revit write-back is unavailable (the edit then stays in-game only).</returns>
        public bool SubmitToRevit(BridgeRequest request, Action<BridgeResult> onResult)
        {
            if (_bridge == null) { return false; }
            int ticket = _bridge.Submit(request);
            if (ticket < 0) { return false; }
            if (onResult != null) { _bridgeCallbacks[ticket] = onResult; }
            return true;
        }

        /// <summary>
        /// Delivers Revit's answers and re-signals Revit if requests have waited a while.
        /// </summary>
        private void PumpBridge(float dt)
        {
            if (_bridge == null) { return; }

            while (_bridge.TryGetResult(out BridgeResult result))
            {
                _bridgeWait = 0f;
                if (!_bridgeCallbacks.Remove(result.Ticket, out Action<BridgeResult> callback)) { continue; }
                try
                {
                    callback(result);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Bridge callback failed: {ex}");
                }
            }

            if (_bridge.Pending > 0)
            {
                _bridgeWait += dt;
                if (_bridgeWait > 1.5f)
                {
                    _bridgeWait = 0f;
                    _bridge.Nudge();
                }
            }
            else
            {
                _bridgeWait = 0f;
            }
        }

        #endregion

        #region Rooms

        /// <summary>The room the player is in, or null.</summary>
        public RoomInfo CurrentRoom => _roomIndex >= 0 ? Scene.Rooms[_roomIndex] : null;

        /// <summary>
        /// Re-evaluates the current room when the player has moved a little; starts the banner on a change.
        /// </summary>
        private void UpdateRoom()
        {
            if (Scene.Rooms.Length == 0) { return; }

            Vector3 feet = _player.Feet;
            if (Vector3.DistanceSquared(feet, _roomCheckedAt) < 0.05f * 0.05f) { return; }
            _roomCheckedAt = feet;

            int room = FindRoom(new Vector3(feet.X, feet.Y, feet.Z + 0.3f));
            if (room == _roomIndex) { return; }

            _roomIndex = room;
            if (room >= 0) { _roomBannerUntil = _clock + 2.4f; }
        }

        /// <summary>
        /// The smallest room volume containing the point, or -1.
        /// </summary>
        private int FindRoom(Vector3 point)
        {
            int best = -1;
            float bestHeight = float.MaxValue;
            RoomInfo[] rooms = Scene.Rooms;

            for (int i = 0; i < rooms.Length; i++)
            {
                RoomInfo room = rooms[i];
                if (point.Z < room.BottomZ || point.Z > room.TopZ) { continue; }
                if (point.X < room.Min.X || point.X > room.Max.X || point.Y < room.Min.Y || point.Y > room.Max.Y) { continue; }

                // Even-odd over all loops (islands become holes automatically)
                bool inside = false;
                foreach (Vector2[] loop in room.Loops)
                {
                    if (InsidePolygon(loop, point.X, point.Y)) { inside = !inside; }
                }
                if (!inside) { continue; }

                float height = room.TopZ - room.BottomZ;
                if (height < bestHeight)
                {
                    best = i;
                    bestHeight = height;
                }
            }
            return best;
        }

        /// <summary>
        /// Crossing-number point-in-polygon test.
        /// </summary>
        private static bool InsidePolygon(Vector2[] polygon, float x, float y)
        {
            bool inside = false;
            for (int i = 0, j = polygon.Length - 1; i < polygon.Length; j = i++)
            {
                Vector2 a = polygon[i], b = polygon[j];
                if ((a.Y > y) != (b.Y > y) && x < (b.X - a.X) * (y - a.Y) / (b.Y - a.Y) + a.X)
                {
                    inside = !inside;
                }
            }
            return inside;
        }

        #endregion
    }
}
