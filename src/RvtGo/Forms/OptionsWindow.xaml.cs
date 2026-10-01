using System.Globalization;
using RvtGo.Scene;
using Media = System.Windows.Media;
using Win = System.Windows;
using Wpf = System.Windows.Controls;

// The class belongs to the Forms namespace
namespace RvtGo.Forms
{
    /// <summary>
    /// The modal launch-options dialog (WPF). Edits a <see cref="LaunchSettings"/> in place.
    ///
    /// Note: the project enables both WPF and WinForms, so WinForms types are in the global usings.
    /// WPF types are referenced through the Wpf/Win/Media aliases to avoid ambiguous names
    /// (CheckBox, Orientation, Brushes...).
    /// </summary>
    public partial class OptionsWindow : Win.Window
    {
        #region Fields

        private static readonly string[] GROUP_DESCRIPTIONS =
        {
            "Walls, floors, ceilings, roofs, doors, windows, curtain walls, stairs, structure",
            "Casework, furniture, generic models, plumbing fixtures, railings, specialty",
            "Lighting, electrical, mechanical, fire alarm, security, sprinklers"
        };

        private readonly LaunchSettings _settings;
        private readonly int[] _counts;
        private readonly Wpf.CheckBox[] _groupChecks = new Wpf.CheckBox[3];
        private readonly Dictionary<string, Wpf.CheckBox> _categoryChecks = new();
        private bool _updating;

        #endregion

        /// <summary>
        /// Creates the dialog.
        /// </summary>
        /// <param name="settings">Settings to edit (written back on Launch).</param>
        /// <param name="spawnDescription">Where the player will start.</param>
        /// <param name="counts">Element count per catalog definition.</param>
        internal OptionsWindow(LaunchSettings settings, string spawnDescription, int[] counts)
        {
            _settings = settings;
            _counts = counts;

            InitializeComponent();

            RunSpawn.Text = spawnDescription;
            BuildCategoryCards();
            LoadFromSettings();
            UpdateEstimate();
        }

        #region Build

        /// <summary>
        /// Builds one card per group with a group tick box and an expandable per-category list.
        /// </summary>
        private void BuildCategoryCards()
        {
            for (int g = 0; g < 3; g++)
            {
                var group = (CategoryGroup)g;
                List<CategoryDef> defs = CategoryCatalog.All.Where(d => d.Group == group && !d.Heavy).ToList();

                var card = new Wpf.Border
                {
                    Style = (Win.Style)FindResource("Card"),
                    Margin = new Win.Thickness(5, 0, 5, 0)
                };
                var stack = new Wpf.StackPanel();
                card.Child = stack;

                var groupCheck = new Wpf.CheckBox
                {
                    Content = CategoryCatalog.GROUP_NAMES[g],
                    FontWeight = Win.FontWeights.SemiBold,
                    Tag = group
                };
                groupCheck.Click += GroupCheck_Click;
                _groupChecks[g] = groupCheck;
                stack.Children.Add(groupCheck);

                stack.Children.Add(new Wpf.TextBlock
                {
                    Text = GROUP_DESCRIPTIONS[g],
                    TextWrapping = Win.TextWrapping.Wrap,
                    FontSize = 12,
                    Foreground = (Media.Brush)FindResource("Muted"),
                    Margin = new Win.Thickness(0, 6, 0, 6)
                });

                var list = new Wpf.StackPanel { Margin = new Win.Thickness(0, 4, 0, 0) };
                foreach (CategoryDef def in defs)
                {
                    var check = new Wpf.CheckBox
                    {
                        Content = $"{def.Label} ({_counts[def.Index]:N0})",
                        Tag = def.Key,
                        Margin = new Win.Thickness(0, 2, 0, 2),
                        FontSize = 12
                    };
                    check.Checked += AnyCategory_Changed;
                    check.Unchecked += AnyCategory_Changed;
                    _categoryChecks[def.Key] = check;
                    list.Children.Add(check);
                }

                stack.Children.Add(new Wpf.Expander
                {
                    Header = $"Edit categories ({defs.Count})",
                    Foreground = (Media.Brush)FindResource("Accent"),
                    FontSize = 12,
                    Content = list
                });

                GridGroups.Children.Add(card);
            }

            // Heavy categories have no individual tick boxes; CheckHeavy drives them all
            int heavyCount = CategoryCatalog.All.Where(d => d.Heavy).Sum(d => _counts[d.Index]);
            CheckHeavy.Content = $"Include ducts, pipes, cable trays and conduits (heavy, {heavyCount:N0})";
        }

        /// <summary>
        /// Pushes settings into the controls.
        /// </summary>
        private void LoadFromSettings()
        {
            _updating = true;

            var enabled = new HashSet<string>(_settings.EnabledCategories);
            foreach (KeyValuePair<string, Wpf.CheckBox> pair in _categoryChecks)
            {
                pair.Value.IsChecked = enabled.Contains(pair.Key);
            }
            CheckHeavy.IsChecked = CategoryCatalog.All.Any(d => d.Heavy && enabled.Contains(d.Key));

            TextThreshold.Text = _settings.TriangleThreshold.ToString(CultureInfo.InvariantCulture);
            RadioProxy.IsChecked = _settings.OverLimit == OverLimitMode.Proxy;
            RadioSkip.IsChecked = _settings.OverLimit == OverLimitMode.Skip;
            RadioWhitecard.IsChecked = _settings.Colour == ColourMode.Whitecard;
            RadioMaterial.IsChecked = _settings.Colour == ColourMode.Material;
            TextStep.Text = _settings.MaxStepHeightMm.ToString("0", CultureInfo.InvariantCulture);

            ComboMsaa.SelectedIndex = _settings.Msaa >= 4 ? 2 : _settings.Msaa >= 2 ? 1 : 0;
            SliderFov.Value = _settings.FieldOfView;
            SliderSensitivity.Value = _settings.MouseSensitivity;
            CheckInvertY.IsChecked = _settings.InvertY;
            CheckVSync.IsChecked = _settings.VSync;
            CheckComments.IsChecked = _settings.LoadComments;

            _updating = false;
            RefreshGroupChecks();
            UpdateSliderLabels();
        }

