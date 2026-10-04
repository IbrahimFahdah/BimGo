using System.Numerics;
using BimGo.Format;
using BimGo.Sources;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// How a walkthrough session ended.
    /// </summary>
    internal enum SessionEndReason
    {
        /// <summary>The window was closed (the app quits; in Revit the session ends).</summary>
        WindowClosed,

        /// <summary>The user chose End session / Close model (the app returns to its home screen).</summary>
        EndedByUser,

        /// <summary>The app is switching to another model (a Go request from Revit the user accepted).</summary>
        Switch,

        /// <summary>A newer live snapshot is ready: the app reloads it where the player stands.</summary>
        Reload
    }

    /// <summary>
    /// Where the player stood, carried across a reload. Positions are Revit internal metres (scene-local + origin),
    /// so they survive a new snapshot whose scene origin moved.
    /// </summary>
    internal sealed class SessionPose
    {
        public Vector3 Feet { get; init; }
        public float Yaw { get; init; }
        public float Pitch { get; init; }
        public bool Flying { get; init; }
        public Vector3 HomeFeet { get; init; }
        public float HomeYaw { get; init; }
        public float HomePitch { get; init; }
        public bool HomeFlying { get; init; }
        public int ActiveGun { get; init; }
        public bool ShowMap { get; init; } = true;
    }

    /// <summary>
    /// What a session runs against and how it fits into its host (the standalone app or Revit).
    /// </summary>
    internal sealed class SessionOptions
    {
        /// <summary>Where the model lives and where edits go. Required.</summary>
        public IModelSource Source { get; init; }

        /// <summary>
        /// The open .bimgo document (standalone files): its comments and journal are loaded into the session and it
        /// is what Save writes. Null for Revit sessions.
        /// </summary>
        public BimGoDocument Document { get; init; }

        /// <summary>True in the standalone app (End session returns to the home screen instead of closing).</summary>
        public bool InApp { get; init; }

        /// <summary>Start here instead of the snapshot's spawn (a reload), or null.</summary>
        public SessionPose Pose { get; init; }

        /// <summary>Who writes saved files (manifest generator).</summary>
        public WriterInfo Writer { get; init; } = new("BimGo", "3");

        /// <summary>
        /// Called with a .bimgo path dropped on the window; returns a message to show (or null).
        /// Null in Revit sessions (drops are declined with a hint).
        /// </summary>
        public Func<string, string> OnOpenRequest { get; init; }

        /// <summary>Called after the walkthrough was saved to a .bimgo (recent files list).</summary>
        public Action<string> OnSaved { get; init; }

        /// <summary>
        /// Polled about once a second; returns a message to show (e.g. "file queued") or null.
        /// </summary>
        public Func<string> PollNotices { get; init; }
    }
}
