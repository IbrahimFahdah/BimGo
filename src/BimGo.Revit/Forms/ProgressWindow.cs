using System.Threading;
using BimGo.Utilities;
using Media = System.Windows.Media;
using Win = System.Windows;
using Wpf = System.Windows.Controls;

// The class belongs to the Forms namespace
namespace BimGo.Forms
{
    /// <summary>
    /// A small progress window with a Cancel button for long Revit-side work (extraction, writing snapshots and
    /// exports). The work runs on the Revit API thread, which can't pump a window, so the window lives on its own STA
    /// thread and polls the shared <see cref="OperationProgress"/> ten times a second. It appears only if the work takes
    /// longer than half a second. Dispose closes it.
    /// </summary>
    internal sealed class ProgressWindow : IDisposable
    {
        private const int SHOW_DELAY_MS = 500;

        private readonly OperationProgress _progress;
        private readonly string _title;
        private readonly nint _owner;
        private readonly Thread _thread;
        private Win.Threading.Dispatcher _dispatcher;
        private readonly ManualResetEventSlim _ready = new(false);

        /// <summary>
        /// Starts the window's thread (the window shows itself after a short delay).
        /// </summary>
        /// <param name="title">What is being done ("Extracting Tower A for BimGo").</param>
        /// <param name="progress">The shared progress.</param>
        /// <param name="owner">Revit's main window handle (the window is centred over it), or 0.</param>
        private ProgressWindow(string title, OperationProgress progress, nint owner)
        {
            _title = title;
            _progress = progress;
            _owner = owner;
            _thread = new Thread(Run) { IsBackground = true, Name = "BimGo progress" };
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
            _ready.Wait(2000);
        }

        /// <summary>
        /// Shows progress for a task (never throws: without a window the task simply runs without one).
        /// </summary>
        public static ProgressWindow Show(string title, OperationProgress progress, nint owner)
        {
            try
            {
                return new ProgressWindow(title, progress, owner);
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"Progress window unavailable: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// The window thread: builds the window, polls the progress, shows after the delay.
        /// </summary>
        private void Run()
        {
            try
            {
                _dispatcher = Win.Threading.Dispatcher.CurrentDispatcher;

                var stage = new Wpf.TextBlock { FontSize = 14, FontWeight = Win.FontWeights.SemiBold, Text = "Starting…", TextTrimming = Win.TextTrimming.CharacterEllipsis };
                var detail = new Wpf.TextBlock { FontSize = 12, Foreground = new Media.SolidColorBrush(Media.Color.FromRgb(0x4B, 0x55, 0x60)), Margin = new Win.Thickness(0, 4, 0, 10), Text = " " };
                var bar = new Wpf.ProgressBar { Height = 14, Minimum = 0, Maximum = 1000, Foreground = new Media.SolidColorBrush(Media.Color.FromRgb(0x0E, 0x74, 0x90)) };
                var cancel = new Wpf.Button { Content = "Cancel", Width = 96, Height = 30, Margin = new Win.Thickness(0, 14, 0, 0), HorizontalAlignment = Win.HorizontalAlignment.Right };

                var panel = new Wpf.StackPanel { Margin = new Win.Thickness(20, 18, 20, 16) };
                panel.Children.Add(stage);
                panel.Children.Add(detail);
                panel.Children.Add(bar);
                panel.Children.Add(cancel);

                var window = new Win.Window
                {
                    Title = "BimGo — " + _title,
                    Width = 440,
                    SizeToContent = Win.SizeToContent.Height,
                    ResizeMode = Win.ResizeMode.NoResize,
                    WindowStartupLocation = Win.WindowStartupLocation.Manual,
                    ShowInTaskbar = true,
                    ShowActivated = true,
                    Topmost = true,
                    FontFamily = new Media.FontFamily("Segoe UI"),
                    Background = new Media.SolidColorBrush(Media.Color.FromRgb(0xF6, 0xF7, 0xF8)),
                    Content = panel
                };
                // Not owned by Revit's window on purpose: an owner on another (busy) thread would share its input
                // queue and freeze the Cancel button. Centre it over Revit instead.
                window.Loaded += (_, _) => CentreOver(window, _owner);

                cancel.Click += (_, _) =>
                {
                    _progress.Cancel();
                    cancel.IsEnabled = false;
                    cancel.Content = "Cancelling…";
                };
                // Closing the window with its X is a cancel too (the work closes it when it stops)
                window.Closing += (_, e) =>
                {
                    if (_closing) { return; }
                    e.Cancel = true;
                    _progress.Cancel();
                    cancel.IsEnabled = false;
                    cancel.Content = "Cancelling…";
                };

                DateTime started = DateTime.UtcNow;
                var timer = new Win.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
                timer.Tick += (_, _) =>
                {
                    _progress.Read(out string stageText, out string detailText, out double fraction);
                    stage.Text = string.IsNullOrEmpty(stageText) ? "Working…" : stageText;
                    detail.Text = string.IsNullOrEmpty(detailText) ? " " : detailText;
                    bar.Value = Math.Clamp(fraction, 0.0, 1.0) * 1000.0;
                    if (!_progress.CanCancel && !_progress.CancelRequested) { cancel.IsEnabled = false; }
                    if (!window.IsVisible && (DateTime.UtcNow - started).TotalMilliseconds >= SHOW_DELAY_MS) { window.Show(); }
                };
                timer.Start();

                _ready.Set();
                Win.Threading.Dispatcher.Run();
                timer.Stop();
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"Progress window failed: {ex.Message}");
                _ready.Set();
            }
        }

        private volatile bool _closing;
        private bool _disposed;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool GetWindowRect(nint hWnd, out Rect rect);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct Rect { public int Left, Top, Right, Bottom; }

        /// <summary>
        /// Centres the window over Revit's main window (else the primary screen).
        /// </summary>
        private static void CentreOver(Win.Window window, nint owner)
        {
            try
            {
                var source = Win.PresentationSource.FromVisual(window);
                double scaleX = source?.CompositionTarget?.TransformToDevice.M11 ?? 1.0;
                double scaleY = source?.CompositionTarget?.TransformToDevice.M22 ?? 1.0;
                if (owner != 0 && GetWindowRect(owner, out Rect r) && r.Right > r.Left)
                {
                    window.Left = (r.Left + r.Right) / 2.0 / scaleX - window.ActualWidth / 2.0;
                    window.Top = (r.Top + r.Bottom) / 2.0 / scaleY - window.ActualHeight / 2.0;
                    return;
                }
                window.Left = (Win.SystemParameters.PrimaryScreenWidth - window.ActualWidth) / 2.0;
                window.Top = (Win.SystemParameters.PrimaryScreenHeight - window.ActualHeight) / 2.0;
            }
            catch
            {
                // Leave it where Windows put it
            }
        }

        /// <summary>
        /// Closes the window and ends its thread.
        /// </summary>
        public void Dispose()
        {
            if (_disposed) { return; }
            _disposed = true;
            try
            {
                _closing = true;
                _dispatcher?.InvokeShutdown();
                _thread.Join(2000);
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"Progress window close failed: {ex.Message}");
            }
            _ready.Dispose();
        }
    }
}
