using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Utilities;
using Gl = BimGo.Native.Gl;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Runs a long task (opening, saving, building the scene) on a worker thread while the window keeps drawing a
    /// progress bar and stays responsive: Esc, the CANCEL button or closing the window asks the task to stop at its
    /// next safe point. The work must not touch GL or the window.
    /// </summary>
    internal static class ProgressScreen
    {
        /// <summary>
        /// Runs <paramref name="work"/> and waits for it, drawing progress.
        /// </summary>
        /// <typeparam name="T">The result type.</typeparam>
        /// <param name="window">The app window.</param>
        /// <param name="ui">The UI batch.</param>
        /// <param name="title">What is happening ("Opening Tower A.bimgo").</param>
        /// <param name="progress">The shared progress (the work reports to it and checks it).</param>
        /// <param name="work">The task (runs on a worker thread).</param>
        /// <param name="cancelOnClose">
        /// True if closing the window cancels the work (opening); false when the work is part of closing (saving
        /// before the window closes).
        /// </param>
        /// <returns>The work's result (exceptions in the work are rethrown here).</returns>
        public static T Run<T>(GameWindow window, UiBatch ui, string title, OperationProgress progress, Func<T> work, bool cancelOnClose = true)
        {
            Task<T> task = Task.Run(work);
            bool cancelHover = false;

            while (!task.IsCompleted)
            {
                // Closing the window, Esc or the button cancels; the loop keeps drawing until the work has stopped
                if (!window.PumpMessages() && cancelOnClose) { progress.Cancel(); }
                InputState input = window.Input;
                if (input.IsPressed(Vk.VK_ESCAPE)) { progress.Cancel(); }

                if (window.Width > 0 && window.Height > 0 && !window.IsMinimised)
                {
                    bool clicked = Draw(window, ui, title, progress, input, ref cancelHover);
                    if (clicked) { progress.Cancel(); }
                    window.Swap();
                }
                input.EndFrame();
                if (!task.IsCompleted) { Thread.Sleep(15); } // (Wait would throw here if the work failed)
            }

            return task.GetAwaiter().GetResult();
        }

        /// <summary>
        /// One frame: title, stage, bar, detail and the CANCEL button.
        /// </summary>
        /// <returns>True if CANCEL was clicked.</returns>
        private static bool Draw(GameWindow window, UiBatch ui, string title, OperationProgress progress, InputState input, ref bool hover)
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
            Gl.Viewport(0, 0, window.Width, window.Height);
            Gl.ClearColor(0.063f, 0.075f, 0.094f, 1f);
            Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);

            float s = window.DpiScale;
            FontAtlas f = ui.Atlas;
            float cx = window.Width * 0.5f, cy = window.Height * 0.5f;
            progress.Read(out string stage, out string detail, out double fraction);

            ui.TextCentred(f.Title, cx, cy - 96f * s, "BIMGO", UiTheme.TEXT, 4f * s);
            ui.TextCentred(f.Bold, cx, cy - 28f * s, title, UiTheme.TEXT, 0.5f * s);
            ui.TextCentred(f.Body, cx, cy + 2f * s, progress.CancelRequested ? "Cancelling…" : string.IsNullOrEmpty(stage) ? "Working…" : stage, UiTheme.TEXT_MUTED);

            // Bar
            float barW = MathF.Min(420f * s, window.Width - 80f * s), barH = 8f * s;
            float barX = cx - barW * 0.5f, barY = cy + 32f * s;
            ui.Rect(barX, barY, barW, barH, UiTheme.CONTROL);
            ui.Rect(barX, barY, barW * (float)Math.Clamp(fraction, 0.0, 1.0), barH, UiTheme.ACCENT);
            if (!string.IsNullOrEmpty(detail)) { ui.TextCentred(f.Small, cx, barY + barH + 10f * s, detail, UiTheme.TEXT_FAINT, 0.4f * s); }

            // CANCEL (Esc)
            bool clicked = false;
            if (progress.CanCancel && !progress.CancelRequested)
            {
                float bw = 150f * s, bh = 34f * s;
                float bx = cx - bw * 0.5f, by = barY + 52f * s;
                hover = input.MousePosition.X >= bx && input.MousePosition.X < bx + bw && input.MousePosition.Y >= by && input.MousePosition.Y < by + bh;
                ui.Panel(bx, by, bw, bh, hover ? UiTheme.CONTROL_BORDER : UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
                ui.TextCentred(f.Body, cx, by + bh * 0.5f - f.Body.LineHeight * 0.5f, "CANCEL  (ESC)", UiTheme.TEXT);
                clicked = hover && input.LeftPressed;
            }

            ui.Flush(window.Width, window.Height);
            return clicked;
        }
    }
}
