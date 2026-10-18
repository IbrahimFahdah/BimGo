using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Sky round: cloud cover / drift and the sun disc's size / glare in <see cref="SunSettings"/>, the grass keywords,
    /// and the new default bindings (clash mode on the gamepad, the options preview).
    /// </summary>
    [TestClass]
    public sealed class SkyTests
    {
        [TestMethod]
        public void SunSettings_SkyLookDefaultsCleanAndCopy()
        {
            var sun = new SunSettings();
            Assert.AreEqual(0f, sun.CloudCover);
            Assert.AreEqual(1f, sun.CloudSpeed);
            Assert.AreEqual(1f, sun.SunSize);
            Assert.AreEqual(1f, sun.SunGlare);

            var bad = new SunSettings { CloudCover = 3f, CloudSpeed = -1f, SunSize = 0.05f, SunGlare = float.NaN }.Clean();
            Assert.AreEqual(1f, bad.CloudCover);
            Assert.AreEqual(0f, bad.CloudSpeed);
            Assert.AreEqual(SunSettings.MIN_SUN_SIZE, bad.SunSize);
            Assert.AreEqual(1f, bad.SunGlare, "not a number falls back to the default");

            var copy = new SunSettings { CloudCover = 0.4f, CloudSpeed = 1.5f, SunSize = 0.5f, SunGlare = 0.25f }.Copy();
            Assert.AreEqual(0.4f, copy.CloudCover);
            Assert.AreEqual(1.5f, copy.CloudSpeed);
            Assert.AreEqual(0.5f, copy.SunSize);
            Assert.AreEqual(0.25f, copy.SunGlare);
        }

        [TestMethod]
        public void Settings_GrassKeywordsDefaultAndClean()
        {
            CollectionAssert.AreEqual(new[] { "grass", "lawn", "turf" }, new LaunchSettings().GrassKeywords);
            var settings = new LaunchSettings { GrassKeywords = null };
            settings.Sanitise();
            CollectionAssert.AreEqual(new[] { "grass", "lawn", "turf" }, settings.GrassKeywords);
            settings.GrassKeywords = new() { " Meadow ", "meadow", "" };
            settings.Sanitise();
            CollectionAssert.AreEqual(new[] { "Meadow" }, settings.GrassKeywords);
        }

        [TestMethod]
        public void Bindings_ClashPadAndPreviewDefaults()
        {
            var map = new KeyMap();
            Assert.AreEqual(KeyChord.Parse("PadUp"), map.PadChord(InputAction.ClashView));
            Assert.AreEqual(KeyChord.Parse("PadDown"), map.PadChord(InputAction.ClashSectionToggle));
            Assert.AreEqual(KeyChord.Parse("PadRB+PadX"), map.PadChord(InputAction.ClashSelectAll));
            Assert.AreEqual(KeyChord.Parse("PadBack"), map.PadChord(InputAction.ClashPictures));
            Assert.AreEqual(KeyChord.Parse("PadRB+PadB"), map.PadChord(InputAction.Unarmed));
            Assert.AreEqual(KeyChord.Parse("P"), map.Primary(InputAction.ClashPictures));
            Assert.AreEqual(KeyChord.Parse("Tab"), map.Primary(InputAction.MenuPreview));
            Assert.AreEqual(KeyChord.Parse("PadY"), map.PadChord(InputAction.MenuPreview));
            Assert.AreEqual(0, map.AllClashes().Count);
        }
    }
}