        #endregion

        #region Events

        /// <summary>
        /// A group tick box sets or clears all of its categories.
        /// </summary>
        private void GroupCheck_Click(object sender, Win.RoutedEventArgs e)
        {
            if (sender is not Wpf.CheckBox groupCheck || groupCheck.Tag is not CategoryGroup group) { return; }

            // Clicking an indeterminate box resolves to "all on"
            bool on = groupCheck.IsChecked != false;
            _updating = true;
            foreach (CategoryDef def in CategoryCatalog.All.Where(d => d.Group == group && !d.Heavy))
            {
                _categoryChecks[def.Key].IsChecked = on;
            }
            _updating = false;

            RefreshGroupChecks();
            UpdateEstimate();
        }

        /// <summary>
        /// Any category tick box changed.
        /// </summary>
        private void AnyCategory_Changed(object sender, Win.RoutedEventArgs e)
        {
            if (_updating) { return; }
            RefreshGroupChecks();
            UpdateEstimate();
        }

        /// <summary>
        /// Slider changed (fires during InitializeComponent too, hence the null guard).
        /// </summary>
        private void Slider_ValueChanged(object sender, Win.RoutedPropertyChangedEventArgs<double> e)
        {
            UpdateSliderLabels();
        }

        /// <summary>
        /// Validates and writes the settings back, then closes.
        /// </summary>
        private void ButtonLaunch_Click(object sender, Win.RoutedEventArgs e)
        {
            if (!int.TryParse(TextThreshold.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int threshold) || threshold < 100)
            {
                Win.MessageBox.Show(this, "Triangle limit must be a whole number of at least 100.", "RvtGo", Win.MessageBoxButton.OK, Win.MessageBoxImage.Warning);
                TextThreshold.Focus();
                return;
            }
            if (!float.TryParse(TextStep.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out float step) || step < 50f || step > 450f)
            {
                Win.MessageBox.Show(this, "Max step height must be between 50 and 450 mm.", "RvtGo", Win.MessageBoxButton.OK, Win.MessageBoxImage.Warning);
                TextStep.Focus();
                return;
            }

            List<string> enabled = SelectedKeys();
            if (enabled.Count == 0)
            {
                Win.MessageBox.Show(this, "Tick at least one category to load.", "RvtGo", Win.MessageBoxButton.OK, Win.MessageBoxImage.Warning);
                return;
            }

            _settings.EnabledCategories = enabled;
            _settings.TriangleThreshold = threshold;
            _settings.OverLimit = RadioSkip.IsChecked == true ? OverLimitMode.Skip : OverLimitMode.Proxy;
            _settings.Colour = RadioMaterial.IsChecked == true ? ColourMode.Material : ColourMode.Whitecard;
            _settings.MaxStepHeightMm = step;
            _settings.Msaa = ComboMsaa.SelectedIndex switch { 2 => 4, 1 => 2, _ => 0 };
            _settings.FieldOfView = (float)SliderFov.Value;
            _settings.MouseSensitivity = (float)SliderSensitivity.Value;
            _settings.InvertY = CheckInvertY.IsChecked == true;
            _settings.VSync = CheckVSync.IsChecked == true;
            _settings.LoadComments = CheckComments.IsChecked == true;
            _settings.Sanitise();

            DialogResult = true;
        }

        /// <summary>
        /// Cancel.
        /// </summary>
        private void ButtonCancel_Click(object sender, Win.RoutedEventArgs e)
        {
            DialogResult = false;
        }

        #endregion

        #region Helpers

        /// <summary>
        /// The ticked category keys (including the heavy set if ticked).
        /// </summary>
        private List<string> SelectedKeys()
        {
            var keys = _categoryChecks.Where(p => p.Value.IsChecked == true).Select(p => p.Key).ToList();
            if (CheckHeavy.IsChecked == true)
            {
                keys.AddRange(CategoryCatalog.All.Where(d => d.Heavy).Select(d => d.Key));
            }
            return keys;
        }

        /// <summary>
        /// Sets each group box to on / off / indeterminate from its categories.
        /// </summary>
        private void RefreshGroupChecks()
        {
            _updating = true;
            for (int g = 0; g < 3; g++)
            {
                var defs = CategoryCatalog.All.Where(d => (int)d.Group == g && !d.Heavy).ToList();
                int on = defs.Count(d => _categoryChecks[d.Key].IsChecked == true);
                _groupChecks[g].IsChecked = on == 0 ? false : on == defs.Count ? true : (bool?)null;
            }
            _updating = false;
        }

        /// <summary>
        /// Updates the footer estimate.
        /// </summary>
        private void UpdateEstimate()
        {
            int total = 0;
            foreach (string key in SelectedKeys())
            {
                if (CategoryCatalog.Find(key) is CategoryDef def) { total += _counts[def.Index]; }
            }
            TextEstimate.Text = $"Est. {total:N0} elements";
        }

        /// <summary>
        /// Updates the FOV and sensitivity readouts.
        /// </summary>
        private void UpdateSliderLabels()
        {
            if (TextFov == null || TextSensitivity == null) { return; }
            TextFov.Text = $"{SliderFov.Value:0}°";
            TextSensitivity.Text = SliderSensitivity.Value.ToString("0.00", CultureInfo.InvariantCulture);
        }

        #endregion
    }
}
